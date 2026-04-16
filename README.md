# Freebuff Bridge

本项目在本地暴露一个兼容 Anthropic/OpenAI 协议的桥接服务，供 Claude Code 及其他客户端使用。

同时内置一个本地浏览器控制台，访问地址 `http://127.0.0.1:8765/`，功能包括：

- 查看登录状态与账号信息
- 发起官方 Freebuff 登录流程
- 运行时切换模型与 Agent 配置
- 查看当前活跃的桥接会话
- 查看每次请求的 Token 用量记录

桥接服务不再通过 `tmux` 驱动 `freebuff` CLI，改为：

- 从 `~/.config/manicode/credentials.json` 或环境变量 `CODEBUFF_API_KEY` 读取官方凭证
- 为每个桥接会话创建官方 Codebuff `agent-runs`
- 直接调用官方接口 `https://www.codebuff.com/api/v1/chat/completions`
- 在 Claude/Anthropic 的 `tool_use`/`tool_result` 与 OpenAI 兼容格式 `tool_calls`/`tool` 消息之间进行双向翻译
- 在内存中维护每个会话的 Run 元数据

## 接口列表

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

## 环境要求

- Node.js 18+
- 有效的 Freebuff/Codebuff 认证 Token，来源之一：
  - 已通过官方 CLI/网页登录保存在 `~/.config/manicode/credentials.json`
  - 或通过环境变量 `CODEBUFF_API_KEY` 提供

## 安装

```bash
npm install
```

## 启动

```bash
npm start
```

服务默认监听 `127.0.0.1:8765`。

打开控制台：

```bash
open http://127.0.0.1:8765/
```

## 环境变量

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

## 接入 Claude Code

将 Claude Code 指向本地桥接服务：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8765
export ANTHROPIC_API_KEY=dummy
```

然后指定模型 `freebuff-bridge`。

**完整接入步骤：**

1. 启动桥接服务

```bash
npm start
```

2. 配置环境变量

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8765
export ANTHROPIC_API_KEY=dummy
```

3. 指定模型启动 Claude Code

```bash
claude --model freebuff-bridge
```

4. 持久化配置（写入 `~/.claude/settings.json`）

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8765",
    "ANTHROPIC_API_KEY": "dummy"
  },
  "model": "freebuff-bridge"
}
```

5. 验证登录状态

```bash
curl http://127.0.0.1:8765/health
```

返回中 `authenticated` 为 `true` 即表示桥接已就绪。

## 登录

如果本地尚无已保存的凭证，发起官方登录流程：

```bash
curl http://127.0.0.1:8765/v1/freebuff/login \
  -H 'Content-Type: application/json' \
  -d '{ "reset": true }'
```

返回 `loginUrl`，在浏览器中打开并完成登录，然后轮询状态：

```bash
curl "http://127.0.0.1:8765/v1/freebuff/login/status?session=login"
```

登录成功后，凭证会自动保存至 `~/.config/manicode/credentials.json`。

也可以直接通过控制台页面完成上述操作。

## 控制台

控制台挂载在 `/`，用于本地管理，包含：

- 账号状态与邮箱信息
- 登录按钮（生成官方 Freebuff 登录链接）
- 登出按钮（清除本地凭证）
- Claude Code 接入教程
- Claude Code 协议兼容状态
- 运行时配置（模型别名、Agent ID、后端模型）
- 用量汇总卡片与逐请求 Token 历史
- 活跃会话列表及重置按钮

当前支持的 Free 模式后端模型：

- `z-ai/glm-5.1`
- `minimax/minimax-m2.7`

## 会话状态

查看桥接认证状态与各会话详情：

```bash
curl http://127.0.0.1:8765/v1/freebuff/status
```

关键响应字段：

- `authenticated`：当前是否持有有效凭证
- `exists`：该会话是否已在内存中创建
- `hasRunState`：该会话是否已有 Codebuff `RunState`
- `turns`：该会话已完成的对话轮次
- `codebuffMetadata`：该会话的模拟元数据（`client_id`、`run_id`、`cost_mode`、`n`）
- `usageSummary`：聚合 Token/请求计数
- `compatibility`：原生工具 / MCP / 插件工具兼容状态

## 请求示例

**Anthropic 格式：**

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

**OpenAI 兼容格式：**

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

## 重置会话

```bash
curl http://127.0.0.1:8765/v1/freebuff/reset \
  -H 'Content-Type: application/json' \
  -d '{ "session": "demo" }'
```

## 注意事项

- 同一桥接会话的请求会串行处理。
- 对话状态保存在桥接管理的 `run_id + transcript` 元数据中，与终端会话无关。
- Anthropic 流式响应由翻译后的 Codebuff/OpenAI 响应驱动。
- 桥接内部模拟 `codebuff_metadata`，Claude Code 无需主动传递。
- 运行时修改配置会清除内存中的桥接会话，避免新模型/Agent 与旧 `RunState` 混用。
- 用量记录仅保存在内存中，重启后清空。
- `costMode` 固定为 `free`，不提供其他模式切换。
