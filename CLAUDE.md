# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands
- `npm start` — start the bridge server on :8765
- `npm run check` — syntax-check server.js (`node --check`)

## Architecture
Single-file Node.js (ESM) server with zero dependencies beyond Node 18+ stdlib.

- `server.js` — all backend logic (~3300 lines): HTTP server, route handling, Codebuff API proxy, Anthropic↔OpenAI format translation, multi-account rotation, credential management, SSE streaming, session locking, usage tracking
- `public/` — dashboard frontend (index.html + app.js + app.css), served as static files

Key in-memory state: `bridgeSessions` (Map), `loginSessions` (Map), `usageRecords` (Array), `accountRuntimeStats` (Map), `accountRotationCursor` — all lost on restart.

## Protocol Translation
Core purpose: translate between Anthropic Messages API (`tool_use`/`tool_result`) and OpenAI Chat Completions (`tool_calls`/`tool`), forwarding to Codebuff `agent-run` backend. Supports both streaming (SSE) and non-streaming modes.

## Modes
`free/default/lite/max/plan` — each maps to a Codebuff `agentId`. `free` mode uses backend models (`z-ai/glm-5.1`, `minimax/minimax-m2.7`). Mode aliases: `normal→default`, `ask→lite`.

## Credentials
Read from `~/.config/manicode/credentials.json` (multi-account) or `CODEBUFF_API_KEY` env var. Login flow via `/v1/freebuff/login` + `/v1/freebuff/login/status`.