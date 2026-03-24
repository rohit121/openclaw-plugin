# AgentDog Plugin for OpenClaw

[![npm version](https://badge.fury.io/js/@agentdog%2Fopenclaw.svg)](https://www.npmjs.com/package/@agentdog/openclaw)

Monitor your [OpenClaw](https://openclaw.ai) agents with [AgentDog](https://agentdog.io) — real-time observability, per-tool permission controls, and human-in-the-loop approval flows.

## Why AgentDog?

AI agents are powerful — but **you need to stay in control**. AgentDog gives you:

- **🔍 See everything** — every message, tool call, and cost in real-time
- **🛡️ Set boundaries** — allow, block, or require approval for any tool
- **✅ Stay in the loop** — approve dangerous actions with one tap, right in chat
- **⏳ Know what's happening** — live activity feed shows every step as it runs
- **🛑 Stop anytime** — one tap halts all agent actions instantly

## Setup

**1. Install**
```bash
npm install -g @agentdog/openclaw
```

**2. Get an API key** at [agentdog.io/settings](https://agentdog.io/settings)

**3. Add to `openclaw.yaml`**
```yaml
extensions:
  agentdog:
    apiKey: YOUR_API_KEY
    permissionsEnabled: true
```

**4. Restart your agent** — done!

---

## Permission Controls

### 🛡️ Tool-Level Rules

Set rules for any tool in the [dashboard](https://agentdog.io/permissions):

- **Allow** — tool runs freely
- **Block** — tool is always prevented
- **Ask me** — agent pauses and sends you approve/deny buttons

Rules support exact names (`send_email`), wildcards (`github.*`), or catch-all (`*`). Scope them per-agent or globally.

**Bulk rule creation:** Select multiple capabilities and set permissions in one click.

### ✅ Inline Approval Buttons

When a tool needs approval:

```
⚠️ Approval needed

Your agent wants to run: exec
  {"command": "git push origin main"}

[✅ Approve]  [❌ Deny]
```

- **Non-blocking** — the agent continues chatting while you decide
- **One-tap** — tap a button, message updates to show your choice
- **Text fallback** — reply `approve` or `deny` if buttons aren't available
- **10-minute expiry** — auto-denies if no response

### 🔍 Smart CLI Mapping

AgentDog automatically maps CLI commands to apps for smarter rules:

| Command | Maps to | Rule matches |
|---------|---------|--------------|
| `git push` | `github.push` | `github.*`, `github.push` |
| `gh pr merge` | `github.pr.merge` | `github.*`, `github.pr.*` |
| `docker run nginx` | `docker.run` | `docker.*`, `docker.run` |
| `kubectl apply` | `kubectl.apply` | `kubectl.*`, `kubectl.apply` |

**Auto-discovery:** Unknown CLI tools are automatically detected and their capabilities populated from public documentation.

---

## In-Chat Observability

### ⏳ Live Activity Feed

Every tool call your agent makes shows up in a **single, auto-updating message** — right in your chat:

```
⏳ exec — git pull origin main...
[🛑 Stop]
```

As the agent works through multiple steps, the message builds up in real-time:

```
✅ exec — git pull origin main (2.1s)
✅ exec — npm run build (12.4s)
⏳ exec — docker-compose up...
[🛑 Stop]
```

When the turn completes, you get a summary:

```
✅ exec — git pull origin main (2.1s)
✅ exec — npm run build (12.4s)
✅ exec — docker-compose up (8.3s)

📊 3 tools · 22.8s total
```

- **One message, always updating** — no spam, no clutter
- **Every step visible** — know exactly what your agent is doing
- **Timing for each step** — spot slow operations instantly
- **Error tracking** — failed steps show ❌ with error counts in the summary

### 🛑 Emergency Stop

The stop button is always there while the agent is working. One tap and:

```
🛑 Agent stopped
All tool calls are blocked until you resume.

[▶️ Resume]
```

- **Blocks all subsequent tool calls** — the agent can't do anything until you say so
- **Resume when ready** — tap ▶️ or just send a new message
- **Auto-expires** after 5 minutes (safety net)
- **No data loss** — conversations and context are preserved

---

## Dashboard Observability

The [AgentDog dashboard](https://agentdog.io) gives you the full picture:

| What's tracked | Details |
|----------------|---------|
| Messages | Role, channel, model, content |
| Tool calls | Name, arguments, duration, success/error |
| Usage & costs | Tokens in/out, cost per turn |
| Config | Channels, plugins, skills, crons |
| Sessions | Full conversation history with replay |

No secrets or API keys are ever sent.

---

## Supported Channels

All features work on:

- **Telegram** ✅
- **Discord** ✅
- **Slack** ✅

Other channels fall back to text-based interactions or the dashboard.

---

## Config Options

```yaml
extensions:
  agentdog:
    apiKey: ad_xxxxxxxxxxxxx        # required
    endpoint: https://agentdog.io/api/v1  # optional
    agentName: my-agent             # optional, shown in dashboard
    syncInterval: 86400             # config sync interval in seconds
    permissionsEnabled: true        # enable permission enforcement
```

---

## Links

- **Dashboard:** [agentdog.io](https://agentdog.io)
- **Permissions:** [agentdog.io/permissions](https://agentdog.io/permissions)
- **OpenClaw:** [openclaw.ai](https://openclaw.ai)
- **Issues:** [GitHub](https://github.com/rohit121/openclaw-plugin/issues)

---

Built with 🐕 by [AgentDog](https://agentdog.io)
