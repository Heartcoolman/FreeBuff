# Freebuff Bridge

本地 Anthropic/OpenAI 兼容桥接服务，将 Claude Code 及其他客户端的请求转发至 Freebuff/Codebuff 官方后端，免费使用 AI 编程能力。

## 本次更新（2026-04）

这次更新的目标是两件事：**让应用重新可用**，以及**把控制台整理成更稳定、可维护的后台界面**。

### 后端修复

- 补上新版 Freebuff `free` 模式所需的 session 握手流程：
  - 接入 `POST /api/v1/freebuff/session`
  - 接入 `GET /api/v1/freebuff/session`
  - 接入 `DELETE /api/v1/freebuff/session`
- 在请求上游 Codebuff 时注入 `freebuff_instance_id`，兼容当前官方 free-session gate。
- 为 `free` 模式补齐可恢复错误处理：
  - `freebuff_update_required (426)`
  - `session_superseded (409)`
  - `session_expired (410)`
- 对 `waiting_room_required (428)` / `waiting_room_queued (429)` 保持透传，不做错误重试死循环。
- Anthropic `/v1/messages` 的**流式**与**非流式**路径都已接入上述兼容逻辑。

### 前端更新

- 控制台重构为**多页布局**：`总览` / `使用统计`。
- 使用统计页单独拆出，支持更清晰的汇总卡片与请求明细表。
- 重新整理账号管理区、运行配置区、会话管理区和 Claude Code 接入说明。
- 修复账号池表格横向溢出、文字发飘、标题区说明过重等问题。
- 移除旧的“实验桥”入口，界面信息结构更简洁。

### 当前状态

当前版本已恢复正常使用，重点验证如下：

- `npm start` 可正常启动本地服务
- `GET /health` 正常返回
- `free` 模式不再因为缺少新版 session 握手而直接触发 `freebuff_update_required (426)`
- `POST /v1/messages` 与流式 SSE 路径都已接入同一套 free-session 兼容逻辑
- 如果官方 free session 进入 waiting room，桥会正确返回 `waiting_room_required` / `waiting_room_queued`，而不是陷入旧版兼容错误
- 控制台页面可正常打开，`总览` / `使用统计` 可正常切换

如果你之前遇到：

```json
{"error":{"message":"This version of freebuff is out of date...","code":"freebuff_update_required"}}
```

这次更新就是为了解决这条错误对应的兼容问题。

## 工作原理

```
Claude Code / 其他客户端
        │  Anthropic 或 OpenAI 格式
        ▼
  Freebuff Bridge（本地 :8765）
        │  Codebuff 官方 API
        ▼
  codebuff.com/api/v1/chat/completions
```

- 从 `~/.config/manicode/credentials.json` 或 `CODEBUFF_API_KEY` 读取凭证
- 为每个会话创建 Codebuff `agent-run`，维护对话上下文
- 在 Anthropic `tool_use`/`tool_result` 与 OpenAI `tool_calls`/`tool` 之间双向翻译
- 支持流式（SSE）与非流式响应
- 支持原生工具、MCP 工具、插件工具

当前支持 **Free / Default / Lite / Max / Plan** 模式，其中 `free` 模式可选后端模型：

| 模型 | 提供方 |
|------|--------|
| `z-ai/glm-5.1` | Z.AI / Fireworks |
| `minimax/minimax-m2.7` | MiniMax |

## 环境要求

- Node.js 18+
- 有效的 Freebuff/Codebuff 账号凭证

## 快速开始

```bash
npm install
npm start
```

服务启动后监听 `http://127.0.0.1:8765`，打开浏览器访问控制台：

```bash
open http://127.0.0.1:8765
```

## 接入 Claude Code

**1. 设置环境变量**

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8765
export ANTHROPIC_API_KEY=dummy
```

`ANTHROPIC_API_KEY` 仅为占位，真正的鉴权走本地 Freebuff 凭证。

**2. 启动 Claude Code**

```bash
claude --model freebuff-bridge
```

**3. 持久化配置**（写入 `~/.claude/settings.json`）

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8765",
    "ANTHROPIC_API_KEY": "dummy"
  },
  "model": "freebuff-bridge"
}
```

**4. 验证连接**

```bash
curl http://127.0.0.1:8765/health
```

返回 `"authenticated": true` 即接通。

## 首次登录 / 新增账号

如果本地没有已保存的凭证，或需要继续加入新的账号，通过以下方式发起登录：

```bash
curl -X POST http://127.0.0.1:8765/v1/freebuff/login \
  -H 'Content-Type: application/json' \
  -d '{"reset": true}'
```

返回 `loginUrl`，在浏览器中打开并完成官方登录，然后查询状态：

```bash
curl "http://127.0.0.1:8765/v1/freebuff/login/status?session=login"
```

登录成功后，新账号会自动加入本地账号池并保存至 `~/.config/manicode/credentials.json`。

也可以直接在控制台页面点击“新增登录账号”完成上述流程。

## 多账号轮训

- 可以同时保存多个 Freebuff 账号。
- 新桥接会话创建时，会从全部可用账号中按轮训顺序选择一个账号。
- 同一个桥接会话在首次命中账号后会固定绑定该账号，直到会话重置、账号被移除，或该账号认证失效后重绑。
- `~/.config/manicode/credentials.json` 的旧单账号 `default` 格式会自动兼容读取。

## 控制台

访问 `http://127.0.0.1:8765`，提供：

- 账号池状态、逐账号登录/登出操作
- 运行时配置（模型别名、Codebuff 模式、后端模型）
- 活跃会话列表、会话绑定账号与重置
- Token 用量统计（按请求明细）
- Claude Code 工具协议兼容状态

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `8765` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `CODEBUFF_API_KEY` | — | 直接提供 API Token |
| `FREEBUFF_MODEL` | `freebuff-bridge` | Claude 侧模型别名 |
| `FREEBUFF_MODE` | `free` | Codebuff 模式，支持 `free/default/lite/max/plan` |
| `FREEBUFF_COST_MODE` | `free` | 兼容旧配置的模式别名，等同于 `FREEBUFF_MODE` |
| `FREEBUFF_AGENT_ID` | `base2-free` | 兼容旧配置的底层 Agent ID，会自动映射到对应模式 |
| `FREEBUFF_BACKEND_MODEL` | `z-ai/glm-5.1` | 后端实际模型 |
| `FREEBUFF_RESPONSE_TIMEOUT_MS` | `180000` | 请求超时（毫秒） |
| `FREEBUFF_USAGE_HISTORY_LIMIT` | `500` | 内存中保留的用量条数 |
| `FREEBUFF_LOGIN_BASE_URL` | `https://freebuff.com` | 登录基础 URL |
| `FREEBUFF_API_BASE_URL` | `https://www.codebuff.com` | API 基础 URL |
| `FREEBUFF_LOG_LEVEL` | `info` | 日志级别，支持 `debug/info/warn/error` |

## 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查与认证状态（`?verbose=1` 增加后端探活与账号预检） |
| GET | `/` | 控制台页面 |
| GET | `/v1/models` | 模型列表 |
| POST | `/v1/messages` | Anthropic Messages 接口 |
| POST | `/v1/messages/count_tokens` | Token 数估算 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions 接口 |
| GET | `/v1/freebuff/status` | 会话与认证详情 |
| GET | `/v1/freebuff/config` | 当前运行时配置 |
| POST | `/v1/freebuff/config` | 更新运行时配置 |
| GET | `/v1/freebuff/usage` | Token 用量记录 |
| POST | `/v1/freebuff/usage/reset` | 清空用量记录 |
| POST | `/v1/freebuff/login` | 发起登录流程 |
| GET | `/v1/freebuff/login/status` | 查询登录状态 |
| POST | `/v1/freebuff/logout` | 登出指定账号（请求体传 `accountId`） |
| POST | `/v1/freebuff/logout/all` | 清空全部本地账号 |
| POST | `/v1/freebuff/reset` | 重置指定桥接会话 |
| GET | `/v1/freebuff/admin/overview` | 全局概览 |

## 注意事项

- 同一会话的请求串行处理，不会并发竞争。
- 会话绑定账号后默认固定，不会在每次请求之间来回切账号。
- 修改运行时配置会清除所有内存中的会话，避免新旧 RunState 混用。
- 用量记录仅保存在内存中，重启后清空。
