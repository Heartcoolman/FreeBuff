import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG = {
  port: Number(process.env.PORT || 8765),
  host: process.env.HOST || '127.0.0.1',
  cwd: process.env.FREEBUFF_CWD || process.cwd(),
  defaultModel: process.env.FREEBUFF_MODEL || 'freebuff-bridge',
  defaultAgentId: process.env.FREEBUFF_AGENT_ID || 'base2-free',
  defaultCostMode: process.env.FREEBUFF_COST_MODE || 'free',
  defaultSessionId: process.env.FREEBUFF_SESSION_ID || 'default',
  loginSessionId: process.env.FREEBUFF_LOGIN_SESSION_ID || 'login',
  responseTimeoutMs: Number(process.env.FREEBUFF_RESPONSE_TIMEOUT_MS || 180_000),
  loginBaseUrl: process.env.FREEBUFF_LOGIN_BASE_URL || 'https://freebuff.com',
  apiBaseUrl: process.env.FREEBUFF_API_BASE_URL || 'https://www.codebuff.com',
  usageHistoryLimit: Number(process.env.FREEBUFF_USAGE_HISTORY_LIMIT || 500),
}

const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(APP_DIR, 'public')

const runtimeConfig = {
  modelAlias: CONFIG.defaultModel,
  agentId: CONFIG.defaultAgentId,
  costMode: CONFIG.defaultCostMode,
  backendModel: process.env.FREEBUFF_BACKEND_MODEL || 'z-ai/glm-5.1',
}

const FREE_ALLOWED_BACKEND_MODELS = [
  {
    value: 'z-ai/glm-5.1',
    label: 'GLM 5.1',
    provider: 'Z.AI / Fireworks',
  },
  {
    value: 'minimax/minimax-m2.7',
    label: 'MiniMax M2.7',
    provider: 'MiniMax',
  },
]

const sessionLocks = new Map()
const bridgeSessions = new Map()
const loginSessions = new Map()
const usageRecords = []

process.on('uncaughtException', (error) => {
  console.error('[freebuff-bridge] uncaughtException', error)
})

process.on('unhandledRejection', (error) => {
  console.error('[freebuff-bridge] unhandledRejection', error)
})

function firstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value) && value.length > 0) {
      const nested = firstNonEmpty(...value)
      if (nested) {
        return nested
      }
      continue
    }

    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }

  return ''
}

function safeSessionName(raw) {
  return `freebuff-bridge-${String(raw || CONFIG.defaultSessionId).replace(
    /[^a-zA-Z0-9_-]/g,
    '-',
  )}`
}

function normalizeText(text) {
  return String(text || '').replace(/\r/g, '').trim()
}

function estimateTokens(text) {
  const normalized = normalizeText(text)
  if (!normalized) {
    return 0
  }

  return Math.max(1, Math.ceil(normalized.length / 4))
}

function stripTrailingWhitespace(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .trim()
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.ico': 'image/x-icon',
    }[ext] || 'application/octet-stream'
  )
}

function serveStaticFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    return false
  }

  const body = fs.readFileSync(filePath)
  res.writeHead(200, {
    'content-type': getContentType(filePath),
    'content-length': body.byteLength,
  })
  res.end(body)
  return true
}

function getCredentialsPath() {
  return path.join(os.homedir(), '.config', 'manicode', 'credentials.json')
}

function readCredentialsFile() {
  const credentialsPath = getCredentialsPath()
  if (!fs.existsSync(credentialsPath)) {
    return {}
  }

  try {
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'))
  } catch {
    return {}
  }
}

function writeCredentialsFile(data) {
  const credentialsPath = getCredentialsPath()
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true })
  fs.writeFileSync(credentialsPath, JSON.stringify(data, null, 2))
}

function clearUserCredentials() {
  const credentialsPath = getCredentialsPath()
  if (!fs.existsSync(credentialsPath)) {
    return
  }

  const current = readCredentialsFile()
  const { default: _removed, ...rest } = current
  if (Object.keys(rest).length === 0) {
    fs.unlinkSync(credentialsPath)
    return
  }

  writeCredentialsFile(rest)
}

function getStoredCredentials() {
  const data = readCredentialsFile()
  const user = data.default
  if (!user || typeof user !== 'object') {
    return null
  }
  if (typeof user.authToken !== 'string' || !user.authToken) {
    return null
  }

  return user
}

function saveUserCredentials(user) {
  const current = readCredentialsFile()
  writeCredentialsFile({
    ...current,
    default: user,
  })
}

function resolveAuthState() {
  const envToken = firstNonEmpty(
    process.env.CODEBUFF_API_KEY,
    process.env.FREEBUFF_AUTH_TOKEN,
  )

  if (envToken) {
    return {
      authenticated: true,
      token: envToken,
      source: 'environment',
      user: null,
      email: null,
    }
  }

  const stored = getStoredCredentials()
  if (stored) {
    return {
      authenticated: true,
      token: stored.authToken,
      source: 'credentials',
      user: stored,
      email: typeof stored.email === 'string' ? stored.email : null,
    }
  }

  return {
    authenticated: false,
    token: null,
    source: null,
    user: null,
    email: null,
  }
}

function getRuntimeConfig() {
  return {
    modelAlias: runtimeConfig.modelAlias,
    agentId: runtimeConfig.agentId,
    costMode: 'free',
    backendModel: runtimeConfig.backendModel,
    availableBackendModels: FREE_ALLOWED_BACKEND_MODELS,
  }
}

async function finishSessionRun(authToken, session, status = 'cancelled') {
  if (!authToken || !session?.runId) {
    return
  }

  try {
    await fetch(`${CONFIG.apiBaseUrl}/api/v1/agent-runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${authToken}`,
        'x-codebuff-api-key': authToken,
      },
      body: JSON.stringify({
        action: 'FINISH',
        runId: session.runId,
        status,
        totalSteps: session.turns,
        directCredits: 0,
        totalCredits: 0,
      }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    console.error('[freebuff-bridge] finishSessionRun failed', error)
  }
}

async function finishAllSessions(authToken, status = 'cancelled') {
  const sessions = Array.from(bridgeSessions.values())
  await Promise.allSettled(
    sessions.map((session) => finishSessionRun(authToken, session, status)),
  )
}

async function applyRuntimeConfig(updates = {}) {
  const previous = getRuntimeConfig()

  if (typeof updates.modelAlias === 'string' && updates.modelAlias.trim()) {
    runtimeConfig.modelAlias = updates.modelAlias.trim()
  }

  if (typeof updates.agentId === 'string' && updates.agentId.trim()) {
    runtimeConfig.agentId = updates.agentId.trim()
  }

  runtimeConfig.costMode = 'free'

  if (typeof updates.backendModel === 'string' && updates.backendModel.trim()) {
    const nextModel = updates.backendModel.trim()
    const isAllowed = FREE_ALLOWED_BACKEND_MODELS.some(
      (model) => model.value === nextModel,
    )
    if (!isAllowed) {
      throw Object.assign(
        new Error(`Unsupported backend model: ${nextModel}`),
        { statusCode: 400 },
      )
    }
    runtimeConfig.backendModel = nextModel
  }

  const next = getRuntimeConfig()
  const changed =
    previous.modelAlias !== next.modelAlias ||
    previous.agentId !== next.agentId ||
    previous.costMode !== next.costMode ||
    previous.backendModel !== next.backendModel

  if (changed) {
    const auth = resolveAuthState()
    await finishAllSessions(auth.token, 'cancelled')
    bridgeSessions.clear()
  }

  return { changed, config: next }
}

function withSessionLock(sessionName, work) {
  const previous = sessionLocks.get(sessionName) || Promise.resolve()

  const current = previous
    .catch(() => {})
    .then(work)
    .finally(() => {
      if (sessionLocks.get(sessionName) === current) {
        sessionLocks.delete(sessionName)
      }
    })

  sessionLocks.set(sessionName, current)
  return current
}

async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk))
  }

  if (chunks.length === 0) {
    return {}
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw Object.assign(new Error('Invalid JSON in request body.'), {
      statusCode: 400,
    })
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function getSerializableContentText(content) {
  if (content == null) {
    return ''
  }

  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content.map((item) => getSerializableContentText(item)).filter(Boolean).join('\n')
  }

  if (typeof content === 'object') {
    if (content.type === 'text' && typeof content.text === 'string') {
      return content.text
    }
    if (content.content != null) {
      return getSerializableContentText(content.content)
    }
    return JSON.stringify(content)
  }

  return String(content)
}

function normalizeAnthropicSystem(systemInput) {
  if (typeof systemInput === 'string') {
    return normalizeText(systemInput)
  }

  if (!Array.isArray(systemInput)) {
    return ''
  }

  return normalizeText(
    systemInput
      .map((part) => {
        if (typeof part === 'string') {
          return part
        }
        if (part?.type === 'text') {
          return part.text || ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n'),
  )
}

function normalizeToolResultContent(content, isError) {
  const text = normalizeText(getSerializableContentText(content))
  if (!text) {
    return isError ? 'Tool returned an error.' : ''
  }

  return isError ? `[tool_error]\n${text}` : text
}

function convertAnthropicMessagesToOpenAIMessages(messages, systemInput) {
  const openAIMessages = []
  const systemText = normalizeAnthropicSystem(systemInput)
  if (systemText) {
    openAIMessages.push({
      role: 'system',
      content: systemText,
    })
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || !message.role) {
      continue
    }

    if (typeof message.content === 'string') {
      openAIMessages.push({
        role: message.role,
        content: message.content,
      })
      continue
    }

    const contentBlocks = Array.isArray(message.content) ? message.content : []

    if (message.role === 'user') {
      let bufferedText = []

      const flushText = () => {
        if (bufferedText.length === 0) {
          return
        }

        openAIMessages.push({
          role: 'user',
          content: bufferedText.join('\n'),
        })
        bufferedText = []
      }

      for (const part of contentBlocks) {
        if (part?.type === 'text') {
          if (typeof part.text === 'string' && part.text) {
            bufferedText.push(part.text)
          }
          continue
        }

        if (part?.type === 'tool_result') {
          flushText()
          openAIMessages.push({
            role: 'tool',
            tool_call_id: part.tool_use_id,
            content: normalizeToolResultContent(part.content, part.is_error === true),
          })
          continue
        }
      }

      flushText()
      continue
    }

    if (message.role === 'assistant') {
      const textParts = []
      const toolCalls = []

      for (const part of contentBlocks) {
        if (part?.type === 'text') {
          if (typeof part.text === 'string' && part.text) {
            textParts.push(part.text)
          }
          continue
        }

        if (part?.type === 'tool_use') {
          toolCalls.push({
            id: typeof part.id === 'string' ? part.id : `toolu_${randomUUID().replace(/-/g, '')}`,
            type: 'function',
            function: {
              name: part.name,
              arguments: JSON.stringify(part.input || {}),
            },
          })
        }
      }

      openAIMessages.push({
        role: 'assistant',
        content: textParts.join('\n'),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      })
      continue
    }

    if (message.role === 'tool') {
      openAIMessages.push({
        role: 'tool',
        tool_call_id: message.tool_call_id,
        content: normalizeText(getSerializableContentText(message.content)),
      })
      continue
    }

    if (message.role === 'system') {
      openAIMessages.push({
        role: 'system',
        content: normalizeText(getSerializableContentText(message.content)),
      })
    }
  }

  return openAIMessages
}

function convertAnthropicToolsToOpenAITools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return undefined
  }

  return tools
    .filter((tool) => typeof tool?.name === 'string' && tool.name)
    .map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: sanitizeToolDescription(tool.name, tool.description),
        parameters:
          tool.input_schema && typeof tool.input_schema === 'object'
            ? sanitizeToolSchema(tool.input_schema)
            : {
                type: 'object',
                properties: {},
                required: [],
              },
      },
    }))
}

function convertAnthropicToolChoiceToOpenAI(toolChoice) {
  if (!toolChoice) {
    return 'auto'
  }

  if (typeof toolChoice === 'string') {
    return toolChoice
  }

  if (toolChoice.type === 'auto') {
    return 'auto'
  }

  if (toolChoice.type === 'any') {
    return 'required'
  }

  if (toolChoice.type === 'none') {
    return 'none'
  }

  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return {
      type: 'function',
      function: {
        name: toolChoice.name,
      },
    }
  }

  return undefined
}

function safeJsonParse(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return {}
  }

  try {
    return JSON.parse(value)
  } catch {
    return {
      raw: value,
    }
  }
}

const TOOL_DESCRIPTION_OVERRIDES = {
  Bash: 'Execute a shell command. Required parameter: command.',
  Read: 'Read a file from disk. Required parameter: file_path.',
  Write: 'Write content to a file. Required parameters: file_path, content.',
  Edit: 'Replace text in a file. Required parameters: file_path, old_string, new_string.',
  Glob: 'Find files by glob pattern. Required parameter: pattern.',
  Grep: 'Search file content by pattern. Required parameter: pattern.',
  Task: 'Run a delegated agent task. Required parameters depend on the task.',
}

function sanitizeToolDescription(name, description) {
  if (typeof TOOL_DESCRIPTION_OVERRIDES[name] === 'string') {
    return TOOL_DESCRIPTION_OVERRIDES[name]
  }

  if (typeof description !== 'string' || !description.trim()) {
    return undefined
  }

  return description.replace(/\s+/g, ' ').trim().slice(0, 240)
}

function sanitizeToolSchema(schema) {
  if (Array.isArray(schema)) {
    return schema.map((item) => sanitizeToolSchema(item))
  }

  if (!schema || typeof schema !== 'object') {
    return schema
  }

  const allowedKeys = new Set([
    'type',
    'properties',
    'required',
    'items',
    'additionalProperties',
    'enum',
    'oneOf',
    'anyOf',
    'allOf',
    'minimum',
    'maximum',
    'minItems',
    'maxItems',
    'minLength',
    'maxLength',
    'default',
    'format',
    'nullable',
  ])

  const next = {}
  for (const [key, value] of Object.entries(schema)) {
    if (!allowedKeys.has(key)) {
      continue
    }

    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      next.properties = Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
          childKey,
          sanitizeToolSchema(childValue),
        ]),
      )
      continue
    }

    next[key] = sanitizeToolSchema(value)
  }

  return next
}

function normalizeToolSchemaMap(tools) {
  const map = new Map()
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (typeof tool?.name === 'string' && tool.name) {
      map.set(tool.name, tool.input_schema || {})
    }
  }
  return map
}

function validateAgainstSchema(schema, value, path = []) {
  if (!schema || typeof schema !== 'object') {
    return []
  }

  const errors = []
  const schemaType = schema.type

  if (schemaType === 'object') {
    if (typeof value !== 'object' || value == null || Array.isArray(value)) {
      errors.push({
        path,
        message: 'Expected object',
      })
      return errors
    }

    const required = Array.isArray(schema.required) ? schema.required : []
    for (const key of required) {
      if (!(key in value)) {
        errors.push({
          path: [...path, key],
          message: 'Missing required property',
        })
      }
    }

    const properties =
      schema.properties && typeof schema.properties === 'object'
        ? schema.properties
        : {}
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) {
        errors.push(...validateAgainstSchema(childSchema, value[key], [...path, key]))
      }
    }
    return errors
  }

  if (schemaType === 'array') {
    if (!Array.isArray(value)) {
      errors.push({
        path,
        message: 'Expected array',
      })
      return errors
    }
    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => {
        errors.push(...validateAgainstSchema(schema.items, item, [...path, index]))
      })
    }
    return errors
  }

  if (schemaType === 'string' && typeof value !== 'string') {
    errors.push({ path, message: 'Expected string' })
  } else if (schemaType === 'number' && typeof value !== 'number') {
    errors.push({ path, message: 'Expected number' })
  } else if (schemaType === 'integer' && !Number.isInteger(value)) {
    errors.push({ path, message: 'Expected integer' })
  } else if (schemaType === 'boolean' && typeof value !== 'boolean') {
    errors.push({ path, message: 'Expected boolean' })
  }

  return errors
}

function collectInvalidToolUses(content, toolSchemaMap) {
  return content
    .filter((block) => block.type === 'tool_use')
    .map((block, index) => {
      const schema = toolSchemaMap.get(block.name)
      const errors = validateAgainstSchema(schema, block.input || {})
      return {
        index,
        block,
        schema,
        errors,
      }
    })
    .filter((item) => item.errors.length > 0)
}

function mapOpenAIFinishReasonToAnthropic(finishReason, hasToolCalls) {
  if (hasToolCalls || finishReason === 'tool_calls') {
    return 'tool_use'
  }

  if (finishReason === 'length') {
    return 'max_tokens'
  }

  if (finishReason === 'stop' || finishReason == null) {
    return 'end_turn'
  }

  return 'end_turn'
}

function convertOpenAIChoiceToAnthropicMessage(choice, publicModel, usage) {
  const message = choice?.message || {}
  const contentBlocks = []
  const text = typeof message.content === 'string' ? stripTrailingWhitespace(message.content) : ''

  if (text) {
    contentBlocks.push({
      type: 'text',
      text,
    })
  }

  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  for (const toolCall of toolCalls) {
    contentBlocks.push({
      type: 'tool_use',
      id:
        typeof toolCall.id === 'string'
          ? toolCall.id
          : `toolu_${randomUUID().replace(/-/g, '')}`,
      name: toolCall?.function?.name || 'unknown_tool',
      input: safeJsonParse(toolCall?.function?.arguments),
    })
  }

  return {
    id: `msg_${randomUUID().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model: publicModel,
    content: contentBlocks,
    stop_reason: mapOpenAIFinishReasonToAnthropic(
      choice?.finish_reason,
      toolCalls.length > 0,
    ),
    stop_sequence: null,
    usage: {
      input_tokens: usage?.prompt_tokens || 0,
      output_tokens: usage?.completion_tokens || 0,
    },
  }
}

function buildAnthropicResponseFromOpenAI(payload, publicModel) {
  const choice = payload?.choices?.[0] || {}
  return convertOpenAIChoiceToAnthropicMessage(choice, publicModel, payload?.usage)
}

function buildCompletionResponse(model, payload) {
  const usage = payload?.usage || {}
  return {
    id: payload?.id || `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: payload?.created || Math.floor(Date.now() / 1000),
    model,
    choices: payload?.choices || [],
    usage: {
      prompt_tokens: usage.prompt_tokens || 0,
      completion_tokens: usage.completion_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    },
  }
}

function buildModelsResponse() {
  return {
    data: [
      {
        type: 'model',
        id: runtimeConfig.modelAlias,
        display_name: runtimeConfig.modelAlias,
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
    has_more: false,
    first_id: runtimeConfig.modelAlias,
    last_id: runtimeConfig.modelAlias,
  }
}

function createBridgeSession(sessionName) {
  const now = new Date().toISOString()
  return {
    session: sessionName,
    clientId: randomUUID(),
    fingerprintId: randomUUID(),
    runId: null,
    costMode: runtimeConfig.costMode,
    agentId: runtimeConfig.agentId,
    backendModel: runtimeConfig.backendModel,
    n: 1,
    turns: 0,
    requestCount: 0,
    createdAt: now,
    updatedAt: now,
    lastStopReason: null,
    lastError: null,
  }
}

function getOrCreateBridgeSession(sessionName) {
  let session = bridgeSessions.get(sessionName)
  if (!session) {
    session = createBridgeSession(sessionName)
    bridgeSessions.set(sessionName, session)
  }
  return session
}

function buildCodebuffMetadata(session) {
  return {
    client_id: session.clientId,
    run_id: session.runId,
    cost_mode: session.costMode,
    n: session.n,
  }
}

function inspectBridgeSession(sessionName) {
  const session = bridgeSessions.get(sessionName)
  if (!session) {
    return {
      session: sessionName,
      exists: false,
      hasRunState: false,
      hasActiveRun: false,
      turns: 0,
      codebuffMetadata: null,
      lastStopReason: null,
      lastError: null,
    }
  }

  return {
    session: sessionName,
    exists: true,
    hasRunState: !!session.runId,
    hasActiveRun: !!session.runId,
    turns: session.turns,
    codebuffMetadata: buildCodebuffMetadata(session),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastStopReason: session.lastStopReason,
    lastError: session.lastError,
  }
}

function recordUsage(record) {
  usageRecords.unshift(record)
  if (usageRecords.length > CONFIG.usageHistoryLimit) {
    usageRecords.length = CONFIG.usageHistoryLimit
  }
}

function buildUsageSummary(records = usageRecords) {
  const summary = records.reduce(
    (acc, record) => {
      acc.requests += 1
      acc.promptTokens += record.promptTokens
      acc.outputTokens += record.outputTokens
      acc.totalTokens += record.totalTokens
      acc.promptChars += record.promptChars
      acc.outputChars += record.outputChars
      acc.toolCount += record.toolCount
      acc.totalDurationMs += record.durationMs || 0
      return acc
    },
    {
      requests: 0,
      promptTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      promptChars: 0,
      outputChars: 0,
      toolCount: 0,
      totalDurationMs: 0,
    },
  )
  summary.avgDurationMs = summary.requests > 0 ? Math.round(summary.totalDurationMs / summary.requests) : 0
  summary.avgTps = summary.requests > 0 && summary.totalDurationMs > 0
    ? Math.round(summary.outputTokens / (summary.totalDurationMs / 1000))
    : 0
  return summary
}

function listSessions() {
  const usageBySession = new Map()
  for (const record of usageRecords) {
    const current =
      usageBySession.get(record.session) || {
        requests: 0,
        promptTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        toolCount: 0,
      }
    current.requests += 1
    current.promptTokens += record.promptTokens
    current.outputTokens += record.outputTokens
    current.totalTokens += record.totalTokens
    current.toolCount += record.toolCount
    usageBySession.set(record.session, current)
  }

  return Array.from(bridgeSessions.keys())
    .sort()
    .map((sessionName) => {
      const session = bridgeSessions.get(sessionName)
      return {
        ...inspectBridgeSession(sessionName),
        usage:
          usageBySession.get(sessionName) || {
            requests: 0,
            promptTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            toolCount: 0,
          },
        costMode: session?.costMode || runtimeConfig.costMode,
      }
    })
}

function buildAdminOverview() {
  const auth = resolveAuthState()
  const sessions = listSessions()
  const recentErrors = usageRecords
    .filter((record) => record.errorSummary)
    .slice(0, 10)
    .map((record) => ({
      createdAt: record.createdAt,
      session: record.session,
      errorSummary: record.errorSummary,
    }))

  const toolSourceSummary = usageRecords.reduce(
    (summary, record) => {
      for (const source of record.toolSources || []) {
        summary[source] = (summary[source] || 0) + 1
      }
      return summary
    },
    {},
  )

  return {
    ok: true,
    auth: {
      authenticated: auth.authenticated,
      source: auth.source,
      email: auth.email,
    },
    config: getRuntimeConfig(),
    sessions,
    compatibility: {
      protocol: 'anthropic-messages',
      supportsNativeTools: true,
      supportsMcpTools: true,
      supportsInstalledPluginTools: true,
      recentErrors,
      toolSourceSummary,
    },
    usage: {
      summary: buildUsageSummary(),
      records: usageRecords,
    },
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options)
  const text = await response.text()
  let data = null

  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    data,
  }
}

async function callCodebuffJson(token, pathname, body) {
  return fetchJson(`${CONFIG.apiBaseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-codebuff-api-key': token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CONFIG.responseTimeoutMs),
  })
}

async function startAgentRun(token, agentId) {
  const response = await callCodebuffJson(token, '/api/v1/agent-runs', {
    action: 'START',
    agentId,
    ancestorRunIds: [],
  })

  if (!response.ok || typeof response.data?.runId !== 'string') {
    throw Object.assign(new Error(response.data?.error || 'Failed to create agent run.'), {
      statusCode: response.status || 500,
    })
  }

  return response.data.runId
}

async function ensureActiveRun(token, session) {
  if (session.runId) {
    return session.runId
  }

  session.runId = await startAgentRun(token, session.agentId)
  session.updatedAt = new Date().toISOString()
  bridgeSessions.set(session.session, session)
  return session.runId
}

function isInvalidRunError(response) {
  const message = response?.data?.message || response?.data?.error || response?.text || ''
  return (
    typeof message === 'string' &&
    (message.includes('runId Not Found') || message.includes('runId Not Running'))
  )
}

async function executeCodebuffChatCompletion({
  token,
  session,
  upstreamBody,
}) {
  await ensureActiveRun(token, session)

  let response = await callCodebuffJson(token, '/api/v1/chat/completions', {
    ...upstreamBody,
    codebuff_metadata: buildCodebuffMetadata(session),
  })

  if (!response.ok && isInvalidRunError(response)) {
    await finishSessionRun(token, session, 'cancelled')
    session.runId = await startAgentRun(token, session.agentId)
    session.updatedAt = new Date().toISOString()
    bridgeSessions.set(session.session, session)
    response = await callCodebuffJson(token, '/api/v1/chat/completions', {
      ...upstreamBody,
      codebuff_metadata: buildCodebuffMetadata(session),
    })
  }

  if (!response.ok) {
    throw Object.assign(
      new Error(
        response.data?.error ||
          response.data?.message ||
          response.text ||
          'Codebuff completion request failed.',
      ),
      {
        statusCode: response.status || 500,
      },
    )
  }

  return response
}

async function repairToolUse({
  token,
  session,
  publicModel,
  system,
  messages,
  tool,
  invalidToolUse,
}) {
  const repairPrompt = [
    'You are repairing an invalid tool call.',
    'Return ONLY one tool call for the specified tool.',
    'Fill every required parameter from the conversation context.',
    'Do not omit required fields.',
    '',
    `Tool name: ${tool.name}`,
    `Previous invalid input: ${JSON.stringify(invalidToolUse.input || {})}`,
    `Conversation messages: ${JSON.stringify(messages)}`,
  ].join('\n')

  const repairMessages = [
    {
      role: 'user',
      content: repairPrompt,
    },
  ]

  const repairBody = {
    model: runtimeConfig.backendModel,
    stream: false,
    messages: convertAnthropicMessagesToOpenAIMessages(repairMessages, system),
    tools: convertAnthropicToolsToOpenAITools([tool]),
    tool_choice: {
      type: 'function',
      function: {
        name: tool.name,
      },
    },
    max_tokens: 256,
  }

  const response = await executeCodebuffChatCompletion({
    token,
    session,
    upstreamBody: repairBody,
  })

  const repaired = buildAnthropicResponseFromOpenAI(response.data, publicModel)
  const repairedToolUse = repaired.content.find(
    (block) => block.type === 'tool_use' && block.name === tool.name,
  )

  if (!repairedToolUse) {
    return invalidToolUse
  }

  return repairedToolUse
}

async function repairInvalidToolUses({
  token,
  session,
  publicModel,
  system,
  messages,
  tools,
  anthropicMessage,
}) {
  const toolSchemaMap = normalizeToolSchemaMap(tools)
  const invalidToolUses = collectInvalidToolUses(anthropicMessage.content, toolSchemaMap)
  if (invalidToolUses.length === 0) {
    return {
      message: anthropicMessage,
      repairedCount: 0,
    }
  }

  let repairedCount = 0
  for (const invalid of invalidToolUses) {
    const tool = (Array.isArray(tools) ? tools : []).find(
      (item) => item?.name === invalid.block.name,
    )
    if (!tool) {
      continue
    }

    const repaired = await repairToolUse({
      token,
      session,
      publicModel,
      system,
      messages,
      tool,
      invalidToolUse: invalid.block,
    })

    const repairedErrors = validateAgainstSchema(invalid.schema, repaired.input || {})
    if (repairedErrors.length === 0) {
      anthropicMessage.content[invalid.index] = repaired
      repairedCount += 1
    }
  }

  return {
    message: anthropicMessage,
    repairedCount,
  }
}

function resolveSessionName(body, headers, url) {
  return safeSessionName(
    firstNonEmpty(
      body?.session,
      body?.metadata?.session_id,
      body?.metadata?.conversation_id,
      body?.user,
      headers['x-freebuff-session'],
      url?.searchParams.get('session'),
    ) || CONFIG.defaultSessionId,
  )
}

function shouldResetSession(body, headers) {
  return (
    body?.reset === true ||
    body?.metadata?.reset === true ||
    headers['x-freebuff-reset'] === '1'
  )
}

function summarizeAnthropicTools(tools) {
  if (!Array.isArray(tools)) {
    return {
      toolCount: 0,
      toolSources: [],
    }
  }

  const sources = new Set()
  for (const tool of tools) {
    const name = tool?.name || ''
    if (name.startsWith('mcp__')) {
      sources.add('mcp')
    } else if (name.startsWith('plugin__')) {
      sources.add('plugin')
    } else {
      sources.add('builtin')
    }
  }

  return {
    toolCount: tools.length,
    toolSources: Array.from(sources),
  }
}

async function executeAnthropicRequest({ sessionName, body, headers, url }) {
  return withSessionLock(sessionName, async () => {
    const auth = resolveAuthState()
    if (!auth.authenticated || !auth.token) {
      throw Object.assign(
        new Error(
          'No Freebuff/Codebuff credentials found. Use /v1/freebuff/login or set CODEBUFF_API_KEY.',
        ),
        { statusCode: 401 },
      )
    }

    if (shouldResetSession(body, headers)) {
      const previous = bridgeSessions.get(sessionName)
      await finishSessionRun(auth.token, previous, 'cancelled')
      bridgeSessions.delete(sessionName)
    }

    const session = getOrCreateBridgeSession(sessionName)
    const requestStartedAt = Date.now()
    const publicModel = body.model || runtimeConfig.modelAlias
    const openAIMessages = convertAnthropicMessagesToOpenAIMessages(
      body.messages,
      body.system,
    )
    const openAITools = convertAnthropicToolsToOpenAITools(body.tools)
    const openAIToolChoice = convertAnthropicToolChoiceToOpenAI(body.tool_choice)
    const upstreamBody = {
      model: runtimeConfig.backendModel,
      stream: false,
      messages: openAIMessages,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      stop: body.stop_sequences,
      provider: {
        data_collection: 'deny',
      },
      tools: openAITools || [],
      tool_choice: openAIToolChoice,
    }

    const response = await executeCodebuffChatCompletion({
      token: auth.token,
      session,
      upstreamBody,
    })

    let anthropicMessage = buildAnthropicResponseFromOpenAI(
      response.data,
      publicModel,
    )
    const repairResult = await repairInvalidToolUses({
      token: auth.token,
      session,
      publicModel,
      system: body.system,
      messages: body.messages,
      tools: body.tools,
      anthropicMessage,
    })
    anthropicMessage = repairResult.message
    const toolSummary = summarizeAnthropicTools(body.tools)
    const promptText = [
      normalizeAnthropicSystem(body.system),
      JSON.stringify(openAIMessages),
    ]
      .filter(Boolean)
      .join('\n')
    const responseText = anthropicMessage.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    session.requestCount += 1
    session.turns += 1
    session.updatedAt = new Date().toISOString()
    session.lastStopReason = anthropicMessage.stop_reason
    session.lastError = null
    bridgeSessions.set(sessionName, session)

    recordUsage({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      session: sessionName,
      requestKind: 'anthropic',
      stream: body.stream === true,
      model: publicModel,
      agentId: session.agentId,
      backendModel: runtimeConfig.backendModel,
      promptTokens: anthropicMessage.usage.input_tokens,
      outputTokens: anthropicMessage.usage.output_tokens,
      totalTokens:
        anthropicMessage.usage.input_tokens + anthropicMessage.usage.output_tokens,
      promptChars: promptText.length,
      outputChars: responseText.length,
      durationMs: Date.now() - requestStartedAt,
      codebuffMetadata: buildCodebuffMetadata(session),
      stopReason: anthropicMessage.stop_reason,
      toolCount: toolSummary.toolCount,
      toolSources: toolSummary.toolSources,
      errorSummary: repairResult.repairedCount > 0 ? `Repaired ${repairResult.repairedCount} invalid tool call(s)` : null,
    })

    return anthropicMessage
  })
}

async function executeOpenAIRequest({ sessionName, body, headers }) {
  return withSessionLock(sessionName, async () => {
    const auth = resolveAuthState()
    if (!auth.authenticated || !auth.token) {
      throw Object.assign(
        new Error(
          'No Freebuff/Codebuff credentials found. Use /v1/freebuff/login or set CODEBUFF_API_KEY.',
        ),
        { statusCode: 401 },
      )
    }

    if (shouldResetSession(body, headers)) {
      const previous = bridgeSessions.get(sessionName)
      await finishSessionRun(auth.token, previous, 'cancelled')
      bridgeSessions.delete(sessionName)
    }

    const session = getOrCreateBridgeSession(sessionName)
    const requestStartedAt = Date.now()
    const publicModel = body.model || runtimeConfig.modelAlias
    const upstreamBody = {
      ...body,
      model: runtimeConfig.backendModel,
      stream: false,
      provider: {
        data_collection: 'deny',
      },
      tools: Array.isArray(body.tools) ? body.tools : [],
      tool_choice: body.tool_choice || 'auto',
      codebuff_metadata: undefined,
    }

    const response = await executeCodebuffChatCompletion({
      token: auth.token,
      session,
      upstreamBody,
    })

    const usage = response.data?.usage || {}
    const toolCalls = response.data?.choices?.[0]?.message?.tool_calls || []
    session.requestCount += 1
    session.turns += 1
    session.updatedAt = new Date().toISOString()
    session.lastStopReason = response.data?.choices?.[0]?.finish_reason || 'stop'
    session.lastError = null
    bridgeSessions.set(sessionName, session)

    recordUsage({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      session: sessionName,
      requestKind: 'openai',
      stream: body.stream === true,
      model: publicModel,
      agentId: session.agentId,
      backendModel: runtimeConfig.backendModel,
      promptTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
      promptChars: JSON.stringify(body.messages || []).length,
      outputChars: normalizeText(response.data?.choices?.[0]?.message?.content).length,
      durationMs: Date.now() - requestStartedAt,
      codebuffMetadata: buildCodebuffMetadata(session),
      stopReason: response.data?.choices?.[0]?.finish_reason || 'stop',
      toolCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
      toolSources: [],
      errorSummary: null,
    })

    return buildCompletionResponse(publicModel, response.data)
  })
}

function sendAnthropicSse(res, message) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  const writeEvent = (event, payload) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  writeEvent('message_start', {
    type: 'message_start',
    message: {
      id: message.id,
      type: 'message',
      role: 'assistant',
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: message.usage.input_tokens,
        output_tokens: 0,
      },
    },
  })

  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      writeEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'text',
          text: '',
        },
      })
      writeEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'text_delta',
          text: block.text,
        },
      })
      writeEvent('content_block_stop', {
        type: 'content_block_stop',
        index,
      })
      return
    }

    if (block.type === 'tool_use') {
      writeEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: {},
        },
      })
      writeEvent('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input || {}),
        },
      })
      writeEvent('content_block_stop', {
        type: 'content_block_stop',
        index,
      })
    }
  })

  writeEvent('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason,
      stop_sequence: null,
    },
    usage: {
      output_tokens: message.usage.output_tokens,
    },
  })
  writeEvent('message_stop', { type: 'message_stop' })
  res.end()
}

function sendOpenAISse(res, payload) {
  const model = payload.model
  const id = payload.id || `chatcmpl-${randomUUID()}`
  const created = payload.created || Math.floor(Date.now() / 1000)
  const choice = payload.choices?.[0] || {}
  const message = choice.message || {}

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })

  res.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
            ...(typeof message.content === 'string' && message.content
              ? { content: message.content }
              : {}),
            ...(Array.isArray(message.tool_calls) && message.tool_calls.length > 0
              ? { tool_calls: message.tool_calls }
              : {}),
          },
          finish_reason: null,
        },
      ],
    })}\n\n`,
  )
  res.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: choice.finish_reason || 'stop',
        },
      ],
    })}\n\n`,
  )
  res.write('data: [DONE]\n\n')
  res.end()
}

function createLoginSession(sessionName) {
  return {
    session: sessionName,
    fingerprintId: randomUUID(),
    fingerprintHash: null,
    expiresAt: null,
    loginUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

async function startLoginSession(sessionName, forceReset = false) {
  let session = loginSessions.get(sessionName)
  if (!session || forceReset) {
    session = createLoginSession(sessionName)
  }

  const response = await fetchJson(`${CONFIG.loginBaseUrl}/api/auth/cli/code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      fingerprintId: session.fingerprintId,
    }),
  })

  if (!response.ok || !response.data?.loginUrl) {
    throw new Error('Failed to generate Freebuff login URL.')
  }

  session = {
    ...session,
    fingerprintHash:
      typeof response.data.fingerprintHash === 'string'
        ? response.data.fingerprintHash
        : null,
    expiresAt:
      typeof response.data.expiresAt === 'string' ||
      typeof response.data.expiresAt === 'number'
        ? response.data.expiresAt
        : null,
    loginUrl:
      typeof response.data.loginUrl === 'string' ? response.data.loginUrl : null,
    updatedAt: new Date().toISOString(),
  }

  loginSessions.set(sessionName, session)
  return session
}

function getLoginSession(sessionName) {
  return loginSessions.get(sessionName) || null
}

function isLoginExpired(session) {
  if (!session?.expiresAt) {
    return false
  }

  const expiresAtMs =
    typeof session.expiresAt === 'number'
      ? session.expiresAt
      : Number(session.expiresAt)

  if (!Number.isFinite(expiresAtMs)) {
    return false
  }

  return Date.now() >= expiresAtMs
}

async function pollLoginSession(sessionName) {
  const session = getLoginSession(sessionName)
  if (!session) {
    throw Object.assign(new Error('No pending login session found.'), {
      statusCode: 404,
    })
  }

  if (!session.fingerprintHash || !session.expiresAt) {
    throw new Error('The login session is incomplete.')
  }

  if (isLoginExpired(session)) {
    return {
      ok: true,
      authenticated: false,
      waiting: false,
      expired: true,
      session: sessionName,
      loginUrl: session.loginUrl,
      expiresAt: session.expiresAt,
    }
  }

  const url = new URL('/api/auth/cli/status', CONFIG.loginBaseUrl)
  url.searchParams.set('fingerprintId', session.fingerprintId)
  url.searchParams.set('fingerprintHash', session.fingerprintHash)
  url.searchParams.set('expiresAt', String(session.expiresAt))

  const response = await fetchJson(url.toString())
  const user = response.data?.user
  const hasUser = response.ok && user && typeof user === 'object'

  if (!hasUser) {
    return {
      ok: true,
      authenticated: false,
      waiting: response.status === 401,
      expired: false,
      session: sessionName,
      loginUrl: session.loginUrl,
      expiresAt: session.expiresAt,
    }
  }

  saveUserCredentials({
    ...user,
    fingerprintId: session.fingerprintId,
    fingerprintHash: session.fingerprintHash,
  })

  return {
    ok: true,
    authenticated: true,
    waiting: false,
    expired: false,
    session: sessionName,
    loginUrl: session.loginUrl,
    expiresAt: session.expiresAt,
    email: typeof user.email === 'string' ? user.email : null,
    source: 'credentials',
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || CONFIG.host}`)

    if (req.method === 'GET' && url.pathname === '/') {
      if (serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'))) {
        return
      }
    }

    if (req.method === 'GET' && (url.pathname === '/app.css' || url.pathname === '/app.js')) {
      if (serveStaticFile(res, path.join(PUBLIC_DIR, url.pathname.slice(1)))) {
        return
      }
    }

    if (req.method === 'GET' && url.pathname === '/v1/models') {
      sendJson(res, 200, buildModelsResponse())
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/freebuff/admin/overview') {
      sendJson(res, 200, buildAdminOverview())
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/freebuff/config') {
      sendJson(res, 200, {
        ok: true,
        config: getRuntimeConfig(),
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/freebuff/config') {
      const body = await readJsonBody(req)
      const result = await applyRuntimeConfig(body)
      sendJson(res, 200, {
        ok: true,
        changed: result.changed,
        config: result.config,
        sessionsReset: result.changed,
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/freebuff/usage') {
      sendJson(res, 200, {
        ok: true,
        summary: buildUsageSummary(),
        records: usageRecords,
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/freebuff/usage/reset') {
      usageRecords.length = 0
      sendJson(res, 200, { ok: true, reset: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/freebuff/logout') {
      const auth = resolveAuthState()
      await finishAllSessions(auth.token, 'cancelled')
      bridgeSessions.clear()
      clearUserCredentials()
      sendJson(res, 200, { ok: true, loggedOut: true })
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const auth = resolveAuthState()
      const sessionName = resolveSessionName({}, req.headers, url)
      sendJson(res, 200, {
        ok: true,
        host: CONFIG.host,
        port: CONFIG.port,
        cwd: CONFIG.cwd,
        model: runtimeConfig.modelAlias,
        agent: runtimeConfig.agentId,
        backendModel: runtimeConfig.backendModel,
        costMode: runtimeConfig.costMode,
        authenticated: auth.authenticated,
        authSource: auth.source,
        email: auth.email,
        bridgeSessions: bridgeSessions.size,
        compatibility: {
          protocol: 'anthropic-messages',
          supportsNativeTools: true,
          supportsMcpTools: true,
          supportsInstalledPluginTools: true,
        },
        ...inspectBridgeSession(sessionName),
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/freebuff/status') {
      const auth = resolveAuthState()
      const sessionName = resolveSessionName({}, req.headers, url)
      sendJson(res, 200, {
        ok: true,
        cwd: CONFIG.cwd,
        authenticated: auth.authenticated,
        authSource: auth.source,
        email: auth.email,
        config: getRuntimeConfig(),
        usageSummary: buildUsageSummary(),
        sessions: listSessions(),
        compatibility: {
          protocol: 'anthropic-messages',
          supportsNativeTools: true,
          supportsMcpTools: true,
          supportsInstalledPluginTools: true,
        },
        ...inspectBridgeSession(sessionName),
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/freebuff/reset') {
      const body = await readJsonBody(req)
      const auth = resolveAuthState()
      const sessionName = resolveSessionName(body, req.headers, url)
      const session = bridgeSessions.get(sessionName)
      await finishSessionRun(auth.token, session, 'cancelled')
      bridgeSessions.delete(sessionName)
      sendJson(res, 200, { ok: true, session: sessionName, reset: true })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/freebuff/login') {
      const body = await readJsonBody(req)
      const sessionName = safeSessionName(
        firstNonEmpty(body?.session, req.headers['x-freebuff-session']) ||
          CONFIG.loginSessionId,
      )
      const loginSession = await startLoginSession(
        sessionName,
        shouldResetSession(body, req.headers),
      )

      sendJson(res, 200, {
        ok: true,
        session: sessionName,
        authenticated: resolveAuthState().authenticated,
        loginUrl: loginSession.loginUrl,
        fingerprintId: loginSession.fingerprintId,
        expiresAt: loginSession.expiresAt,
        note: 'Open the login URL, complete the official Freebuff login flow, then poll /v1/freebuff/login/status.',
      })
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/freebuff/login/status') {
      const sessionName = safeSessionName(
        firstNonEmpty(
          req.headers['x-freebuff-session'],
          url.searchParams.get('session'),
        ) || CONFIG.loginSessionId,
      )
      sendJson(res, 200, await pollLoginSession(sessionName))
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
      const body = await readJsonBody(req)
      const promptText = [
        normalizeAnthropicSystem(body?.system),
        JSON.stringify(body?.messages || []),
        JSON.stringify(body?.tools || []),
      ]
        .filter(Boolean)
        .join('\n')

      sendJson(res, 200, {
        input_tokens: estimateTokens(promptText),
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      const body = await readJsonBody(req)
      const sessionName = resolveSessionName(body, req.headers, url)
      const anthropicMessage = await executeAnthropicRequest({
        sessionName,
        body,
        headers: req.headers,
        url,
      })

      if (body.stream === true) {
        sendAnthropicSse(res, anthropicMessage)
        return
      }

      sendJson(res, 200, anthropicMessage)
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const body = await readJsonBody(req)
      const sessionName = resolveSessionName(body, req.headers, url)
      const payload = await executeOpenAIRequest({
        sessionName,
        body,
        headers: req.headers,
      })

      if (body.stream === true) {
        sendOpenAISse(res, payload)
        return
      }

      sendJson(res, 200, payload)
      return
    }

    sendJson(res, 404, {
      error: {
        message: `No route for ${req.method} ${url.pathname}`,
        type: 'not_found_error',
      },
    })
  } catch (error) {
    const statusCode =
      typeof error?.statusCode === 'number' ? error.statusCode : 500

    sendJson(res, statusCode, {
      error: {
        message: error?.message || 'Unknown error',
        type: statusCode === 401 ? 'authentication_error' : 'server_error',
      },
    })
  }
})

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(
    `Freebuff bridge listening on http://${CONFIG.host}:${CONFIG.port} using cwd ${CONFIG.cwd}, model ${runtimeConfig.modelAlias}, agent ${runtimeConfig.agentId}`,
  )
})
