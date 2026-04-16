# Freebuff Bridge

本地 Anthropic/OpenAI 兼容桥接服务，将 Claude Code 及其他客户端的请求转发至 Freebuff/Codebuff 官方后端，免费使用 AI 编程能力。

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

当前固定使用 **Free 模式**，可选后端模型：

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
- 运行时配置（模型别名、Agent ID、后端模型）
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
| `FREEBUFF_AGENT_ID` | `base2-free` | Codebuff Agent ID |
| `FREEBUFF_BACKEND_MODEL` | `z-ai/glm-5.1` | 后端实际模型 |
| `FREEBUFF_RESPONSE_TIMEOUT_MS` | `180000` | 请求超时（毫秒） |
| `FREEBUFF_USAGE_HISTORY_LIMIT` | `500` | 内存中保留的用量条数 |
| `FREEBUFF_LOGIN_BASE_URL` | `https://freebuff.com` | 登录基础 URL |
| `FREEBUFF_API_BASE_URL` | `https://www.codebuff.com` | API 基础 URL |

## 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查与认证状态 |
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
