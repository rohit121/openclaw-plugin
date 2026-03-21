/**
 * AgentDog Plugin for OpenClaw
 *
 * Sends observability data to AgentDog and enforces tool-level permission rules.
 *
 * Features:
 *   - Real-time session, message, tool-call, and usage tracking
 *   - Per-tool permission rules (allow / block / require_approval)
 *   - Approval flow: pauses the agent and notifies the user in the originating channel
 *     (Telegram, Slack, Discord) or via the AgentDog dashboard
 *   - Inline approve/deny via channel reply ("approve" / "deny")
 */

// ─── Plugin state ────────────────────────────────────────────────────────────

let agentId: string | null = null;
let syncIntervalId: ReturnType<typeof setInterval> | null = null;
let gatewayStartTime: Date | null = null;
let errorCount = 0;
let recentErrors: Array<{ time: string; message: string; tool?: string }> = [];
let registrationAttempts = 0;
const MAX_REGISTRATION_ATTEMPTS = 3;

// Trace tracking — maps sessionKey → current traceId
// Traces group related events: user message → tool calls → assistant response
const sessionTraces = new Map<string, string>();

// Pending approvals — maps conversationId → approval metadata
// Used by the inbound_claim hook so users can approve/deny via channel reply
const pendingApprovals = new Map<string, {
  approvalId: string;
  toolName: string;
  expires: number;
}>();

// ─── Utilities ───────────────────────────────────────────────────────────────

function generateTraceId(): string {
  return 'tr_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
}

function getOrCreateTraceId(sessionKey: string | undefined): string {
  const key = sessionKey || 'default';
  let traceId = sessionTraces.get(key);
  if (!traceId) {
    traceId = generateTraceId();
    sessionTraces.set(key, traceId);
  }
  return traceId;
}

function clearTraceId(sessionKey: string | undefined): void {
  const key = sessionKey || 'default';
  sessionTraces.delete(key);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Parse a sessionKey of the form:
 *   agent:<agentId>:<channel>:<chatType>:<peerId>
 * Returns { channel, peerId } or null if the key doesn't match the expected format.
 */
function parseSessionKey(sessionKey: string): { channel: string; peerId: string } | null {
  const parts = sessionKey.split(':');
  if (parts.length < 5 || parts[0] !== 'agent') return null;
  return { channel: parts[2], peerId: parts[parts.length - 1] };
}

/**
 * Extract safe channel info (no tokens/secrets)
 */
function getSafeChannels(channels: Record<string, any> | undefined): Record<string, unknown> {
  if (!channels) return {};
  const safe: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(channels)) {
    if (!config) continue;
    safe[name] = {
      enabled: config.enabled ?? true,
      dmPolicy: config.dmPolicy,
      groupPolicy: config.groupPolicy,
      streamMode: config.streamMode,
    };
  }
  return safe;
}

/**
 * Extract plugin names (no configs/secrets)
 */
function getPluginNames(plugins: Record<string, any> | undefined): string[] {
  if (!plugins?.entries) return [];
  return Object.entries(plugins.entries)
    .filter(([_, config]: [string, any]) => config?.enabled !== false)
    .map(([name]) => name);
}

// ─── API helpers ─────────────────────────────────────────────────────────────

type Logger = {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
};

async function sendToAgentDog(
  endpoint: string,
  apiKey: string,
  path: string,
  data: Record<string, unknown>,
  logger?: Logger,
  method: 'POST' | 'GET' = 'POST',
): Promise<unknown> {
  if (!apiKey) return null;

  try {
    const response = await fetch(`${endpoint}${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: method === 'POST' ? JSON.stringify(data) : undefined,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger?.warn?.(`[agentdog] API error ${response.status}: ${text.substring(0, 200)}`);
      return null;
    }

    return await response.json();
  } catch (error) {
    logger?.error?.(`[agentdog] Request failed: ${String(error)}`);
    return null;
  }
}

// ─── Plugin registration ──────────────────────────────────────────────────────

export default function register(api: any) {
  const cfg = api.pluginConfig || {};

  const apiKey: string = cfg.apiKey || '';
  const endpoint: string = cfg.endpoint || 'https://agentdog.io/api/v1';
  const syncInterval: number = (cfg.syncInterval || 86400) * 1000; // default 24 h
  const permissionsEnabled: boolean = cfg.permissionsEnabled ?? false;

  if (!apiKey) {
    api.logger?.error?.('[agentdog] No API key configured — plugin disabled');
    return;
  }

  if (!apiKey.startsWith('ad_')) {
    api.logger?.error?.('[agentdog] Invalid API key format — must start with "ad_"');
    return;
  }

  api.logger?.info?.('[agentdog] Initializing with endpoint: ' + endpoint);
  if (permissionsEnabled) {
    api.logger?.info?.('[agentdog] Permissions enforcement enabled');
  }

  // ── Agent registration ──────────────────────────────────────────────────

  const registerAgent = async (): Promise<boolean> => {
    if (agentId) return true;

    if (registrationAttempts >= MAX_REGISTRATION_ATTEMPTS) {
      api.logger?.warn?.(`[agentdog] Max registration attempts (${MAX_REGISTRATION_ATTEMPTS}) reached`);
      return false;
    }

    registrationAttempts++;
    api.logger?.info?.(`[agentdog] Registration attempt ${registrationAttempts}/${MAX_REGISTRATION_ATTEMPTS}`);

    const agentName = cfg.agentName || 'openclaw';
    const result = await sendToAgentDog(endpoint, apiKey, '/agents/register', {
      name: agentName,
      type: 'openclaw',
      metadata: { workspace: api.config?.agents?.defaults?.workspace },
    }, api.logger) as { agent_id?: string } | null;

    if (result?.agent_id) {
      agentId = result.agent_id;
      api.logger?.info?.(`[agentdog] ✓ Registered: ${agentId}`);
      return true;
    }

    api.logger?.warn?.('[agentdog] Registration failed — no agent_id returned');
    return false;
  };

  const ensureRegistered = async (): Promise<boolean> => {
    if (agentId) return true;
    return registerAgent();
  };

  // ── Config sync ─────────────────────────────────────────────────────────

  const syncConfig = async () => {
    if (!await ensureRegistered()) return;

    const config = api.config;
    await sendToAgentDog(endpoint, apiKey, `/agents/${agentId}/config`, {
      version: config?.meta?.lastTouchedVersion,
      workspace: config?.agents?.defaults?.workspace,
      channels: getSafeChannels(config?.channels),
      plugins: getPluginNames(config?.plugins),
      gateway: { port: config?.gateway?.port, mode: config?.gateway?.mode },
      agents: {
        model: config?.agents?.defaults?.model,
        thinking: config?.agents?.defaults?.thinking,
        heartbeat: config?.agents?.defaults?.heartbeat,
        compaction: config?.agents?.defaults?.compaction,
      },
      crons: config?.crons?.jobs?.map((job: any) => ({
        id: job.id,
        schedule: job.schedule,
        text: job.text?.substring(0, 100),
        enabled: job.enabled !== false,
      })) || [],
      skills: config?.skills?.available?.map((skill: any) => ({
        name: skill.name,
        description: skill.description,
        location: skill.location,
      })) || [],
      tools: config?.tools?.available || [],
      nodes: config?.nodes?.registered?.map((node: any) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        lastSeen: node.lastSeen,
        status: node.status,
      })) || [],
      gateway_stats: {
        uptime_seconds: gatewayStartTime
          ? Math.floor((Date.now() - gatewayStartTime.getTime()) / 1000)
          : null,
        started_at: gatewayStartTime?.toISOString(),
        error_count: errorCount,
        recent_errors: recentErrors.slice(-10),
      },
      memory: config?.plugins?.entries?.memory
        ? { enabled: true, workspace: config?.agents?.defaults?.workspace }
        : { enabled: false },
    }, api.logger);
  };

  // ── Event helper ────────────────────────────────────────────────────────

  const sendEvent = async (
    type: string,
    sessionKey: string | undefined,
    data: Record<string, unknown>,
  ) => {
    if (!await ensureRegistered()) return;
    await sendToAgentDog(endpoint, apiKey, '/events', {
      agent_id: agentId,
      type,
      session_id: sessionKey,
      timestamp: new Date().toISOString(),
      data,
    }, api.logger);
  };

  // ── Channel notification helper ─────────────────────────────────────────

  /**
   * Send an approval request notification to the originating channel.
   * Falls back silently if the channel is not supported or runtime is unavailable.
   */
  const notifyChannelApproval = async (
    toolName: string,
    params: Record<string, unknown>,
    sessionKey: string | undefined,
  ) => {
    if (!sessionKey) return;
    const parsed = parseSessionKey(sessionKey);
    if (!parsed) return;

    const { channel, peerId } = parsed;

    const argsSummary = Object.keys(params).length > 0
      ? '\n' + JSON.stringify(params, null, 2).slice(0, 300)
      : '';

    const text = [
      `⚠️ *Approval needed*`,
      ``,
      `Your agent wants to run: \`${toolName}\`${argsSummary}`,
      ``,
      `Reply *approve* to allow or *deny* to block.`,
      `Or decide at: https://agentdog.io/permissions`,
    ].join('\n');

    try {
      const runtime = api.runtime;
      if (!runtime?.channel) return;

      if (channel === 'telegram' && runtime.channel.telegram?.sendMessageTelegram) {
        await runtime.channel.telegram.sendMessageTelegram(peerId, text, { cfg: api.config });
      } else if (channel === 'slack' && runtime.channel.slack?.sendMessageSlack) {
        await runtime.channel.slack.sendMessageSlack(peerId, text, { cfg: api.config });
      } else if (channel === 'discord' && runtime.channel.discord?.sendMessageDiscord) {
        await runtime.channel.discord.sendMessageDiscord(peerId, text, { cfg: api.config });
      }
      // Other channels (whatsapp, zalo, etc.) fall through — dashboard-only
    } catch (err) {
      api.logger?.warn?.(`[agentdog] Could not send channel notification: ${String(err)}`);
    }
  };

  // ── Lifecycle events ────────────────────────────────────────────────────

  api.on('gateway_start', async () => {
    api.logger?.info?.('[agentdog] Gateway start');
    gatewayStartTime = new Date();
    errorCount = 0;
    recentErrors = [];
    registrationAttempts = 0;

    await registerAgent();
    await syncConfig();

    if (syncIntervalId) clearInterval(syncIntervalId);
    syncIntervalId = setInterval(() => { syncConfig(); }, syncInterval);
  });

  api.on('heartbeat', async () => {
    if (!agentId) gatewayStartTime = gatewayStartTime || new Date();
    await syncConfig();
  });

  api.on('gateway_stop', async () => {
    api.logger?.info?.('[agentdog] Gateway stopping');
    if (syncIntervalId) {
      clearInterval(syncIntervalId);
      syncIntervalId = null;
    }
  });

  // ── Message tracking ────────────────────────────────────────────────────

  api.on('message_received', async (event: any) => {
    clearTraceId(event.sessionKey);
    const traceId = getOrCreateTraceId(event.sessionKey);
    await sendEvent('message', event.sessionKey, {
      trace_id: traceId,
      role: 'user',
      channel: event.channel,
      content: event.content || '',
      from: event.from || '',
      sender_id: event.metadata?.senderId || '',
      sender_name: event.metadata?.senderName || '',
      sender_username: event.metadata?.senderUsername || '',
      id: event.metadata?.messageId || '',
      thread_id: event.metadata?.threadId || '',
      provider: event.metadata?.provider || '',
      surface: event.metadata?.surface || '',
      event_timestamp: event.timestamp || null,
    });
  });

  api.on('message_sent', async (event: any) => {
    const traceId = getOrCreateTraceId(event.sessionKey);
    await sendEvent('message', event.sessionKey, {
      trace_id: traceId,
      role: 'assistant',
      model: event.model,
      content: event.content || '',
      provider: event.provider || '',
      stop_reason: event.stopReason || '',
      thinking: event.thinking || '',
    });
  });

  // ── Tool tracking ───────────────────────────────────────────────────────

  api.on('after_tool_call', async (event: any) => {
    const traceId = getOrCreateTraceId(event.sessionKey);

    if (event.isError) {
      errorCount++;
      recentErrors.push({
        time: new Date().toISOString(),
        message: event.errorMessage || 'Tool error',
        tool: event.toolName,
      });
      if (recentErrors.length > 10) recentErrors.shift();
    }

    await sendEvent('tool_call', event.sessionKey, {
      trace_id: traceId,
      name: event.toolName,
      is_error: event.isError,
      error_message: event.isError ? event.errorMessage : undefined,
      arguments: event.args || event.arguments || {},
      duration_ms: event.durationMs || event.duration || null,
      tool_call_id: event.toolCallId || event.id || '',
    });
  });

  // ── Permission enforcement ──────────────────────────────────────────────

  /**
   * before_tool_call — enforce permission rules before each tool runs.
   * Returns { block: true, blockReason } to prevent execution,
   * or void/undefined to allow.
   *
   * Only active when permissionsEnabled = true in plugin config.
   */
  api.on('before_tool_call', async (event: any, ctx: any) => {
    if (!permissionsEnabled) return;
    if (!await ensureRegistered()) return; // fail open: allow if not registered

    const toolName: string = event.toolName || ctx.toolName;
    const params: Record<string, unknown> = event.params || {};
    const sessionKey: string | undefined = ctx.sessionKey;

    // 1. Check permission
    const result = await sendToAgentDog(
      endpoint, apiKey,
      `/agents/${agentId}/permissions/check`,
      { tool_name: toolName, arguments: params, session_id: sessionKey },
      api.logger,
    ) as { decision: string; reason?: string; approval_id?: string; poll_interval_ms?: number } | null;

    if (!result) return; // network failure → fail open

    if (result.decision === 'allow') return;

    if (result.decision === 'block') {
      api.logger?.info?.(`[agentdog] Tool blocked: ${toolName} — ${result.reason || 'rule match'}`);
      return { block: true, blockReason: result.reason || `${toolName} is blocked by a permission rule` };
    }

    if (result.decision === 'pending') {
      const approvalId = result.approval_id!;
      const pollIntervalMs = result.poll_interval_ms || 3000;
      const deadline = Date.now() + 11 * 60 * 1000; // 11 min (server expires in 10)

      api.logger?.info?.(`[agentdog] Approval required for ${toolName} (id=${approvalId})`);

      // Store so the inbound_claim hook can resolve it from a channel reply
      const parsed = parseSessionKey(sessionKey || '');
      const approvalKey = parsed?.peerId || sessionKey || approvalId;
      pendingApprovals.set(approvalKey, { approvalId, toolName, expires: deadline });

      // Notify user in originating channel
      await notifyChannelApproval(toolName, params, sessionKey);

      // 2. Poll until decided, expired, or deadline
      try {
        while (Date.now() < deadline) {
          await sleep(pollIntervalMs);

          const poll = await sendToAgentDog(
            endpoint, apiKey,
            `/agents/${agentId}/permissions/check/${approvalId}`,
            {},
            api.logger,
            'GET',
          ) as { status: string; decision_note?: string } | null;

          if (!poll) continue; // transient error — keep polling

          if (poll.status === 'approved') {
            api.logger?.info?.(`[agentdog] ${toolName} approved`);
            pendingApprovals.delete(approvalKey);
            return; // allow
          }

          if (poll.status === 'denied') {
            api.logger?.info?.(`[agentdog] ${toolName} denied`);
            pendingApprovals.delete(approvalKey);
            return { block: true, blockReason: poll.decision_note || `${toolName} was denied` };
          }

          if (poll.status === 'expired') {
            pendingApprovals.delete(approvalKey);
            return { block: true, blockReason: `Approval for ${toolName} timed out` };
          }
          // status === 'pending' → keep waiting
        }
      } finally {
        pendingApprovals.delete(approvalKey);
      }

      return { block: true, blockReason: `Approval for ${toolName} timed out` };
    }
  });

  /**
   * inbound_claim — intercept "approve" / "deny" replies from the user
   * in the originating channel before the agent processes them as a message.
   *
   * Returns { handled: true } to consume the message silently.
   * Only active when permissionsEnabled = true.
   */
  api.on('inbound_claim', async (event: any, ctx: any) => {
    if (!permissionsEnabled) return;
    if (!agentId) return;

    // Try to match a pending approval for this conversation
    const conversationId: string | undefined = ctx.conversationId;
    if (!conversationId) return;

    const pending = pendingApprovals.get(conversationId);
    if (!pending || Date.now() > pending.expires) {
      if (pending) pendingApprovals.delete(conversationId);
      return;
    }

    const content: string = (event.content || '').trim().toLowerCase();
    let decision: string | null = null;

    if (['approve', 'approved', 'yes', 'y', '✅', 'ok'].includes(content)) {
      decision = 'approved';
    } else if (['deny', 'denied', 'no', 'n', '❌', 'block', 'reject'].includes(content)) {
      decision = 'denied';
    }

    if (!decision) return; // not a decision reply — let agent handle it

    api.logger?.info?.(`[agentdog] Inbound ${decision} for approval ${pending.approvalId}`);

    // Decide via agent-facing endpoint (uses API key, no session auth needed)
    await sendToAgentDog(
      endpoint, apiKey,
      `/agents/${agentId}/permissions/check/${pending.approvalId}/decide`,
      { decision, note: `Decided via ${event.channel || 'channel'} reply` },
      api.logger,
    );

    // The before_tool_call polling loop will see the updated status on next poll
    // We do NOT delete from pendingApprovals here — let the polling loop do it
    return { handled: true };
  });

  // ── Usage tracking ──────────────────────────────────────────────────────

  api.on('agent_end', async (event: any) => {
    const traceId = getOrCreateTraceId(event.sessionKey);

    if (event.usage) {
      await sendEvent('usage', event.sessionKey, {
        trace_id: traceId,
        input_tokens: event.usage.input,
        output_tokens: event.usage.output,
        total_tokens: event.usage.totalTokens,
        total_cost: event.usage.cost?.total,
        provider: event.provider,
        model: event.model,
      });
    }

    clearTraceId(event.sessionKey);
  });

  // ── Delayed init ────────────────────────────────────────────────────────
  // Handles cases where gateway_start fired before the plugin was loaded

  setTimeout(async () => {
    if (!agentId) {
      api.logger?.info?.('[agentdog] Delayed init: attempting registration');
      gatewayStartTime = gatewayStartTime || new Date();
      await registerAgent();
      if (agentId) {
        await syncConfig();
        if (!syncIntervalId) {
          syncIntervalId = setInterval(() => { syncConfig(); }, syncInterval);
        }
      }
    }
  }, 5000);

  api.logger?.info?.('[agentdog] Plugin registered, waiting for events');
}

// Plugin metadata
export const id = 'agentdog';
export const name = 'AgentDog';
export const version = '0.8.0';
