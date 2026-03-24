/**
 * AgentDog Plugin for OpenClaw
 *
 * Sends observability data to AgentDog and enforces tool-level permission rules.
 *
 * Features:
 *   - Real-time session, message, tool-call, and usage tracking
 *   - Per-tool permission rules (allow / block / require_approval)
 *   - Non-blocking approval flow with inline buttons (Telegram, Slack, Discord)
 *   - Fallback: text reply ("approve" / "deny") via inbound_claim
 */

// Interactive button namespace — callback_data format: "agentdog-approval:<approvalId>:<decision>"
const INTERACTIVE_NAMESPACE = 'agentdog-approval';
const STOP_NAMESPACE = 'agentdog-stop';

// ─── Plugin state ────────────────────────────────────────────────────────────

let agentId: string | null = null;
let syncIntervalId: ReturnType<typeof setInterval> | null = null;
let gatewayStartTime: Date | null = null;
let errorCount = 0;
let recentErrors: Array<{ time: string; message: string; tool?: string }> = [];
let registrationAttempts = 0;
const MAX_REGISTRATION_ATTEMPTS = 3;

// Trace tracking — maps sessionKey → current traceId
const sessionTraces = new Map<string, string>();

// Session origin tracking — maps sessionKey → { channel, peerId }
// Populated from message_received; used to resolve the originating channel
// when the session key doesn't contain peer info (e.g. "agent:main:main").
const sessionOrigins = new Map<string, { channel: string; peerId: string }>();

// Pending approvals — maps peerId/conversationId → approval metadata
// Used by the inbound_claim hook for text-based approve/deny fallback.
const pendingApprovals = new Map<string, {
  approvalId: string;
  toolName: string;
  expires: number;
}>();

// Emergency stop — maps sessionKey → true when user has hit the stop button.
// Blocks all subsequent tool calls until cleared.
const emergencyStops = new Map<string, { stoppedAt: number }>();

// How long a stop lasts before auto-clearing (5 minutes)
const EMERGENCY_STOP_TTL_MS = 5 * 60 * 1000;

// Tool activity tracker — one status message per agent turn, edited as tools progress.
// Maps sessionKey → { messageRef, steps, startedAt, editFn }
interface ToolStep {
  tool: string;
  summary: string;
  startedAt: number;
  durationMs?: number;
  status: 'running' | 'done' | 'error' | 'blocked';
}

interface ActivityTracker {
  steps: ToolStep[];
  messageRef: unknown;    // Opaque ref for editing the message
  editFn: ((text: string, opts?: any) => Promise<unknown>) | null;
  sessionKey: string;
  turnStartedAt: number;
  slowTimer: ReturnType<typeof setTimeout> | null;  // Delayed send for fast tools
}

const activityTrackers = new Map<string, ActivityTracker>();

// Only show status message if a tool takes longer than this
const SLOW_TOOL_THRESHOLD_MS = 3000;

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
  sessionTraces.delete(sessionKey || 'default');
}

/**
 * Parse a channel-specific session key:
 *   agent:<agentId>:<channel>:<chatType>:<peerId>
 * Returns { channel, peerId } or null for non-channel keys (e.g. "agent:main:main").
 */
function parseSessionKey(sessionKey: string): { channel: string; peerId: string } | null {
  const parts = sessionKey.split(':');
  if (parts.length < 5 || parts[0] !== 'agent') return null;
  return { channel: parts[2], peerId: parts[parts.length - 1] };
}

/**
 * Resolve the originating channel and peer ID for a session.
 * Tries the session key first, then falls back to tracked origins.
 */
function resolveOrigin(sessionKey: string | undefined): { channel: string; peerId: string } | null {
  if (!sessionKey) return null;
  return parseSessionKey(sessionKey) || sessionOrigins.get(sessionKey) || null;
}

/** Extract safe channel info (no tokens/secrets) */
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

/** Extract plugin names (no configs/secrets) */
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
  const syncInterval: number = (cfg.syncInterval || 86400) * 1000;
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

    const result = await sendToAgentDog(endpoint, apiKey, '/agents/register', {
      name: cfg.agentName || 'openclaw',
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
   * Send an approval notification with inline buttons to the originating channel.
   * Falls back silently if the channel is unavailable.
   */
  const notifyChannelApproval = async (
    toolName: string,
    params: Record<string, unknown>,
    approvalId: string,
    sessionKey: string | undefined,
  ) => {
    const origin = resolveOrigin(sessionKey);
    if (!origin) {
      api.logger?.warn?.(`[agentdog] Cannot send approval buttons: no origin for session ${sessionKey}`);
      return;
    }

    const { channel, peerId } = origin;
    const argsSummary = Object.keys(params).length > 0
      ? '\n' + JSON.stringify(params, null, 2).slice(0, 300)
      : '';

    const text = [
      `⚠️ *Approval needed*`,
      ``,
      `Your agent wants to run: \`${toolName}\`${argsSummary}`,
    ].join('\n');

    const buttons = [[
      { text: '✅ Approve', callback_data: `${INTERACTIVE_NAMESPACE}:${approvalId}:approved` },
      { text: '❌ Deny', callback_data: `${INTERACTIVE_NAMESPACE}:${approvalId}:denied` },
    ]];

    try {
      const runtime = api.runtime;
      if (!runtime?.channel) return;

      const senders: Record<string, () => Promise<void>> = {
        telegram: () => runtime.channel.telegram?.sendMessageTelegram(peerId, text, { buttons }),
        slack: () => runtime.channel.slack?.sendMessageSlack(peerId, text, { buttons }),
        discord: () => runtime.channel.discord?.sendMessageDiscord(peerId, text, { buttons }),
      };

      const send = senders[channel];
      if (send) await send();
    } catch (err) {
      api.logger?.warn?.(`[agentdog] Could not send approval buttons: ${String(err)}`);
    }
  };

  // ── Interactive button handler ──────────────────────────────────────────

  /**
   * Handle approve/deny button clicks. Registered for all supported channels.
   * Callback data format: "agentdog-approval:<approvalId>:<decision>"
   */
  const handleApprovalButton = async (event: any) => {
    const payload: string = event.callback?.payload || '';
    const sepIdx = payload.indexOf(':');
    if (sepIdx < 0) return;

    const approvalId = payload.slice(0, sepIdx);
    const decision = payload.slice(sepIdx + 1);
    if (!['approved', 'denied'].includes(decision)) return;

    api.logger?.info?.(`[agentdog] Button ${decision} for approval ${approvalId}`);

    await sendToAgentDog(
      endpoint, apiKey,
      `/agents/${agentId}/permissions/check/${approvalId}/decide`,
      { decision, note: `Decided via inline button (${event.channel || 'unknown'})` },
      api.logger,
    );

    // Update the message to show the decision and remove buttons
    const label = decision === 'approved' ? '✅ Approved' : '❌ Denied';
    try {
      await event.respond?.editMessage?.({
        text: `${event.callback?.messageText ?? '⚠️ Approval needed'}\n\n${label}`,
      });
    } catch {
      try { await event.respond?.clearButtons?.(); } catch {}
    }
  };

  if (permissionsEnabled && api.registerInteractiveHandler) {
    for (const channel of ['telegram', 'slack', 'discord'] as const) {
      api.registerInteractiveHandler({
        namespace: INTERACTIVE_NAMESPACE,
        channel,
        handler: handleApprovalButton,
      });
    }
    api.logger?.info?.('[agentdog] Interactive approval handlers registered');
  }

  // ── Emergency stop button handler ───────────────────────────────────────

  /**
   * Handle stop/resume button clicks.
   * Callback data: "agentdog-stop:stop:<sessionKey>" or "agentdog-stop:resume:<sessionKey>"
   */
  const handleStopButton = async (event: any) => {
    const payload: string = event.callback?.payload || '';
    const sepIdx = payload.indexOf(':');
    if (sepIdx < 0) return;

    const action = payload.slice(0, sepIdx);   // "stop" or "resume"
    const sessionKey = payload.slice(sepIdx + 1) || 'agent:main:main';

    if (action === 'stop') {
      emergencyStops.set(sessionKey, { stoppedAt: Date.now() });
      api.logger?.info?.(`[agentdog] 🛑 Emergency stop activated for ${sessionKey}`);

      try {
        await event.respond?.editMessage?.({
          text: '🛑 *Task aborted*\n\nRemaining steps for this task are cancelled. Send a new message to start a new task.',
          buttons: [[
            { text: '▶️ Resume', callback_data: `${STOP_NAMESPACE}:resume:${sessionKey}` },
          ]],
        });
      } catch {
        try { await event.respond?.clearButtons?.(); } catch {}
      }
    } else if (action === 'resume') {
      emergencyStops.delete(sessionKey);
      api.logger?.info?.(`[agentdog] ▶️ Emergency stop cleared for ${sessionKey}`);

      try {
        await event.respond?.editMessage?.({
          text: '▶️ *Agent resumed*\n\nTool calls are allowed again.',
        });
      } catch {
        try { await event.respond?.clearButtons?.(); } catch {}
      }
    }
  };

  if (api.registerInteractiveHandler) {
    for (const channel of ['telegram', 'slack', 'discord'] as const) {
      api.registerInteractiveHandler({
        namespace: STOP_NAMESPACE,
        channel,
        handler: handleStopButton,
      });
    }
  }

  /**
   * Send a stop button to the user. Called when an approval-blocked tool
   * is detected, giving the user a way to halt the entire session.
   */
  const sendStopButton = async (sessionKey: string | undefined) => {
    const origin = resolveOrigin(sessionKey);
    if (!origin) return;

    const { channel, peerId } = origin;
    const sk = sessionKey || 'agent:main:main';

    const buttons = [[
      { text: '🛑 Abort', callback_data: `${STOP_NAMESPACE}:stop:${sk}` },
    ]];

    try {
      const runtime = api.runtime;
      if (!runtime?.channel) return;

      const senders: Record<string, () => Promise<void>> = {
        telegram: () => runtime.channel.telegram?.sendMessageTelegram(peerId, '🛑 Tap to stop all agent actions:', { buttons }),
        slack: () => runtime.channel.slack?.sendMessageSlack(peerId, '🛑 Tap to stop all agent actions:', { buttons }),
        discord: () => runtime.channel.discord?.sendMessageDiscord(peerId, '🛑 Tap to stop all agent actions:', { buttons }),
      };

      const send = senders[channel];
      if (send) await send();
    } catch {}
  };

  // ── Activity tracker helpers ─────────────────────────────────────────────

  function formatActivityMessage(tracker: ActivityTracker): string {
    const lines: string[] = [];
    for (const step of tracker.steps) {
      const icon = step.status === 'running' ? '⏳'
        : step.status === 'done' ? '✅'
        : step.status === 'error' ? '❌'
        : '⚠️';
      const duration = step.durationMs != null ? ` (${(step.durationMs / 1000).toFixed(1)}s)` : '';
      lines.push(`${icon} \`${step.tool}\` — ${step.summary}${duration}`);
    }

    // Add summary line when turn is complete (nothing running)
    const hasRunning = tracker.steps.some((s) => s.status === 'running');
    if (!hasRunning && tracker.steps.length > 1) {
      const totalMs = tracker.steps.reduce((sum, s) => sum + (s.durationMs || 0), 0);
      const errors = tracker.steps.filter((s) => s.status === 'error').length;
      const errStr = errors > 0 ? ` · ${errors} failed` : '';
      lines.push(`\n📊 ${tracker.steps.length} tools · ${(totalMs / 1000).toFixed(1)}s total${errStr}`);
    }

    return lines.join('\n');
  }

  async function sendOrUpdateActivity(sessionKey: string) {
    const tracker = activityTrackers.get(sessionKey);
    if (!tracker || tracker.steps.length === 0) return;

    const text = formatActivityMessage(tracker);
    const origin = resolveOrigin(sessionKey);
    if (!origin) return;

    const { channel, peerId } = origin;
    const sk = sessionKey || 'agent:main:main';
    const stopButton = [{ text: '🛑 Abort', callback_data: `${STOP_NAMESPACE}:stop:${sk}` }];
    const hasRunning = tracker.steps.some((s) => s.status === 'running');
    const buttons = hasRunning ? [stopButton] : undefined;

    try {
      const runtime = api.runtime;
      if (!runtime?.channel) return;

      // Edit existing message if we have a reference
      if (tracker.messageRef && channel === 'telegram') {
        const ref = tracker.messageRef as { chatId: string; messageId: string };
        await runtime.channel.telegram.conversationActions.editMessage(
          ref.chatId, ref.messageId, text, { buttons },
        );
        return;
      }

      // First time: send new message and capture the reference for future edits
      if (channel === 'telegram' && runtime.channel.telegram?.sendMessageTelegram) {
        const result = await runtime.channel.telegram.sendMessageTelegram(peerId, text, { buttons });
        if (result?.messageId) {
          tracker.messageRef = { chatId: result.chatId || peerId, messageId: result.messageId };
        }
      } else if (channel === 'slack' && runtime.channel.slack?.sendMessageSlack) {
        await runtime.channel.slack.sendMessageSlack(peerId, text, { buttons });
      } else if (channel === 'discord' && runtime.channel.discord?.sendMessageDiscord) {
        await runtime.channel.discord.sendMessageDiscord(peerId, text, { buttons });
      }
    } catch {}
  }

  function getOrCreateTracker(sessionKey: string): ActivityTracker {
    const key = sessionKey || 'agent:main:main';
    let tracker = activityTrackers.get(key);
    if (!tracker) {
      tracker = {
        steps: [],
        messageRef: null,
        editFn: null,
        sessionKey: key,
        turnStartedAt: Date.now(),
        slowTimer: null,
      };
      activityTrackers.set(key, tracker);
    }
    return tracker;
  }

  function summarizeToolCall(toolName: string, params: Record<string, unknown>): string {
    if (toolName === 'exec') {
      const cmd = String(params.command || '').trim();
      return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd || 'command';
    }
    if (toolName === 'read' || toolName === 'write') {
      return String(params.path || params.file_path || '').split('/').pop() || toolName;
    }
    if (toolName === 'web_search') {
      return String(params.query || '').slice(0, 50) || 'search';
    }
    if (toolName === 'web_fetch') {
      return String(params.url || '').slice(0, 50) || 'fetch';
    }
    return toolName;
  }

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
    // Track originating channel + peer for approval notifications.
    // The main session key ("agent:main:main") doesn't contain peer info,
    // so we store it from the inbound message metadata.
    const senderId = event.metadata?.senderId || event.from;
    const channel = event.channel || event.metadata?.provider || event.metadata?.originatingChannel;
    const sessionKey = event.sessionKey || 'agent:main:main';
    if (channel && senderId) {
      const origin = { channel, peerId: String(senderId) };
      sessionOrigins.set(sessionKey, origin);
      sessionOrigins.set('agent:main:main', origin);
    }

    // Clear abort on new message — abort is per-task, not permanent.
    // New message = new task = clean slate.
    emergencyStops.delete(sessionKey);
    emergencyStops.delete('agent:main:main');

    // Clear activity tracker for new turn
    const prevTracker = activityTrackers.get(sessionKey);
    if (prevTracker?.slowTimer) clearTimeout(prevTracker.slowTimer);
    activityTrackers.delete(sessionKey);
    activityTrackers.delete('agent:main:main');

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

    // Update activity tracker
    const sk = event.sessionKey || 'agent:main:main';
    const tracker = activityTrackers.get(sk);
    if (tracker) {
      // Find the last running step for this tool
      const step = [...tracker.steps].reverse().find(
        (s) => s.tool === event.toolName && s.status === 'running'
      );
      if (step) {
        step.status = event.isError ? 'error' : 'done';
        step.durationMs = event.durationMs || event.duration || (Date.now() - step.startedAt);
      }

      // If the status message was already sent (slow timer fired), update it
      if (!tracker.slowTimer) {
        sendOrUpdateActivity(sk).catch(() => {});
      }
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
   *
   * - allow: tool runs normally
   * - block: tool is rejected with reason
   * - pending (require_approval): sends inline buttons, blocks immediately.
   *   The agent can continue chatting; user approves via buttons and asks
   *   the agent to retry.
   */
  api.on('before_tool_call', async (event: any, ctx: any) => {
    // Check emergency stop first (even if permissions are disabled)
    const sessionKey: string | undefined = ctx.sessionKey;
    const stop = emergencyStops.get(sessionKey || 'agent:main:main');
    if (stop) {
      // Auto-expire after TTL
      if (Date.now() - stop.stoppedAt > EMERGENCY_STOP_TTL_MS) {
        emergencyStops.delete(sessionKey || 'agent:main:main');
      } else {
        return { block: true, blockReason: '🛑 Task aborted. The user tapped abort. Stop this task immediately. If they ask something new, proceed normally.' };
      }
    }

    const toolName: string = event.toolName || ctx.toolName;
    const params: Record<string, unknown> = event.params || {};

    // Track this tool call for the activity status message
    const tracker = getOrCreateTracker(sessionKey || 'agent:main:main');
    const step: ToolStep = {
      tool: toolName,
      summary: summarizeToolCall(toolName, params),
      startedAt: Date.now(),
      status: 'running',
    };
    tracker.steps.push(step);

    // Send/update the status message immediately
    sendOrUpdateActivity(sessionKey || 'agent:main:main').catch(() => {});

    if (!permissionsEnabled) return;
    if (!await ensureRegistered()) return;

    const result = await sendToAgentDog(
      endpoint, apiKey,
      `/agents/${agentId}/permissions/check`,
      { tool_name: toolName, arguments: params, session_id: sessionKey },
      api.logger,
    ) as { decision: string; reason?: string; approval_id?: string } | null;

    if (!result) return; // network failure → fail open

    if (result.decision === 'allow') return;

    if (result.decision === 'block') {
      api.logger?.info?.(`[agentdog] Tool blocked: ${toolName} — ${result.reason || 'rule match'}`);
      return { block: true, blockReason: result.reason || `${toolName} is blocked by a permission rule` };
    }

    if (result.decision === 'pending') {
      const approvalId = result.approval_id!;
      api.logger?.info?.(`[agentdog] Approval required for ${toolName} (id=${approvalId})`);

      // Store for text-based fallback via inbound_claim
      const origin = resolveOrigin(sessionKey);
      const approvalKey = origin?.peerId || sessionKey || approvalId;
      pendingApprovals.set(approvalKey, {
        approvalId,
        toolName,
        expires: Date.now() + 10 * 60 * 1000,
      });

      // Send inline buttons (fire-and-forget, non-blocking)
      notifyChannelApproval(toolName, params, approvalId, sessionKey).catch(() => {});

      // Stop button is included in the activity tracker message — no separate send needed.

      return {
        block: true,
        blockReason: `⚠️ Approval required for ${toolName}. I've sent you approve/deny buttons. Once you approve, ask me to try again.`,
      };
    }
  });

  // ── Text-based approval fallback ────────────────────────────────────────

  /**
   * inbound_claim — intercept "approve" / "deny" text replies as a fallback
   * for users who can't use inline buttons.
   */
  api.on('inbound_claim', async (event: any, ctx: any) => {
    if (!permissionsEnabled || !agentId) return;

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

    if (!decision) return;

    api.logger?.info?.(`[agentdog] Text ${decision} for approval ${pending.approvalId}`);

    await sendToAgentDog(
      endpoint, apiKey,
      `/agents/${agentId}/permissions/check/${pending.approvalId}/decide`,
      { decision, note: `Decided via ${event.channel || 'channel'} text reply` },
      api.logger,
    );

    pendingApprovals.delete(conversationId);
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
export const version = '0.10.4';
