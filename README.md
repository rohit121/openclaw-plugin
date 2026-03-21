# AgentDog Plugin for OpenClaw

[![npm version](https://badge.fury.io/js/@agentdog%2Fopenclaw.svg)](https://www.npmjs.com/package/@agentdog/openclaw)

Monitor your [OpenClaw](https://openclaw.ai) agents with [AgentDog](https://agentdog.io) — real-time observability and per-tool permission controls.

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
```

**4. Restart your agent** — done! Check the [dashboard](https://agentdog.io).

---

## What it tracks

| Category | Details |
|----------|---------|
| Config | Channels, plugins, skills, crons |
| Messages | Role, channel, model |
| Tool calls | Name, arguments, duration, success/error |
| Usage & costs | Tokens, cost per turn |

No secrets or sensitive message content are ever sent.

---

## Permission controls (optional)

Allow, block, or require manual approval before any tool runs. Useful when you want to prevent agents from sending emails, deleting files, or making purchases without your consent.

**Enable in `openclaw.yaml`:**
```yaml
extensions:
  agentdog:
    apiKey: YOUR_API_KEY
    permissionsEnabled: true
```

**Configure rules in the [AgentDog dashboard](https://agentdog.io/permissions):**

- **Allow** — tool runs freely (default for unmatched tools)
- **Block** — tool is always prevented
- **Ask me** — agent pauses and waits for your approval

Rules support exact names (`send_email`), wildcard suffix (`send_*`), or catch-all (`*`), and can be scoped to a specific agent or applied globally.

### Approval flow

When a tool hits a `require_approval` rule:

1. The agent pauses execution
2. You receive a notification in the same channel where the conversation started (Telegram, Slack, Discord, etc.)
3. Reply **`approve`** or **`deny`** directly in chat — or decide from the [Permissions page](https://agentdog.io/permissions)
4. The agent immediately resumes or stops based on your decision

Approval requests expire after **10 minutes** if not decided.

---

## All config options

```yaml
extensions:
  agentdog:
    apiKey: ad_xxxxxxxxxxxxx        # required
    endpoint: https://agentdog.io/api/v1  # optional, default shown
    syncInterval: 86400             # seconds between config syncs (default: 24 h)
    permissionsEnabled: false       # set true to enforce permission rules
```

---

## Links

- [Dashboard](https://agentdog.io)
- [Permissions](https://agentdog.io/permissions)
- [OpenClaw](https://openclaw.ai)
- [Issues](https://github.com/rohit121/openclaw-plugin/issues)