# Freebuff Bridge

This project exposes a local Anthropic/OpenAI-compatible bridge for Claude Code and other clients.

It also includes a local browser dashboard at `http://127.0.0.1:8765/` for:

- viewing login/account state
- starting and checking the official Freebuff login flow
- changing runtime model and agent settings
- viewing active bridge sessions
- tracking token usage records per request

It no longer drives the `freebuff` CLI through `tmux`. Instead, it:

- reads your official Freebuff/Codebuff credentials from `~/.config/manicode/credentials.json` or `CODEBUFF_API_KEY`
- creates official Codebuff `agent-runs` for each bridge session
- calls the official `https://www.codebuff.com/api/v1/chat/completions` endpoint directly
- translates between Claude/Anthropic `tool_use` / `tool_result` and OpenAI-compatible `tool_calls` / `tool` messages
- keeps local per-session run metadata in memory

## Routes

- `GET /health`
- `GET /`
- `GET /v1/models`
- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/chat/completions`
- `GET /v1/freebuff/admin/overview`
- `GET /v1/freebuff/config`
- `POST /v1/freebuff/config`
- `GET /v1/freebuff/usage`
- `POST /v1/freebuff/usage/reset`
- `GET /v1/freebuff/status`
- `POST /v1/freebuff/login`
- `GET /v1/freebuff/login/status`
- `POST /v1/freebuff/logout`
- `POST /v1/freebuff/reset`

## Requirements

- Node.js 18+
- a valid Freebuff/Codebuff auth token, either:
  - already saved by the official CLI/web login in `~/.config/manicode/credentials.json`
  - or provided as `CODEBUFF_API_KEY`

## Install

```bash
cd /Users/liji/FreeBuff
npm install
```

## Run

```bash
npm start
```

By default the bridge listens on `127.0.0.1:8765`.

Open the dashboard:

```bash
open http://127.0.0.1:8765/
```

## Environment variables

```bash
PORT=8765
HOST=127.0.0.1
FREEBUFF_CWD=/absolute/path/to/project
FREEBUFF_MODEL=freebuff-bridge
FREEBUFF_AGENT_ID=base2-free
FREEBUFF_COST_MODE=free
FREEBUFF_BACKEND_MODEL=z-ai/glm-5.1
FREEBUFF_SESSION_ID=default
FREEBUFF_LOGIN_SESSION_ID=login
FREEBUFF_RESPONSE_TIMEOUT_MS=180000
FREEBUFF_LOGIN_BASE_URL=https://freebuff.com
FREEBUFF_USAGE_HISTORY_LIMIT=500
CODEBUFF_API_KEY=...
```

## Claude Code usage

Point Claude Code at the local bridge:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8765
export ANTHROPIC_API_KEY=dummy
```

Then use model `freebuff-bridge`.

The main Claude Code route is:

- `POST /v1/messages`

The bridge accepts Anthropic-style payloads, translates them into OpenAI-compatible chat completions requests for Codebuff's backend, and returns Anthropic-style responses back to Claude Code.

It now supports:

- normal text replies
- native Claude Code `tool_use` / `tool_result`
- MCP tool definitions passed by Claude Code
- installed plugin tool definitions passed by Claude Code

### Claude Code 接入步骤

1. 启动桥接服务

```bash
cd /Users/liji/FreeBuff
npm start
```

2. 配置 Claude Code 环境变量

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8765
export ANTHROPIC_API_KEY=dummy
```

3. 在 Claude Code 中指定模型

```bash
claude --model freebuff-bridge
```

4. 如果想持久化配置，可把下面内容写进 `~/.claude/settings.json`

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8765",
    "ANTHROPIC_API_KEY": "dummy"
  },
  "model": "freebuff-bridge"
}
```

5. 第一次使用前，确认本桥已登录 Freebuff

```bash
curl http://127.0.0.1:8765/health
```

返回里只要 `authenticated` 是 `true`，Claude Code 就会通过这个桥走 Freebuff 侧能力。

## Login helper

If you do not already have saved credentials, start an official login flow:

```bash
curl http://127.0.0.1:8765/v1/freebuff/login \
  -H 'Content-Type: application/json' \
  -d '{ "reset": true }'
```

That returns a `loginUrl`. Open it in a browser, complete the official login flow, then poll:

```bash
curl "http://127.0.0.1:8765/v1/freebuff/login/status?session=login"
```

On success, the bridge saves the returned credentials into `~/.config/manicode/credentials.json`.

You can also do this from the dashboard.

## Dashboard

The dashboard is served from `/` and is intended for local administration.

It exposes:

- account status and current email
- a login button that generates the official Freebuff login URL
- a logout button that clears local saved credentials
- a built-in “如何接入 Claude Code” 教程
- a Claude Code 协议兼容状态区
- runtime config controls for:
  - Claude-facing model alias
  - agent id
  - backend model
- usage summary cards and per-request token history
- active session list with reset buttons

当前前端只保留 `free` 模式。

当前可切换的 Free 模式后端模型：

- `z-ai/glm-5.1`
- `minimax/minimax-m2.7`

## Session status

Check bridge auth and per-session state:

```bash
curl http://127.0.0.1:8765/v1/freebuff/status
```

Important response fields:

- `authenticated`: whether the bridge currently has usable credentials
- `exists`: whether the bridge session exists in memory
- `hasRunState`: whether a Codebuff `RunState` already exists for that session
- `turns`: completed turns in that bridged session
- `codebuffMetadata`: simulated metadata for that session:
  - `client_id`
  - `run_id`
  - `cost_mode`
  - `n`
- `usageSummary`: aggregate token/request counters
- `compatibility`: 当前原生工具 / MCP / 插件工具兼容状态

## Anthropic example

```bash
curl http://127.0.0.1:8765/v1/messages \
  -H 'Content-Type: application/json' \
  -H 'x-freebuff-session: demo' \
  -H 'anthropic-version: 2023-06-01' \
  -d '{
    "model": "freebuff-bridge",
    "max_tokens": 256,
    "system": "Keep replies concise.",
    "messages": [
      { "role": "user", "content": "Reply with exactly OK." }
    ]
  }'
```

## OpenAI-compatible example

```bash
curl http://127.0.0.1:8765/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'x-freebuff-session: demo' \
  -d '{
    "model": "freebuff-bridge",
    "messages": [
      { "role": "system", "content": "Keep replies concise." },
      { "role": "user", "content": "Reply with exactly OK." }
    ]
  }'
```

## Reset a session

```bash
curl http://127.0.0.1:8765/v1/freebuff/reset \
  -H 'Content-Type: application/json' \
  -d '{ "session": "demo" }'
```

## Notes

- Requests for the same bridge session are serialized.
- Conversation state lives in bridge-managed `run_id + transcript` metadata, not in a terminal session.
- Anthropic streaming is emitted from the translated Codebuff/OpenAI-compatible response.
- The bridge internally simulates `codebuff_metadata`, but Claude Code does not need to send it.
- Runtime config changes clear in-memory bridge sessions so you do not mix old `RunState` with a new model/agent setup.
- Usage records are stored in memory only.
- `costMode` 现在固定为 `free`，不会再暴露 `normal/max/experimental/ask` 给前端切换。
