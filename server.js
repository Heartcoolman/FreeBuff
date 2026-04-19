import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const CONFIG = {
  port: Number(process.env.PORT || 8765),
  host: process.env.HOST || '127.0.0.1',
  cwd: process.env.FREEBUFF_CWD || process.cwd(),
  defaultModel: process.env.FREEBUFF_MODEL || 'freebuff-bridge',
  defaultAgentId: process.env.FREEBUFF_AGENT_ID || 'base2-free',
  defaultMode:
    process.env.FREEBUFF_MODE ||
    process.env.FREEBUFF_COST_MODE ||
    'free',
  defaultSessionId: process.env.FREEBUFF_SESSION_ID || 'default',
  loginSessionId: process.env.FREEBUFF_LOGIN_SESSION_ID || 'login',
  responseTimeoutMs: Number(process.env.FREEBUFF_RESPONSE_TIMEOUT_MS || 180_000),
  loginBaseUrl: process.env.FREEBUFF_LOGIN_BASE_URL || 'https://freebuff.com',
  apiBaseUrl: process.env.FREEBUFF_API_BASE_URL || 'https://www.codebuff.com',
  usageHistoryLimit: Number(process.env.FREEBUFF_USAGE_HISTORY_LIMIT || 500),
  allowPaidModeFallback:
    process.env.FREEBUFF_ALLOW_PAID_MODE_FALLBACK === '1' ||
    process.env.FREEBUFF_ALLOW_PAID_MODE_FALLBACK === 'true',
}

const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(APP_DIR, 'public')
const RUN_DIR = path.join(APP_DIR, 'run')

const CHATGPT_WEB_DEFAULT_CHROME =
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

function readBooleanEnv(name, fallback = false) {
  const raw = process.env[name]
  if (raw == null) {
    return fallback
  }
  return raw === '1' || raw === 'true'
}

const EXPERIMENTAL_CONFIG = {
  enabled: readBooleanEnv('CHATGPT_WEB_EXPERIMENTAL_ENABLED', true),
  modelAlias:
    process.env.CHATGPT_WEB_MODEL_ALIAS || 'chatgpt-web-experimental',
  targetModel:
    process.env.CHATGPT_WEB_TARGET_MODEL || 'GPT-5.4 Pro',
  baseUrl: process.env.CHATGPT_WEB_BASE_URL || 'https://chatgpt.com',
  loginUrl:
    process.env.CHATGPT_WEB_LOGIN_URL || 'https://chatgpt.com/auth/login',
  chromeExecutable:
    process.env.CHATGPT_WEB_CHROME_EXECUTABLE || CHATGPT_WEB_DEFAULT_CHROME,
  profileDir:
    process.env.CHATGPT_WEB_PROFILE_DIR ||
    path.join(RUN_DIR, 'chatgpt-web-profile'),
  sessionStorePath:
    process.env.CHATGPT_WEB_SESSION_STORE ||
    path.join(RUN_DIR, 'chatgpt-web-sessions.json'),
  timeoutMs: Number(process.env.CHATGPT_WEB_TIMEOUT_MS || 300_000),
  debuggingPort: Number(process.env.CHATGPT_WEB_DEBUGGING_PORT || 9222),
  headless: readBooleanEnv('CHATGPT_WEB_HEADLESS', false),
  debug: readBooleanEnv('CHATGPT_WEB_DEBUG', false),
}

const experimentalBridgeSessions = new Map()
const experimentalPages = new Map()
let experimentalSessionsLoaded = false
let experimentalBrowser = null
let experimentalBrowserContext = null
let experimentalBrowserContextPromise = null
let experimentalChromeProcess = null
let experimentalQueue = Promise.resolve()
let experimentalQueueDepth = 0
const experimentalRuntime = {
  browserStarted: false,
  authenticated: false,
  lastError: null,
  lastErrorCode: null,
  lastObservedAt: null,
  lastResponseAt: null,
}

// --- Structured logger ---
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const LOG_LEVEL = LOG_LEVELS[process.env.FREEBUFF_LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info

function log(level, component, msg, fields = null) {
  if (LOG_LEVELS[level] < LOG_LEVEL) return
  const entry = { ts: new Date().toISOString(), level, component, msg }
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null) entry[k] = v
    }
  }
  process.stdout.write(JSON.stringify(entry) + '\n')
}

const logger = {
  debug: (component, msg, fields) => log('debug', component, msg, fields),
  info:  (component, msg, fields) => log('info', component, msg, fields),
  warn:  (component, msg, fields) => log('warn', component, msg, fields),
  error: (component, msg, fields) => log('error', component, msg, fields),
}

const MODE_DEFINITIONS = {
  free: {
    value: 'free',
    label: 'Free',
    agentId: 'base2-free',
    description: '免费优先模式，适合日常桥接与多账号轮训。',
  },
  default: {
    value: 'default',
    label: 'Default',
    agentId: 'base2',
    description: '通用默认模式，平衡速度、稳定性和规划能力。',
  },
  lite: {
    value: 'lite',
    label: 'Lite',
    agentId: 'base2-lite',
    description: '更轻更快，适合小修改、快速迭代和低开销任务。',
  },
  max: {
    value: 'max',
    label: 'Max',
    agentId: 'base2-max',
    description: '更强推理与更重规划，适合复杂改动。',
  },
  plan: {
    value: 'plan',
    label: 'Plan',
    agentId: 'base2-plan',
    description: '偏规划与方案推演，适合先出计划再执行的场景。',
  },
}

const MODE_ALIASES = {
  normal: 'default',
  ask: 'lite',
}

function normalizeMode(rawMode) {
  if (typeof rawMode !== 'string' || !rawMode.trim()) {
    return null
  }

  const normalized = rawMode.trim().toLowerCase()
  return MODE_DEFINITIONS[normalized]
    ? normalized
    : MODE_ALIASES[normalized] || null
}

function inferModeFromAgentId(agentId) {
  if (typeof agentId !== 'string' || !agentId.trim()) {
    return null
  }

  const normalizedAgentId = agentId.trim()
  return (
    Object.values(MODE_DEFINITIONS).find(
      (mode) => mode.agentId === normalizedAgentId,
    )?.value || null
  )
}

function getAgentIdForMode(mode) {
  return MODE_DEFINITIONS[mode]?.agentId || MODE_DEFINITIONS.free.agentId
}

const initialMode =
  normalizeMode(CONFIG.defaultMode) ||
  inferModeFromAgentId(CONFIG.defaultAgentId) ||
  'free'

const runtimeConfig = {
  modelAlias: CONFIG.defaultModel,
  agentId: CONFIG.defaultAgentId || getAgentIdForMode(initialMode),
  costMode: initialMode,
  backendModel: process.env.FREEBUFF_BACKEND_MODEL || 'z-ai/glm-5.1',
  allowPaidModeFallback: CONFIG.allowPaidModeFallback,
}

const FREE_BACKEND_MODELS = [
  { value: 'z-ai/glm-5.1', label: 'GLM 5.1', provider: 'Z.AI / Fireworks' },
  { value: 'minimax/minimax-m2.7', label: 'MiniMax M2.7', provider: 'MiniMax' },
]

if (!inferModeFromAgentId(runtimeConfig.agentId)) {
  runtimeConfig.agentId = getAgentIdForMode(runtimeConfig.costMode)
}

let openRouterModelsCache = null
let openRouterModelsCachedAt = 0
const OPENROUTER_MODELS_TTL = 60 * 60 * 1000

async function getOpenRouterModels() {
  const now = Date.now()
  if (openRouterModelsCache && now - openRouterModelsCachedAt < OPENROUTER_MODELS_TTL) {
    return openRouterModelsCache
  }
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models')
    if (!res.ok) return openRouterModelsCache ?? []
    const json = await res.json()
    openRouterModelsCache = (json.data || []).map((m) => ({
      value: m.id,
      label: m.name || m.id,
      provider: m.id.split('/')[0] || '',
    }))
    openRouterModelsCachedAt = now
    return openRouterModelsCache
  } catch {
    return openRouterModelsCache ?? []
  }
}

const sessionLocks = new Map()
const bridgeSessions = new Map()
const loginSessions = new Map()
const usageRecords = []
const accountRuntimeStats = new Map()
let accountRotationCursor = 0

// --- Backend connectivity & account liveness cache ---
const serverStartTime = Date.now()
const HEALTH_CACHE_TTL = 60_000
const backendLiveness = { checkedAt: 0, ok: false, latencyMs: 0, status: null, error: null }
const accountLivenessCache = new Map() // accountId -> { checkedAt, ok, latencyMs, status, error }

async function probeBackendConnectivity() {
  const now = Date.now()
  if (now - backendLiveness.checkedAt < HEALTH_CACHE_TTL) return backendLiveness
  const startedAt = now
  try {
    const res = await fetch(`${CONFIG.apiBaseUrl}/api/v1/agent-runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'START', agentId: 'health-probe', ancestorRunIds: [] }),
      signal: AbortSignal.timeout(10_000),
    })
    backendLiveness.checkedAt = Date.now()
    backendLiveness.ok = res.ok || res.status === 401 || res.status === 403
    backendLiveness.latencyMs = backendLiveness.checkedAt - startedAt
    backendLiveness.status = res.status
    backendLiveness.error = null
  } catch (err) {
    backendLiveness.checkedAt = Date.now()
    backendLiveness.ok = false
    backendLiveness.latencyMs = backendLiveness.checkedAt - startedAt
    backendLiveness.status = null
    backendLiveness.error = err?.message || String(err)
  }
  return backendLiveness
}

async function probeAccountLiveness(account) {
  const now = Date.now()
  const cached = accountLivenessCache.get(account.accountId)
  if (cached && now - cached.checkedAt < HEALTH_CACHE_TTL) return cached
  const startedAt = now
  try {
    const res = await fetch(`${CONFIG.apiBaseUrl}/api/v1/agent-runs`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${account.authToken}`,
        'x-codebuff-api-key': account.authToken,
      },
      body: JSON.stringify({ action: 'START', agentId: 'health-probe', ancestorRunIds: [] }),
      signal: AbortSignal.timeout(10_000),
    })
    // 200 = valid, 401/403 = token invalid, other = still reachable
    const ok = res.status !== 401 && res.status !== 403
    let text = ''
    try { text = await res.text() } catch {}
    const result = { checkedAt: Date.now(), ok, latencyMs: Date.now() - startedAt, status: res.status, error: ok ? null : `HTTP ${res.status}` }
    accountLivenessCache.set(account.accountId, result)
    return result
  } catch (err) {
    const result = { checkedAt: Date.now(), ok: false, latencyMs: Date.now() - startedAt, status: null, error: err?.message || String(err) }
    accountLivenessCache.set(account.accountId, result)
    return result
  }
}

function buildSystemMetrics() {
  const mem = process.memoryUsage()
  return {
    uptimeSeconds: Math.round((Date.now() - serverStartTime) / 1000),
    memory: { rss: mem.rss, heapTotal: mem.heapTotal, heapUsed: mem.heapUsed, external: mem.external },
    pid: process.pid,
    nodeVersion: process.version,
  }
}

function buildAccountPoolHealth(now = Date.now()) {
  const accounts = listAuthAccounts()
  const available = listAvailableAccounts()
  let coolingDown = 0
  const modeUnavailability = {}
  const accountSummaries = accounts.map((acct) => {
    const stats = accountRuntimeStats.get(acct.accountId)
    const isCoolingDown = stats?.cooldownUntilMs && stats.cooldownUntilMs > now
    if (isCoolingDown) coolingDown += 1
    const modes = stats?.unavailableModes || {}
    const unavailableModeCount = Object.keys(modes).length
    for (const mode of Object.keys(modes)) {
      modeUnavailability[mode] = (modeUnavailability[mode] || 0) + 1
    }
    return {
      accountId: acct.accountId,
      email: acct.email,
      ok: acct.authenticated && !isCoolingDown,
      isCoolingDown: Boolean(isCoolingDown),
      unavailableModeCount,
      lastFailureReason: stats?.lastFailureReason || null,
    }
  })
  const recent = usageRecords.slice(0, 20)
  const errorCount = recent.filter((r) => r.errorSummary).length
  const recentErrorRate = recent.length > 0 ? Math.round((errorCount / recent.length) * 100) : 0
  return {
    totalAccounts: accounts.length,
    availableAccounts: available.length,
    coolingDownAccounts: coolingDown,
    modeUnavailability,
    recentErrorRate,
    accounts: accountSummaries,
  }
}

function computeHealthStatus(opts = {}) {
  const { backendOk, backendCacheFresh } = opts
  const accounts = listAuthAccounts()
  const available = listAvailableAccounts()
  const anyAuthenticated = accounts.some((a) => a.authenticated)

  if (!anyAuthenticated) return 'unhealthy'
  if (backendOk === false) return 'unhealthy'
  if (available.length === 0) return 'unhealthy'

  const now = Date.now()
  const allCoolingDown = accounts.every((acct) => {
    const stats = accountRuntimeStats.get(acct.accountId)
    return stats?.cooldownUntilMs && stats.cooldownUntilMs > now
  })
  if (allCoolingDown) return 'unhealthy'

  // degraded conditions
  if (backendOk == null && !backendCacheFresh) return 'degraded'
  const pool = buildAccountPoolHealth(now)
  if (pool.recentErrorRate > 30) return 'degraded'
  if (pool.coolingDownAccounts > 0) return 'degraded'
  if (available.length < accounts.length && accounts.length > 1) return 'degraded'

  return 'healthy'
}

const ACCOUNT_STATS_WINDOW = 5
const ACCOUNT_COOLDOWN_MS = 45_000
const ACCOUNT_SELECTION_RECENCY_MS = 12_000
const ACCOUNT_SLOW_TPS_THRESHOLD = 8
const ACCOUNT_SLOW_DURATION_MS = 7_500

process.on('uncaughtException', (error) => {
  logger.error('process', 'uncaughtException', { error: error?.message, stack: error?.stack })
})

process.on('unhandledRejection', (error) => {
  logger.error('process', 'unhandledRejection', { error: error?.message, stack: error?.stack })
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

function safeExperimentalSessionName(raw) {
  const normalized = String(raw || CONFIG.defaultSessionId).replace(
    /[^a-zA-Z0-9_-]/g,
    '-',
  )
  return normalized.startsWith('chatgpt-web-experimental-')
    ? normalized
    : `chatgpt-web-experimental-${normalized}`
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function stableAccountId(...parts) {
  const seed = firstNonEmpty(...parts, randomUUID())
  return `acct-${createHash('sha1').update(seed).digest('hex').slice(0, 12)}`
}

function normalizeStoredAccount(record) {
  if (!record || typeof record !== 'object') {
    return null
  }

  const authToken =
    typeof record.authToken === 'string' ? record.authToken.trim() : ''
  if (!authToken) {
    return null
  }

  const email =
    typeof record.email === 'string' && record.email.trim()
      ? record.email.trim()
      : null
  const externalId = firstNonEmpty(record.userId, record.id, email, authToken)
  const createdAt =
    typeof record.createdAt === 'string' && record.createdAt
      ? record.createdAt
      : new Date().toISOString()
  const updatedAt =
    typeof record.updatedAt === 'string' && record.updatedAt
      ? record.updatedAt
      : createdAt

  return {
    ...record,
    accountId:
      typeof record.accountId === 'string' && record.accountId.trim()
        ? record.accountId.trim()
        : stableAccountId(externalId),
    authToken,
    email,
    source: 'credentials',
    authenticated: true,
    createdAt,
    updatedAt,
  }
}

function serializeStoredAccount(account) {
  const next = { ...account }
  delete next.authenticated
  delete next.readOnly
  next.source = 'credentials'
  return next
}

function readStoredAccountsState() {
  const raw = readCredentialsFile()
  const candidates = []

  if (Array.isArray(raw.accounts)) {
    candidates.push(...raw.accounts)
  }

  if (raw.default && typeof raw.default === 'object') {
    candidates.push(raw.default)
  }

  const seen = new Set()
  const accounts = []
  for (const candidate of candidates) {
    const normalized = normalizeStoredAccount(candidate)
    if (!normalized || seen.has(normalized.accountId)) {
      continue
    }
    seen.add(normalized.accountId)
    accounts.push(normalized)
  }

  return {
    raw,
    accounts,
  }
}

function writeStoredAccounts(accounts) {
  const credentialsPath = getCredentialsPath()
  const current = readStoredAccountsState().raw
  const nextAccounts = accounts.map((account) => serializeStoredAccount(account))
  const next = {
    ...current,
    accounts: nextAccounts,
  }

  if (nextAccounts[0]) {
    next.default = nextAccounts[0]
  } else {
    delete next.default
    delete next.accounts
  }

  if (Object.keys(next).length === 0) {
    if (fs.existsSync(credentialsPath)) {
      fs.unlinkSync(credentialsPath)
    }
    return
  }

  writeCredentialsFile(next)
}

function getStoredAccounts() {
  return readStoredAccountsState().accounts
}

function buildEnvironmentAccount() {
  const envToken = firstNonEmpty(
    process.env.CODEBUFF_API_KEY,
    process.env.FREEBUFF_AUTH_TOKEN,
  )
  if (!envToken) {
    return null
  }

  return {
    accountId: 'env-default',
    authToken: envToken,
    email: null,
    source: 'environment',
    authenticated: true,
    readOnly: true,
    createdAt: null,
    updatedAt: null,
  }
}

function listAuthAccounts() {
  const accounts = []
  const envAccount = buildEnvironmentAccount()
  if (envAccount) {
    accounts.push(envAccount)
  }

  accounts.push(
    ...getStoredAccounts().map((account) => ({
      ...account,
      readOnly: false,
    })),
  )

  return accounts
}

function getAccountById(accountId) {
  if (!accountId) {
    return null
  }

  return listAuthAccounts().find((account) => account.accountId === accountId) || null
}

function listAvailableAccounts(excludedAccountIds = []) {
  const excluded = new Set(excludedAccountIds.filter(Boolean))
  return listAuthAccounts().filter(
    (account) =>
      account.authenticated &&
      typeof account.authToken === 'string' &&
      account.authToken &&
      !excluded.has(account.accountId),
  )
}

function pickRotatingItem(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return null
  }

  const index = accountRotationCursor % items.length
  accountRotationCursor = (accountRotationCursor + 1) % items.length
  return items[index]
}

function selectNextAccount(excludedAccountIds = []) {
  return pickRotatingItem(listAvailableAccounts(excludedAccountIds))
}

function getOrCreateAccountRuntimeStats(accountId) {
  if (!accountId) {
    return null
  }

  let stats = accountRuntimeStats.get(accountId)
  if (!stats) {
    stats = {
      recentSuccesses: [],
      unavailableModes: {},
      selectionCount: 0,
      lastSelectedAtMs: 0,
      lastSuccessAtMs: 0,
      lastFailureAtMs: 0,
      lastFailureReason: null,
      lastFailureLevel: null,
      cooldownUntilMs: 0,
      consecutiveSlowCount: 0,
    }
    accountRuntimeStats.set(accountId, stats)
  }

  return stats
}

function removeAccountRuntimeStats(accountId) {
  if (!accountId) {
    return
  }

  accountRuntimeStats.delete(accountId)
}

function toRoundedTps(value) {
  return Number.isFinite(value) ? Number(value.toFixed(1)) : 0
}

function buildAccountRuntimeSummary(accountId, now = Date.now()) {
  const stats = accountRuntimeStats.get(accountId)
  const successes = Array.isArray(stats?.recentSuccesses) ? stats.recentSuccesses : []
  const sampleCount = successes.length
  const avgTps =
    sampleCount > 0
      ? toRoundedTps(
          successes.reduce((sum, item) => sum + (item.tps || 0), 0) / sampleCount,
        )
      : 0
  const avgDurationMs =
    sampleCount > 0
      ? Math.round(
          successes.reduce((sum, item) => sum + (item.durationMs || 0), 0) /
            sampleCount,
        )
      : 0
  const latest = successes[0] || null

  return {
    sampleCount,
    avgTps,
    avgDurationMs,
    latestTps: latest ? toRoundedTps(latest.tps || 0) : 0,
    latestDurationMs: latest?.durationMs || 0,
    selectionCount: stats?.selectionCount || 0,
    lastSelectedAt: stats?.lastSelectedAtMs
      ? new Date(stats.lastSelectedAtMs).toISOString()
      : null,
    lastSelectedAtMs: stats?.lastSelectedAtMs || 0,
    lastSuccessAt: stats?.lastSuccessAtMs
      ? new Date(stats.lastSuccessAtMs).toISOString()
      : null,
    lastSuccessAtMs: stats?.lastSuccessAtMs || 0,
    lastFailureAt: stats?.lastFailureAtMs
      ? new Date(stats.lastFailureAtMs).toISOString()
      : null,
    lastFailureAtMs: stats?.lastFailureAtMs || 0,
    lastFailureReason: stats?.lastFailureReason || null,
    lastFailureLevel: stats?.lastFailureLevel || null,
    cooldownUntil:
      stats?.cooldownUntilMs && stats.cooldownUntilMs > 0
        ? new Date(stats.cooldownUntilMs).toISOString()
        : null,
    cooldownUntilMs: stats?.cooldownUntilMs || 0,
    isCoolingDown: Boolean(stats?.cooldownUntilMs && stats.cooldownUntilMs > now),
    consecutiveSlowCount: stats?.consecutiveSlowCount || 0,
    unavailableModes: stats?.unavailableModes || {},
  }
}

function markAccountSelected(accountId, selectedAtMs = Date.now()) {
  const stats = getOrCreateAccountRuntimeStats(accountId)
  if (!stats) {
    return
  }

  stats.selectionCount += 1
  stats.lastSelectedAtMs = selectedAtMs
}

function markAccountSuccess(
  accountId,
  { durationMs = 0, outputTokens = 0, reason = 'success', mode = null } = {},
) {
  const stats = getOrCreateAccountRuntimeStats(accountId)
  if (!stats) {
    return buildAccountRuntimeSummary(accountId)
  }

  const now = Date.now()
  const tps =
    outputTokens > 0 && durationMs > 0 ? outputTokens / (durationMs / 1000) : 0
  stats.recentSuccesses.unshift({
    durationMs,
    outputTokens,
    tps,
    reason,
    createdAtMs: now,
  })
  if (stats.recentSuccesses.length > ACCOUNT_STATS_WINDOW) {
    stats.recentSuccesses.length = ACCOUNT_STATS_WINDOW
  }

  stats.lastSuccessAtMs = now
  stats.lastFailureReason = null
  stats.lastFailureLevel = null
  stats.cooldownUntilMs = 0
  if (mode) {
    delete stats.unavailableModes?.[mode]
  }
  if (tps < ACCOUNT_SLOW_TPS_THRESHOLD || durationMs > ACCOUNT_SLOW_DURATION_MS) {
    stats.consecutiveSlowCount += 1
  } else {
    stats.consecutiveSlowCount = 0
  }

  return buildAccountRuntimeSummary(accountId, now)
}

function markAccountFailure(
  accountId,
  reason = 'request_failed',
  cooldownMs = ACCOUNT_COOLDOWN_MS,
  level = 'retryable',
) {
  const stats = getOrCreateAccountRuntimeStats(accountId)
  if (!stats) {
    return buildAccountRuntimeSummary(accountId)
  }

  const now = Date.now()
  stats.lastFailureAtMs = now
  stats.lastFailureReason = reason
  stats.lastFailureLevel = level
  stats.cooldownUntilMs = cooldownMs > 0 ? now + cooldownMs : 0

  return buildAccountRuntimeSummary(accountId, now)
}

function markAccountModeUnavailable(accountId, mode, reason = 'mode_unavailable') {
  const stats = getOrCreateAccountRuntimeStats(accountId)
  if (!stats || !mode) {
    return buildAccountRuntimeSummary(accountId)
  }

  if (!stats.unavailableModes || typeof stats.unavailableModes !== 'object') {
    stats.unavailableModes = {}
  }

  const now = Date.now()
  stats.unavailableModes[mode] = {
    reason,
    updatedAtMs: now,
  }
  stats.lastFailureAtMs = now
  stats.lastFailureReason = reason
  stats.lastFailureLevel = 'blocking'
  stats.cooldownUntilMs = 0

  return buildAccountRuntimeSummary(accountId, now)
}

function markAccountBlocked(accountId, reason = 'request_blocked') {
  return markAccountFailure(accountId, reason, 0, 'blocking')
}

function isAccountModeUnavailable(accountId, mode) {
  if (!accountId || !mode) {
    return false
  }

  const stats = accountRuntimeStats.get(accountId)
  return Boolean(stats?.unavailableModes?.[mode])
}

function describeSelectionReason(kind, account, summary) {
  if (kind === 'cold_start') {
    return `Cold-start sample for ${account.email || account.accountId}`
  }

  if (kind === 'retry') {
    return `Retry on ${account.email || account.accountId}`
  }

  const pieces = []
  if (summary.avgTps > 0) {
    pieces.push(`avg ${summary.avgTps} t/s`)
  }
  if (summary.avgDurationMs > 0) {
    pieces.push(`avg ${summary.avgDurationMs}ms`)
  }
  if (summary.consecutiveSlowCount > 0) {
    pieces.push(`${summary.consecutiveSlowCount} slow streak`)
  }
  return pieces.length > 0
    ? `Performance selection: ${pieces.join(', ')}`
    : `Performance selection for ${account.email || account.accountId}`
}

function scoreAccountCandidate(summary, now) {
  let score = summary.sampleCount > 0 ? summary.avgTps : -0.5
  score -= summary.avgDurationMs / 10_000
  score -= Math.min(summary.consecutiveSlowCount, 3) * 0.75

  if (
    summary.lastSelectedAtMs > 0 &&
    now - summary.lastSelectedAtMs < ACCOUNT_SELECTION_RECENCY_MS
  ) {
    score -= 0.9
  }

  if (summary.isCoolingDown) {
    score -= 4
  }

  if (
    summary.lastFailureAtMs > 0 &&
    now - summary.lastFailureAtMs < ACCOUNT_COOLDOWN_MS * 2
  ) {
    score -= 1.2
  }

  return Number(score.toFixed(3))
}

function selectAccountForRequest(session, excludedAccountIds = [], strategy = 'performance') {
  const availableAccounts = listAvailableAccounts(excludedAccountIds)
  if (availableAccounts.length === 0) {
    return null
  }

  const now = Date.now()
  const mode = session?.costMode || runtimeConfig.costMode
  const candidates = availableAccounts.map((account) => {
    const summary = buildAccountRuntimeSummary(account.accountId, now)
    return {
      account,
      summary,
      score: scoreAccountCandidate(summary, now),
    }
  })

  const modeEligibleCandidates = candidates.filter(
    (candidate) => !isAccountModeUnavailable(candidate.account.accountId, mode),
  )
  if (modeEligibleCandidates.length === 0) {
    return null
  }

  const activeCandidates = modeEligibleCandidates.filter(
    (candidate) => !candidate.summary.isCoolingDown,
  )
  const pool = activeCandidates.length > 0 ? activeCandidates : modeEligibleCandidates
  const coldStartCandidates = pool.filter(
    (candidate) =>
      candidate.summary.sampleCount === 0 && candidate.summary.lastSelectedAtMs === 0,
  )

  const previousAccount = getSessionBoundAccount(session)
  if (coldStartCandidates.length > 0) {
    const selected = pickRotatingItem(coldStartCandidates)
    return {
      account: selected.account,
      previousAccountId: previousAccount?.accountId || null,
      score: selected.score,
      summary: selected.summary,
      strategy,
      reason: describeSelectionReason('cold_start', selected.account, selected.summary),
    }
  }

  pool.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score
    }
    if (right.summary.avgTps !== left.summary.avgTps) {
      return right.summary.avgTps - left.summary.avgTps
    }
    if (left.summary.avgDurationMs !== right.summary.avgDurationMs) {
      return left.summary.avgDurationMs - right.summary.avgDurationMs
    }
    return left.summary.lastSelectedAtMs - right.summary.lastSelectedAtMs
  })

  const selected = pool[0]
  return {
    account: selected.account,
    previousAccountId: previousAccount?.accountId || null,
    score: selected.score,
    summary: selected.summary,
    strategy,
    reason: describeSelectionReason(strategy, selected.account, selected.summary),
  }
}

function summarizeAuthPool(accounts = listAuthAccounts()) {
  const availableAccounts = accounts.filter(
    (account) => account.authenticated && account.authToken,
  )
  const primary =
    availableAccounts.length === 1
      ? availableAccounts[0]
      : null

  return {
    authenticated: availableAccounts.length > 0,
    source: primary ? primary.source : availableAccounts.length > 1 ? 'pool' : null,
    email: primary ? primary.email : null,
    totalAccounts: accounts.length,
    availableAccounts: availableAccounts.length,
    environmentAccountPresent: accounts.some(
      (account) => account.source === 'environment',
    ),
  }
}

function upsertStoredAccount(user, loginSession = null) {
  const { accounts } = readStoredAccountsState()
  const existing = accounts.find(
    (account) =>
      (firstNonEmpty(account.id) &&
        firstNonEmpty(user?.id) &&
        firstNonEmpty(account.id) === firstNonEmpty(user?.id)) ||
      (account.email && user?.email && account.email === user.email),
  )

  const nextAccount = normalizeStoredAccount({
    ...(existing || {}),
    ...(user || {}),
    accountId: existing?.accountId || stableAccountId(user?.id, user?.email),
    fingerprintId:
      loginSession?.fingerprintId ||
      firstNonEmpty(user?.fingerprintId, existing?.fingerprintId) ||
      null,
    fingerprintHash:
      loginSession?.fingerprintHash ||
      firstNonEmpty(user?.fingerprintHash, existing?.fingerprintHash) ||
      null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  if (!nextAccount) {
    throw new Error('Failed to normalize account credentials.')
  }

  const remaining = accounts.filter(
    (account) => account.accountId !== nextAccount.accountId,
  )
  writeStoredAccounts([nextAccount, ...remaining])
  return nextAccount
}

function removeStoredAccount(accountId) {
  const { accounts } = readStoredAccountsState()
  const nextAccounts = accounts.filter((account) => account.accountId !== accountId)
  const removed = nextAccounts.length !== accounts.length
  if (removed) {
    writeStoredAccounts(nextAccounts)
  }
  return removed
}

function resolveAuthState() {
  return summarizeAuthPool()
}

async function getRuntimeConfig() {
  const mode = runtimeConfig.costMode
  const availableBackendModels =
    mode === 'free' ? FREE_BACKEND_MODELS : await getOpenRouterModels()
  return {
    modelAlias: runtimeConfig.modelAlias,
    mode,
    modeLabel: MODE_DEFINITIONS[mode]?.label || mode,
    modeDescription: MODE_DEFINITIONS[mode]?.description || '',
    availableModes: Object.values(MODE_DEFINITIONS).map((item) => ({
      value: item.value,
      label: item.label,
      description: item.description,
      agentId: item.agentId,
    })),
    agentId: runtimeConfig.agentId,
    costMode: mode,
    backendModel: runtimeConfig.backendModel,
    allowPaidModeFallback: runtimeConfig.allowPaidModeFallback === true,
    availableBackendModels,
  }
}

function getSessionBoundAccount(session) {
  return session?.accountId ? getAccountById(session.accountId) : null
}

function getAccountPresentation(account) {
  if (!account) {
    return {
      accountId: null,
      accountEmail: null,
      accountSource: null,
    }
  }

  return {
    accountId: account.accountId,
    accountEmail: account.email,
    accountSource: account.source,
  }
}

function resetSessionRunState(session, reason = null) {
  if (!session) {
    return
  }

  session.runId = null
  session.updatedAt = new Date().toISOString()
  session.lastError = reason
  clearFreebuffSession(session)
}

function bindSessionToAccount(session, account, reason = null) {
  if (!session || !account) {
    return null
  }

  if (session.accountId !== account.accountId) {
    session.accountId = account.accountId
    session.lastAccountSwitchAt = new Date().toISOString()
    session.lastAccountSwitchReason = reason
  }

  session.updatedAt = new Date().toISOString()
  bridgeSessions.set(session.session, session)
  return account
}

async function assignSessionToAccount(session, account, reason = null) {
  if (!session || !account) {
    return {
      account: null,
      previousAccount: getSessionBoundAccount(session),
      switched: false,
    }
  }

  const previousAccount = getSessionBoundAccount(session)
  const switched = previousAccount?.accountId !== account.accountId
  if (switched && previousAccount) {
    logger.info('session', 'account switched', { session: session.session, from: previousAccount.accountId, to: account.accountId, reason })
    await finishSessionRun(previousAccount.authToken, session, 'cancelled')
    resetSessionRunState(session, reason || 'Account switched.')
  }

  bindSessionToAccount(session, account, reason)
  return {
    account,
    previousAccount,
    switched,
  }
}

async function releaseSessionsForAccount(accountId, status = 'cancelled') {
  const sessions = Array.from(bridgeSessions.values()).filter(
    (session) => session.accountId === accountId,
  )

  await Promise.allSettled(
    sessions.map(async (session) => {
      const account = getSessionBoundAccount(session)
      await finishSessionRun(account?.authToken, session, status)
      bridgeSessions.delete(session.session)
    }),
  )
}

function clearLoginSessionsForAccount(accountId) {
  for (const [sessionName, session] of loginSessions.entries()) {
    if (session?.accountId === accountId) {
      loginSessions.delete(sessionName)
    }
  }
}

function buildAuthPresentation(sessionName = null) {
  const auth = resolveAuthState()
  const session = sessionName ? bridgeSessions.get(sessionName) : null
  const boundAccount = getSessionBoundAccount(session)

  return {
    ...auth,
    authSource: boundAccount?.source || auth.source,
    email: boundAccount?.email || auth.email,
    boundAccountId: boundAccount?.accountId || null,
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
    logger.error('session', 'finishSessionRun failed', { runId: session.runId, error: error?.message })
  }

  if (session?.costMode === 'free' && session?.freebuffInstanceId) {
    try {
      await deleteFreebuffSession(authToken, session.freebuffInstanceId)
      clearFreebuffSession(session)
    } catch (error) {
      logger.error('session', 'deleteFreebuffSession failed', { session: session.session, instanceId: session.freebuffInstanceId, error: error?.message })
    }
  }
}

async function finishAllSessions(status = 'cancelled') {
  const sessions = Array.from(bridgeSessions.values())
  await Promise.allSettled(
    sessions.map((session) => {
      const account = getSessionBoundAccount(session)
      return finishSessionRun(account?.authToken, session, status)
    }),
  )
}

async function applyRuntimeConfig(updates = {}) {
  const previous = await getRuntimeConfig()

  if (typeof updates.modelAlias === 'string' && updates.modelAlias.trim()) {
    runtimeConfig.modelAlias = updates.modelAlias.trim()
  }

  const userSetAgentId = typeof updates.agentId === 'string' && updates.agentId.trim()
  const nextMode = normalizeMode(updates.mode ?? updates.costMode)
  if (nextMode) {
    const prevMode = runtimeConfig.costMode
    runtimeConfig.costMode = nextMode
    if (!userSetAgentId || nextMode !== prevMode) {
      runtimeConfig.agentId = getAgentIdForMode(nextMode)
    }
  } else if (userSetAgentId) {
    const legacyAgentId = updates.agentId.trim()
    runtimeConfig.agentId = legacyAgentId
    const inferredMode = inferModeFromAgentId(legacyAgentId)
    if (inferredMode) {
      runtimeConfig.costMode = inferredMode
    }
  }

  if (typeof updates.backendModel === 'string' && updates.backendModel.trim()) {
    const nextModel = updates.backendModel.trim()
    if (runtimeConfig.costMode === 'free') {
      const isAllowed = FREE_BACKEND_MODELS.some((m) => m.value === nextModel)
      if (!isAllowed) {
        throw Object.assign(
          new Error(`Unsupported backend model for free mode: ${nextModel}`),
          { statusCode: 400 },
        )
      }
    }
    runtimeConfig.backendModel = nextModel
  }

  if (updates.allowPaidModeFallback != null) {
    runtimeConfig.allowPaidModeFallback =
      updates.allowPaidModeFallback === true ||
      updates.allowPaidModeFallback === 'true' ||
      updates.allowPaidModeFallback === '1'
  }

  const next = await getRuntimeConfig()
  const changed =
    previous.modelAlias !== next.modelAlias ||
    previous.mode !== next.mode ||
    previous.agentId !== next.agentId ||
    previous.backendModel !== next.backendModel ||
    previous.allowPaidModeFallback !== next.allowPaidModeFallback

  if (changed) {
    logger.info('config', 'runtime config changed, resetting sessions', {
      modelAlias: `${previous.modelAlias} -> ${next.modelAlias}`,
      mode: `${previous.mode} -> ${next.mode}`,
      agentId: `${previous.agentId} -> ${next.agentId}`,
      backendModel: `${previous.backendModel} -> ${next.backendModel}`,
      allowPaidModeFallback: `${previous.allowPaidModeFallback} -> ${next.allowPaidModeFallback}`,
    })
    await finishAllSessions('cancelled')
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
    'title',
    'description',
    'properties',
    'patternProperties',
    'required',
    'items',
    'prefixItems',
    'contains',
    'additionalProperties',
    'propertyNames',
    'dependentRequired',
    'dependentSchemas',
    'enum',
    'const',
    'oneOf',
    'anyOf',
    'allOf',
    'not',
    '$ref',
    '$defs',
    'definitions',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'minItems',
    'maxItems',
    'uniqueItems',
    'minContains',
    'maxContains',
    'minLength',
    'maxLength',
    'pattern',
    'default',
    'examples',
    'deprecated',
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

    if (
      (key === 'patternProperties' ||
        key === '$defs' ||
        key === 'definitions' ||
        key === 'dependentSchemas') &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      next[key] = Object.fromEntries(
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

function deepEqual(left, right) {
  if (left === right) {
    return true
  }

  if (typeof left !== typeof right) {
    return false
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) {
      return false
    }

    return left.every((item, index) => deepEqual(item, right[index]))
  }

  if (
    left &&
    right &&
    typeof left === 'object' &&
    typeof right === 'object'
  ) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) {
      return false
    }

    return leftKeys.every(
      (key) => rightKeys.includes(key) && deepEqual(left[key], right[key]),
    )
  }

  return false
}

function inferValueType(value) {
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    return 'array'
  }
  if (Number.isInteger(value)) {
    return 'integer'
  }
  return typeof value
}

function matchesSchemaType(schemaType, value, nullable) {
  if (value === null) {
    return schemaType === 'null' || nullable === true
  }

  if (Array.isArray(schemaType)) {
    return schemaType.some((item) => matchesSchemaType(item, value, nullable))
  }

  if (!schemaType) {
    return true
  }

  if (schemaType === 'integer') {
    return Number.isInteger(value)
  }

  if (schemaType === 'array') {
    return Array.isArray(value)
  }

  if (schemaType === 'object') {
    return typeof value === 'object' && value != null && !Array.isArray(value)
  }

  return typeof value === schemaType
}

function validateAgainstSchema(schema, value, path = []) {
  if (!schema || typeof schema !== 'object') {
    return []
  }

  const errors = []
  const schemaType = schema.type
  const nullable = schema.nullable === true

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push({
      path,
      message: 'Value does not match const',
    })
    return errors
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const matchesEnum = schema.enum.some((item) => deepEqual(item, value))
    if (!matchesEnum) {
      errors.push({
        path,
        message: 'Value is not in enum',
      })
      return errors
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    for (const childSchema of schema.allOf) {
      errors.push(...validateAgainstSchema(childSchema, value, path))
    }
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const matchesAny = schema.anyOf.some(
      (childSchema) => validateAgainstSchema(childSchema, value, path).length === 0,
    )
    if (!matchesAny) {
      errors.push({
        path,
        message: 'Value does not satisfy anyOf',
      })
      return errors
    }
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    const matchesOne = schema.oneOf.filter(
      (childSchema) => validateAgainstSchema(childSchema, value, path).length === 0,
    ).length
    if (matchesOne !== 1) {
      errors.push({
        path,
        message: 'Value does not satisfy exactly one branch of oneOf',
      })
      return errors
    }
  }

  if (schema.not && validateAgainstSchema(schema.not, value, path).length === 0) {
    errors.push({
      path,
      message: 'Value matches forbidden schema',
    })
    return errors
  }

  if (!matchesSchemaType(schemaType, value, nullable)) {
    errors.push({
      path,
      message: `Expected ${Array.isArray(schemaType) ? schemaType.join('|') : schemaType || inferValueType(value)}`,
    })
    return errors
  }

  const valueType = inferValueType(value)

  if (valueType === 'object') {
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
    const patternProperties =
      schema.patternProperties && typeof schema.patternProperties === 'object'
        ? schema.patternProperties
        : {}
    const knownKeys = new Set(Object.keys(properties))

    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in value) {
        errors.push(...validateAgainstSchema(childSchema, value[key], [...path, key]))
      }
    }

    for (const [pattern, childSchema] of Object.entries(patternProperties)) {
      const regex = new RegExp(pattern)
      for (const [key, childValue] of Object.entries(value)) {
        if (regex.test(key)) {
          knownKeys.add(key)
          errors.push(...validateAgainstSchema(childSchema, childValue, [...path, key]))
        }
      }
    }

    if (schema.propertyNames && typeof schema.propertyNames === 'object') {
      for (const key of Object.keys(value)) {
        errors.push(
          ...validateAgainstSchema(schema.propertyNames, key, [...path, key]),
        )
      }
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!knownKeys.has(key)) {
          errors.push({
            path: [...path, key],
            message: 'Unexpected property',
          })
        }
      }
    } else if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === 'object'
    ) {
      for (const [key, childValue] of Object.entries(value)) {
        if (!knownKeys.has(key)) {
          errors.push(
            ...validateAgainstSchema(
              schema.additionalProperties,
              childValue,
              [...path, key],
            ),
          )
        }
      }
    }

    if (
      schema.dependentRequired &&
      typeof schema.dependentRequired === 'object' &&
      !Array.isArray(schema.dependentRequired)
    ) {
      for (const [key, dependencies] of Object.entries(schema.dependentRequired)) {
        if (!(key in value) || !Array.isArray(dependencies)) {
          continue
        }
        for (const dependency of dependencies) {
          if (!(dependency in value)) {
            errors.push({
              path: [...path, dependency],
              message: `Missing dependent property for ${key}`,
            })
          }
        }
      }
    }

    if (
      schema.dependentSchemas &&
      typeof schema.dependentSchemas === 'object' &&
      !Array.isArray(schema.dependentSchemas)
    ) {
      for (const [key, dependentSchema] of Object.entries(schema.dependentSchemas)) {
        if (key in value) {
          errors.push(...validateAgainstSchema(dependentSchema, value, path))
        }
      }
    }

    return errors
  }

  if (valueType === 'array') {
    if (
      typeof schema.minItems === 'number' &&
      value.length < schema.minItems
    ) {
      errors.push({
        path,
        message: `Expected at least ${schema.minItems} item(s)`,
      })
    }

    if (
      typeof schema.maxItems === 'number' &&
      value.length > schema.maxItems
    ) {
      errors.push({
        path,
        message: `Expected at most ${schema.maxItems} item(s)`,
      })
    }

    if (schema.uniqueItems === true) {
      const seen = new Set()
      for (const item of value) {
        const serialized = JSON.stringify(item)
        if (seen.has(serialized)) {
          errors.push({
            path,
            message: 'Expected unique items',
          })
          break
        }
        seen.add(serialized)
      }
    }

    if (Array.isArray(schema.prefixItems) && schema.prefixItems.length > 0) {
      schema.prefixItems.forEach((childSchema, index) => {
        if (index < value.length) {
          errors.push(...validateAgainstSchema(childSchema, value[index], [...path, index]))
        }
      })
    }

    if (schema.items && typeof schema.items === 'object') {
      value.forEach((item, index) => {
        errors.push(...validateAgainstSchema(schema.items, item, [...path, index]))
      })
    }

    if (schema.contains && typeof schema.contains === 'object') {
      const matchingCount = value.filter(
        (item, index) =>
          validateAgainstSchema(schema.contains, item, [...path, index]).length === 0,
      ).length
      if (
        typeof schema.minContains === 'number' &&
        matchingCount < schema.minContains
      ) {
        errors.push({
          path,
          message: `Expected at least ${schema.minContains} matching item(s)`,
        })
      }
      if (
        typeof schema.maxContains === 'number' &&
        matchingCount > schema.maxContains
      ) {
        errors.push({
          path,
          message: `Expected at most ${schema.maxContains} matching item(s)`,
        })
      }
      if (
        schema.minContains == null &&
        schema.maxContains == null &&
        matchingCount === 0
      ) {
        errors.push({
          path,
          message: 'Expected at least one matching item',
        })
      }
    }
    return errors
  }

  if (valueType === 'string') {
    if (
      typeof schema.minLength === 'number' &&
      value.length < schema.minLength
    ) {
      errors.push({ path, message: `Expected at least ${schema.minLength} character(s)` })
    }
    if (
      typeof schema.maxLength === 'number' &&
      value.length > schema.maxLength
    ) {
      errors.push({ path, message: `Expected at most ${schema.maxLength} character(s)` })
    }
    if (typeof schema.pattern === 'string') {
      const regex = new RegExp(schema.pattern)
      if (!regex.test(value)) {
        errors.push({ path, message: 'Value does not match pattern' })
      }
    }
  } else if (valueType === 'number' || valueType === 'integer') {
    if (
      typeof schema.minimum === 'number' &&
      value < schema.minimum
    ) {
      errors.push({ path, message: `Expected minimum ${schema.minimum}` })
    }
    if (
      typeof schema.maximum === 'number' &&
      value > schema.maximum
    ) {
      errors.push({ path, message: `Expected maximum ${schema.maximum}` })
    }
    if (
      typeof schema.exclusiveMinimum === 'number' &&
      value <= schema.exclusiveMinimum
    ) {
      errors.push({ path, message: `Expected greater than ${schema.exclusiveMinimum}` })
    }
    if (
      typeof schema.exclusiveMaximum === 'number' &&
      value >= schema.exclusiveMaximum
    ) {
      errors.push({ path, message: `Expected less than ${schema.exclusiveMaximum}` })
    }
    if (
      typeof schema.multipleOf === 'number' &&
      schema.multipleOf !== 0 &&
      value % schema.multipleOf !== 0
    ) {
      errors.push({ path, message: `Expected multiple of ${schema.multipleOf}` })
    }
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

const CHATGPT_WEB_PROMPT_SELECTORS = [
  '#prompt-textarea',
  'textarea#prompt-textarea',
  'textarea[placeholder*="Message"]',
  'div[contenteditable="true"][data-testid="prompt-textarea"]',
  'div[contenteditable="true"][data-placeholder]',
]

const CHATGPT_WEB_SEND_SELECTORS = [
  'button[data-testid="send-button"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="发送"]',
]

const CHATGPT_WEB_STOP_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[aria-label*="Stop"]',
  'button[aria-label*="停止"]',
]

const CHATGPT_WEB_LOGIN_SELECTORS = [
  'input[type="email"]',
  'input[name="email"]',
  'button[data-testid="login-button"]',
  'a[href*="/auth/login"]',
  'a[href*="/login"]',
]

const CHATGPT_WEB_ASSISTANT_SELECTORS = [
  '[data-message-author-role="assistant"]',
  'article[data-testid*="conversation-turn"]',
]

const CHATGPT_WEB_MODEL_PICKER_SELECTORS = [
  'button[data-testid="model-switcher-dropdown-button"]',
  'button[aria-haspopup="menu"]',
  'button[aria-label*="model"]',
]

function buildExperimentalModelsResponse() {
  return {
    data: [
      {
        type: 'model',
        id: EXPERIMENTAL_CONFIG.modelAlias,
        display_name: EXPERIMENTAL_CONFIG.modelAlias,
        created_at: '2026-04-18T00:00:00Z',
      },
    ],
    has_more: false,
    first_id: EXPERIMENTAL_CONFIG.modelAlias,
    last_id: EXPERIMENTAL_CONFIG.modelAlias,
  }
}

function createExperimentalError(
  message,
  statusCode = 500,
  errorCode = 'chatgpt_web_error',
  errorType = null,
) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.errorCode = errorCode
  error.errorType =
    errorType ||
    (statusCode === 401
      ? 'authentication_error'
      : statusCode === 400
        ? 'invalid_request_error'
        : statusCode === 404
          ? 'not_found_error'
          : statusCode === 409
            ? 'invalid_request_error'
            : statusCode === 504
              ? 'timeout_error'
              : 'server_error')
  return error
}

function noteExperimentalError(error) {
  experimentalRuntime.lastError = error?.message || 'Unknown experimental bridge error.'
  experimentalRuntime.lastErrorCode = error?.errorCode || 'chatgpt_web_error'
  experimentalRuntime.lastObservedAt = new Date().toISOString()
}

function clearExperimentalError() {
  experimentalRuntime.lastError = null
  experimentalRuntime.lastErrorCode = null
  experimentalRuntime.lastObservedAt = new Date().toISOString()
}

function ensureExperimentalEnabled() {
  if (!EXPERIMENTAL_CONFIG.enabled) {
    throw createExperimentalError(
      'ChatGPT 网页实验桥当前未启用。',
      404,
      'chatgpt_web_disabled',
      'not_found_error',
    )
  }
}

function ensureExperimentalDirs() {
  fs.mkdirSync(RUN_DIR, { recursive: true })
  fs.mkdirSync(EXPERIMENTAL_CONFIG.profileDir, { recursive: true })
  fs.mkdirSync(path.dirname(EXPERIMENTAL_CONFIG.sessionStorePath), {
    recursive: true,
  })
}

function experimentalModelSlug() {
  return EXPERIMENTAL_CONFIG.targetModel
    .toLowerCase()
    .replace(/\s+/g, '-')
}

function buildExperimentalConversationStartUrl() {
  const url = new URL('/', EXPERIMENTAL_CONFIG.baseUrl)
  url.searchParams.set('model', experimentalModelSlug())
  return url.toString()
}

function normalizeExperimentalTranscriptState(transcript) {
  const systemText =
    typeof transcript?.systemText === 'string'
      ? stripTrailingWhitespace(transcript.systemText)
      : ''
  const messages = Array.isArray(transcript?.messages)
    ? transcript.messages
        .map((message) => ({
          role: message?.role === 'assistant' ? 'assistant' : 'user',
          text:
            typeof message?.text === 'string'
              ? stripTrailingWhitespace(message.text)
              : '',
        }))
        .filter((message) => message.text)
    : []

  return {
    systemText,
    messages,
  }
}

function createExperimentalSessionRecord(sessionName) {
  const now = new Date().toISOString()
  return {
    session: sessionName,
    conversationUrl: null,
    transcript: normalizeExperimentalTranscriptState(null),
    createdAt: now,
    updatedAt: now,
    lastRequestAt: null,
    lastResponseAt: null,
    lastError: null,
  }
}

function normalizeExperimentalSessionRecord(record) {
  if (!record || typeof record !== 'object') {
    return null
  }

  return {
    session: safeExperimentalSessionName(record.session),
    conversationUrl:
      typeof record.conversationUrl === 'string' && record.conversationUrl.trim()
        ? record.conversationUrl.trim()
        : null,
    transcript: normalizeExperimentalTranscriptState(record.transcript),
    createdAt:
      typeof record.createdAt === 'string' && record.createdAt
        ? record.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof record.updatedAt === 'string' && record.updatedAt
        ? record.updatedAt
        : new Date().toISOString(),
    lastRequestAt:
      typeof record.lastRequestAt === 'string' && record.lastRequestAt
        ? record.lastRequestAt
        : null,
    lastResponseAt:
      typeof record.lastResponseAt === 'string' && record.lastResponseAt
        ? record.lastResponseAt
        : null,
    lastError:
      typeof record.lastError === 'string' && record.lastError
        ? record.lastError
        : null,
  }
}

function loadExperimentalSessionsFromDisk() {
  ensureExperimentalDirs()
  experimentalBridgeSessions.clear()
  if (!fs.existsSync(EXPERIMENTAL_CONFIG.sessionStorePath)) {
    experimentalSessionsLoaded = true
    return
  }

  try {
    const raw = JSON.parse(
      fs.readFileSync(EXPERIMENTAL_CONFIG.sessionStorePath, 'utf8'),
    )
    const records = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.sessions)
        ? raw.sessions
        : []
    for (const record of records) {
      const normalized = normalizeExperimentalSessionRecord(record)
      if (normalized) {
        experimentalBridgeSessions.set(normalized.session, normalized)
      }
    }
    experimentalSessionsLoaded = true
  } catch (error) {
    experimentalSessionsLoaded = true
    noteExperimentalError(
      createExperimentalError(
        `读取 ChatGPT 网页实验会话失败：${error?.message || '未知错误'}`,
        500,
        'chatgpt_web_session_store_invalid',
      ),
    )
  }
}

function ensureExperimentalSessionsLoaded() {
  if (!experimentalSessionsLoaded) {
    loadExperimentalSessionsFromDisk()
  }
}

function saveExperimentalSessionsToDisk() {
  ensureExperimentalDirs()
  const sessions = Array.from(experimentalBridgeSessions.values()).map(
    (session) => ({
      session: session.session,
      conversationUrl: session.conversationUrl,
      transcript: session.transcript,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastRequestAt: session.lastRequestAt,
      lastResponseAt: session.lastResponseAt,
      lastError: session.lastError,
    }),
  )
  fs.writeFileSync(
    EXPERIMENTAL_CONFIG.sessionStorePath,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        sessions,
      },
      null,
      2,
    ),
  )
}

function getOrCreateExperimentalSession(sessionName) {
  ensureExperimentalSessionsLoaded()
  let session = experimentalBridgeSessions.get(sessionName)
  if (!session) {
    session = createExperimentalSessionRecord(sessionName)
    experimentalBridgeSessions.set(sessionName, session)
    saveExperimentalSessionsToDisk()
  }
  return session
}

function persistExperimentalSession(session, updates = {}) {
  const next = {
    ...session,
    ...updates,
    updatedAt: new Date().toISOString(),
  }
  experimentalBridgeSessions.set(next.session, next)
  saveExperimentalSessionsToDisk()
  return next
}

async function disposeExperimentalPage(sessionName) {
  const page = experimentalPages.get(sessionName)
  experimentalPages.delete(sessionName)
  if (page && !page.isClosed()) {
    await page.close().catch(() => {})
  }
}

async function resetExperimentalSessionState(sessionName, removeRecord = false) {
  ensureExperimentalSessionsLoaded()
  await disposeExperimentalPage(sessionName)
  if (removeRecord) {
    experimentalBridgeSessions.delete(sessionName)
  } else {
    const current = getOrCreateExperimentalSession(sessionName)
    persistExperimentalSession(current, {
      conversationUrl: null,
      transcript: normalizeExperimentalTranscriptState(null),
      lastError: null,
      lastRequestAt: null,
      lastResponseAt: null,
    })
  }
  saveExperimentalSessionsToDisk()
}

function listExperimentalSessions() {
  ensureExperimentalSessionsLoaded()
  return Array.from(experimentalBridgeSessions.values())
    .sort((left, right) => left.session.localeCompare(right.session))
    .map((session) => ({
      session: session.session,
      conversationUrl: session.conversationUrl,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      lastRequestAt: session.lastRequestAt,
      lastResponseAt: session.lastResponseAt,
      lastError: session.lastError,
      historyLength: session.transcript.messages.length,
      pageOpen:
        experimentalPages.has(session.session) &&
        !experimentalPages.get(session.session)?.isClosed(),
    }))
}

function withExperimentalQueue(work) {
  experimentalQueueDepth += 1
  const current = experimentalQueue
    .catch(() => {})
    .then(work)
    .finally(() => {
      experimentalQueueDepth = Math.max(0, experimentalQueueDepth - 1)
    })
  experimentalQueue = current
  return current
}

function resetExperimentalBrowserState() {
  experimentalBrowser = null
  experimentalBrowserContext = null
  experimentalBrowserContextPromise = null
  experimentalRuntime.browserStarted = false
  experimentalRuntime.authenticated = false
  experimentalPages.clear()
}

function buildExperimentalCdpBaseUrl() {
  return `http://127.0.0.1:${EXPERIMENTAL_CONFIG.debuggingPort}`
}

async function waitForExperimentalCdpEndpoint(timeoutMs = 15_000) {
  const startedAt = Date.now()
  const endpoint = `${buildExperimentalCdpBaseUrl()}/json/version`
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(2_000),
      })
      if (response.ok) {
        return endpoint
      }
    } catch {}
    await delay(250)
  }

  throw createExperimentalError(
    '启动 Chrome 调试端口超时。',
    500,
    'chatgpt_web_debugging_port_timeout',
  )
}

function buildExperimentalChromeArgs() {
  const args = [
    `--remote-debugging-port=${EXPERIMENTAL_CONFIG.debuggingPort}`,
    `--user-data-dir=${EXPERIMENTAL_CONFIG.profileDir}`,
    '--no-first-run',
    '--disable-dev-shm-usage',
    '--disable-blink-features=AutomationControlled',
    '--new-window',
    EXPERIMENTAL_CONFIG.loginUrl,
  ]
  if (EXPERIMENTAL_CONFIG.headless) {
    args.unshift('--headless=new')
  }
  return args
}

function startExperimentalChromeProcess() {
  if (experimentalChromeProcess) {
    return experimentalChromeProcess
  }

  experimentalChromeProcess = spawn(
    EXPERIMENTAL_CONFIG.chromeExecutable,
    buildExperimentalChromeArgs(),
    {
      stdio: EXPERIMENTAL_CONFIG.debug ? 'inherit' : 'ignore',
      detached: false,
    },
  )

  experimentalChromeProcess.once('exit', () => {
    experimentalChromeProcess = null
    resetExperimentalBrowserState()
  })

  experimentalChromeProcess.once('error', () => {
    experimentalChromeProcess = null
    resetExperimentalBrowserState()
  })

  return experimentalChromeProcess
}

async function connectExperimentalBrowserContext() {
  await waitForExperimentalCdpEndpoint()
  const browser = await chromium.connectOverCDP(buildExperimentalCdpBaseUrl())
  const context = browser.contexts()[0]
  if (!context) {
    await browser.close().catch(() => {})
    throw createExperimentalError(
      '连接 Chrome 成功，但没有拿到默认浏览器上下文。',
      500,
      'chatgpt_web_missing_context',
    )
  }

  experimentalBrowser = browser
  experimentalBrowserContext = context
  experimentalRuntime.browserStarted = true

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    })
  }).catch(() => {})

  const pages = context.pages()
  for (const page of pages) {
    page.setDefaultTimeout(EXPERIMENTAL_CONFIG.timeoutMs)
    page.setDefaultNavigationTimeout(EXPERIMENTAL_CONFIG.timeoutMs)
  }

  context.on('page', (page) => {
    page.setDefaultTimeout(EXPERIMENTAL_CONFIG.timeoutMs)
    page.setDefaultNavigationTimeout(EXPERIMENTAL_CONFIG.timeoutMs)
  })

  browser.on('disconnected', () => {
    resetExperimentalBrowserState()
  })

  return context
}

async function ensureExperimentalBrowserContext() {
  ensureExperimentalEnabled()
  ensureExperimentalDirs()

  if (experimentalBrowserContext) {
    experimentalRuntime.browserStarted = true
    return experimentalBrowserContext
  }

  if (experimentalBrowserContextPromise) {
    return experimentalBrowserContextPromise
  }

  if (!fs.existsSync(EXPERIMENTAL_CONFIG.chromeExecutable)) {
    throw createExperimentalError(
      `找不到 Chrome 可执行文件：${EXPERIMENTAL_CONFIG.chromeExecutable}`,
      500,
      'chatgpt_web_chrome_missing',
    )
  }

  experimentalBrowserContextPromise = (async () => {
    try {
      try {
        return await connectExperimentalBrowserContext()
      } catch {
        startExperimentalChromeProcess()
        return await connectExperimentalBrowserContext()
      }
    } catch (error) {
      resetExperimentalBrowserState()
      throw createExperimentalError(
        `启动 ChatGPT 网页实验桥失败：${error?.message || '未知错误'}`,
        500,
        'chatgpt_web_browser_start_failed',
      )
    }
  })()
    .catch((error) => {
      experimentalBrowserContextPromise = null
      throw error
    })

  return experimentalBrowserContextPromise
}

async function getExperimentalStatusPage(navigateIfBlank = true) {
  const context = await ensureExperimentalBrowserContext()
  let page = context.pages().find((candidate) => !candidate.isClosed()) || null
  if (!page) {
    page = await context.newPage()
  }
  await page.setViewportSize({ width: 1440, height: 960 }).catch(() => {})
  page.setDefaultTimeout(EXPERIMENTAL_CONFIG.timeoutMs)
  page.setDefaultNavigationTimeout(EXPERIMENTAL_CONFIG.timeoutMs)
  if (navigateIfBlank && (!page.url() || page.url() === 'about:blank')) {
    await page.goto(EXPERIMENTAL_CONFIG.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: EXPERIMENTAL_CONFIG.timeoutMs,
    })
  }
  return page
}

async function findExperimentalSelector(page, selectors) {
  return page
    .evaluate((selectorList) => {
      const isVisible = (element) => {
        if (!element) {
          return false
        }
        const rect = element.getBoundingClientRect()
        const style = window.getComputedStyle(element)
        return (
          style &&
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width >= 0 &&
          rect.height >= 0
        )
      }

      for (const selector of selectorList) {
        try {
          const element = document.querySelector(selector)
          if (isVisible(element) || element) {
            return selector
          }
        } catch {}
      }
      return null
    }, selectors)
    .catch(() => null)
}

async function pageBodyIncludes(page, text) {
  return page
    .evaluate((needle) => {
      return (document.body?.innerText || '').includes(needle)
    }, text)
    .catch(() => false)
}

async function isExperimentalChallengePage(page) {
  const title = await page.title().catch(() => '')
  if (title.includes('请稍候') || title.toLowerCase().includes('just a moment')) {
    return true
  }
  return (
    (await pageBodyIncludes(page, '请稍候')) ||
    (await pageBodyIncludes(page, 'Checking your browser')) ||
    (await pageBodyIncludes(page, 'Verify you are human'))
  )
}

async function waitForExperimentalPromptOrLogin(page) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < Math.min(20_000, EXPERIMENTAL_CONFIG.timeoutMs)) {
    if (await isExperimentalChallengePage(page)) {
      return {
        authenticated: false,
        challengeBlocked: true,
      }
    }

    const promptSelector = await findExperimentalSelector(
      page,
      CHATGPT_WEB_PROMPT_SELECTORS,
    )
    if (promptSelector) {
      return {
        authenticated: true,
        promptSelector,
      }
    }

    const loginSelector = await findExperimentalSelector(
      page,
      CHATGPT_WEB_LOGIN_SELECTORS,
    )
    if (loginSelector) {
      return {
        authenticated: false,
        loginSelector,
      }
    }

    await delay(500)
  }

  return {
    authenticated: false,
    promptSelector: null,
    loginSelector: null,
    challengeBlocked: false,
  }
}

async function probeExperimentalAuthentication({ openHome = false } = {}) {
  ensureExperimentalEnabled()
  if (!experimentalBrowserContext && !openHome) {
    return false
  }

  const page = await getExperimentalStatusPage(openHome)
  if (!openHome && (!page.url() || page.url() === 'about:blank')) {
    experimentalRuntime.browserStarted = true
    experimentalRuntime.authenticated = false
    experimentalRuntime.lastObservedAt = new Date().toISOString()
    return false
  }

  if (openHome && !page.url().startsWith(EXPERIMENTAL_CONFIG.baseUrl)) {
    await page.goto(EXPERIMENTAL_CONFIG.loginUrl, {
      waitUntil: 'domcontentloaded',
      timeout: EXPERIMENTAL_CONFIG.timeoutMs,
    })
  }

  const authState = await waitForExperimentalPromptOrLogin(page)
  experimentalRuntime.browserStarted = true
  experimentalRuntime.authenticated = authState.authenticated === true
  experimentalRuntime.lastObservedAt = new Date().toISOString()
  return authState.authenticated === true
}

async function ensureExperimentalAuthenticatedPage(page) {
  const authState = await waitForExperimentalPromptOrLogin(page)
  experimentalRuntime.browserStarted = true
  experimentalRuntime.authenticated = authState.authenticated === true
  experimentalRuntime.lastObservedAt = new Date().toISOString()
  if (authState.authenticated && authState.promptSelector) {
    return authState.promptSelector
  }
  if (authState.challengeBlocked) {
    throw createExperimentalError(
      'ChatGPT 当前把这个浏览器识别成受控环境，页面停在“请稍候”验证页，暂时无法完成登录。',
      409,
      'chatgpt_web_challenge_blocked',
    )
  }
  if (authState.loginSelector) {
    throw createExperimentalError(
      'ChatGPT 网页尚未登录，请先启动浏览器并手动完成登录。',
      401,
      'chatgpt_web_not_authenticated',
    )
  }
  throw createExperimentalError(
    'ChatGPT 页面结构可能已变化，暂时找不到输入区域。',
    502,
    'chatgpt_web_dom_changed',
  )
}

async function tryClickElementWithText(page, text) {
  return page
    .evaluate((needle) => {
      const candidates = Array.from(
        document.querySelectorAll(
          'button, [role="menuitem"], [role="option"], li, a, div',
        ),
      )
      const target = candidates.find((element) =>
        (element.textContent || '').trim().includes(needle),
      )
      if (!target) {
        return false
      }
      target.click()
      return true
    }, text)
    .catch(() => false)
}

async function ensureExperimentalModel(page) {
  const targetUrl = buildExperimentalConversationStartUrl()
  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: EXPERIMENTAL_CONFIG.timeoutMs,
  })

  await ensureExperimentalAuthenticatedPage(page)
  if (
    (await pageBodyIncludes(page, EXPERIMENTAL_CONFIG.targetModel)) ||
    page.url().includes(`model=${experimentalModelSlug()}`)
  ) {
    return
  }

  const pickerSelector = await findExperimentalSelector(
    page,
    CHATGPT_WEB_MODEL_PICKER_SELECTORS,
  )
  if (pickerSelector) {
    await page.click(pickerSelector).catch(() => {})
    await delay(500)
    await tryClickElementWithText(page, EXPERIMENTAL_CONFIG.targetModel)
    await delay(500)
  }

  if (
    !(await pageBodyIncludes(page, EXPERIMENTAL_CONFIG.targetModel)) &&
    !page.url().includes(`model=${experimentalModelSlug()}`)
  ) {
    throw createExperimentalError(
      `当前 ChatGPT 网页里找不到模型 ${EXPERIMENTAL_CONFIG.targetModel}。`,
      409,
      'chatgpt_web_model_unavailable',
    )
  }
}

async function getExperimentalPageForSession(
  session,
  forceFreshConversation = false,
) {
  const context = await ensureExperimentalBrowserContext()
  let page = experimentalPages.get(session.session)
  if (page && page.isClosed()) {
    experimentalPages.delete(session.session)
    page = null
  }

  if (forceFreshConversation && page) {
    await disposeExperimentalPage(session.session)
    page = null
  }

  if (!page) {
    page = await context.newPage()
    page.setDefaultTimeout(EXPERIMENTAL_CONFIG.timeoutMs)
    page.setDefaultNavigationTimeout(EXPERIMENTAL_CONFIG.timeoutMs)
    experimentalPages.set(session.session, page)
  }

  if (forceFreshConversation || !session.conversationUrl) {
    await ensureExperimentalModel(page)
  } else if (page.url() !== session.conversationUrl) {
    await page.goto(session.conversationUrl, {
      waitUntil: 'domcontentloaded',
      timeout: EXPERIMENTAL_CONFIG.timeoutMs,
    })
    await ensureExperimentalAuthenticatedPage(page)
  } else {
    await ensureExperimentalAuthenticatedPage(page)
  }

  await page.bringToFront().catch(() => {})
  return page
}

function createTextOnlyInputError() {
  return createExperimentalError(
    'ChatGPT 网页实验桥目前只支持纯文本输入，不支持工具、图片、文件或音频。',
    400,
    'chatgpt_web_text_only',
  )
}

function normalizeExperimentalAnthropicContent(content) {
  if (typeof content === 'string') {
    return stripTrailingWhitespace(content)
  }

  if (!Array.isArray(content)) {
    return ''
  }

  const parts = []
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    if (item?.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
      continue
    }
    throw createTextOnlyInputError()
  }
  return stripTrailingWhitespace(parts.join('\n'))
}

function normalizeExperimentalOpenAIContent(content) {
  if (typeof content === 'string') {
    return stripTrailingWhitespace(content)
  }

  if (!Array.isArray(content)) {
    return ''
  }

  const parts = []
  for (const item of content) {
    if (typeof item === 'string') {
      parts.push(item)
      continue
    }
    if (
      (item?.type === 'text' || item?.type === 'input_text') &&
      typeof item.text === 'string'
    ) {
      parts.push(item.text)
      continue
    }
    throw createTextOnlyInputError()
  }
  return stripTrailingWhitespace(parts.join('\n'))
}

function buildExperimentalAnthropicTranscript(body = {}) {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw createTextOnlyInputError()
  }
  if (body.tool_choice) {
    throw createTextOnlyInputError()
  }

  const transcript = {
    systemText: normalizeAnthropicSystem(body.system),
    messages: [],
  }

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message?.role !== 'user' && message?.role !== 'assistant') {
      if (message?.role === 'tool') {
        throw createTextOnlyInputError()
      }
      continue
    }

    const text = normalizeExperimentalAnthropicContent(message.content)
    if (text) {
      transcript.messages.push({
        role: message.role,
        text,
      })
    }
  }

  if (transcript.messages.length === 0) {
    throw createExperimentalError(
      'ChatGPT 网页实验桥至少需要一条文本消息。',
      400,
      'chatgpt_web_empty_prompt',
    )
  }

  return normalizeExperimentalTranscriptState(transcript)
}

function buildExperimentalOpenAITranscript(body = {}) {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    throw createTextOnlyInputError()
  }
  if (body.response_format) {
    throw createTextOnlyInputError()
  }

  const transcript = {
    systemText: '',
    messages: [],
  }

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
      throw createTextOnlyInputError()
    }
    if (message?.role === 'tool') {
      throw createTextOnlyInputError()
    }

    const text = normalizeExperimentalOpenAIContent(message?.content)
    if (!text) {
      continue
    }

    if (message.role === 'system' || message.role === 'developer') {
      transcript.systemText = [transcript.systemText, text]
        .filter(Boolean)
        .join('\n\n')
      continue
    }

    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }

    transcript.messages.push({
      role: message.role,
      text,
    })
  }

  if (transcript.messages.length === 0) {
    throw createExperimentalError(
      'ChatGPT 网页实验桥至少需要一条文本消息。',
      400,
      'chatgpt_web_empty_prompt',
    )
  }

  return normalizeExperimentalTranscriptState(transcript)
}

function transcriptStartsWith(previous, next) {
  if (!previous || !next) {
    return false
  }
  if ((previous.systemText || '') !== (next.systemText || '')) {
    return false
  }
  if (previous.messages.length > next.messages.length) {
    return false
  }
  return previous.messages.every(
    (message, index) =>
      message.role === next.messages[index]?.role &&
      message.text === next.messages[index]?.text,
  )
}

function buildReplayPrompt(transcript) {
  const sections = []
  if (transcript.systemText) {
    sections.push(`系统要求：\n${transcript.systemText}`)
  }
  sections.push(
    transcript.messages
      .map((message) => {
        const roleLabel = message.role === 'assistant' ? '助手' : '用户'
        return `${roleLabel}：\n${message.text}`
      })
      .join('\n\n'),
  )
  sections.push('请继续这段对话，并只输出下一条助手回复。不要解释这些角色标签。')
  return sections.filter(Boolean).join('\n\n')
}

function buildExperimentalPromptPlan(session, transcript) {
  const previous = normalizeExperimentalTranscriptState(session.transcript)
  const hasConversation = Boolean(session.conversationUrl)

  if (
    !hasConversation &&
    !previous.systemText &&
    previous.messages.length === 0 &&
    !transcript.systemText &&
    transcript.messages.length === 1 &&
    transcript.messages[0].role === 'user'
  ) {
    return {
      prompt: transcript.messages[0].text,
      resetConversation: false,
    }
  }

  if (!transcriptStartsWith(previous, transcript)) {
    return {
      prompt: buildReplayPrompt(transcript),
      resetConversation: hasConversation,
    }
  }

  const delta = transcript.messages.slice(previous.messages.length)
  if (delta.length === 1 && delta[0].role === 'user') {
    return {
      prompt: delta[0].text,
      resetConversation: false,
    }
  }

  return {
    prompt: buildReplayPrompt(transcript),
    resetConversation: hasConversation,
  }
}

async function setPromptText(page, selector, text) {
  const element = await page.$(selector)
  if (!element) {
    throw createExperimentalError(
      'ChatGPT 页面结构可能已变化，暂时找不到输入框。',
      502,
      'chatgpt_web_dom_changed',
    )
  }

  const tagName = await element.evaluate((node) => node.tagName.toLowerCase())
  if (tagName === 'textarea') {
    await page.fill(selector, text)
    return
  }

  await page.click(selector)
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+A`).catch(() => {})
  await page.keyboard.press('Backspace').catch(() => {})
  await page.keyboard.insertText(text)
}

async function submitExperimentalPrompt(page, prompt) {
  const promptSelector = await ensureExperimentalAuthenticatedPage(page)
  await setPromptText(page, promptSelector, prompt)

  const sendSelector = await findExperimentalSelector(
    page,
    CHATGPT_WEB_SEND_SELECTORS,
  )
  if (sendSelector) {
    await page.click(sendSelector).catch(() => {})
  } else {
    await page.keyboard.press('Enter')
  }
}

async function collectAssistantMessages(page) {
  return page
    .evaluate((selectors) => {
      const values = []
      const seen = new Set()
      for (const selector of selectors) {
        const nodes = Array.from(document.querySelectorAll(selector))
        for (const node of nodes) {
          const text = String(node.innerText || node.textContent || '')
            .replace(/\r/g, '')
            .trim()
          if (!text || seen.has(text)) {
            continue
          }
          seen.add(text)
          values.push(text)
        }
      }
      return values
    }, CHATGPT_WEB_ASSISTANT_SELECTORS)
    .catch(() => [])
}

async function hasExperimentalStopButton(page) {
  const selector = await findExperimentalSelector(page, CHATGPT_WEB_STOP_SELECTORS)
  return Boolean(selector)
}

async function captureExperimentalBaseline(page) {
  const assistantMessages = await collectAssistantMessages(page)
  return {
    count: assistantMessages.length,
    lastText: assistantMessages.at(-1) || '',
  }
}

async function captureExperimentalResponseSnapshot(page, baseline) {
  const assistantMessages = await collectAssistantMessages(page)
  const latestText = assistantMessages.at(-1) || ''
  const started =
    assistantMessages.length > baseline.count ||
    (assistantMessages.length === baseline.count &&
      latestText &&
      latestText !== baseline.lastText)

  return {
    started,
    text: started ? latestText : '',
    assistantCount: assistantMessages.length,
    generating: await hasExperimentalStopButton(page),
    conversationUrl: page.url(),
  }
}

function incrementalText(previous, next) {
  if (!next) {
    return ''
  }
  if (!previous) {
    return next
  }
  if (next.startsWith(previous)) {
    return next.slice(previous.length)
  }
  let index = 0
  while (
    index < previous.length &&
    index < next.length &&
    previous[index] === next[index]
  ) {
    index += 1
  }
  return next.slice(index)
}

async function waitForExperimentalResponse(page, baseline) {
  const startedAt = Date.now()
  let seenStart = false
  let previousText = ''
  let stablePolls = 0

  while (Date.now() - startedAt < EXPERIMENTAL_CONFIG.timeoutMs) {
    const snapshot = await captureExperimentalResponseSnapshot(page, baseline)
    if (snapshot.started) {
      seenStart = true
    }
    if (snapshot.text && snapshot.text !== previousText) {
      previousText = snapshot.text
      stablePolls = 0
    } else if (snapshot.text) {
      stablePolls += 1
    }

    if (seenStart && snapshot.text && !snapshot.generating && stablePolls >= 3) {
      return snapshot
    }

    await delay(700)
  }

  throw createExperimentalError(
    '等待 ChatGPT 网页响应超时。',
    504,
    'chatgpt_web_timeout',
  )
}

async function streamExperimentalResponse(page, baseline, onDelta) {
  const startedAt = Date.now()
  let seenStart = false
  let emittedText = ''
  let previousText = ''
  let stablePolls = 0

  while (Date.now() - startedAt < EXPERIMENTAL_CONFIG.timeoutMs) {
    const snapshot = await captureExperimentalResponseSnapshot(page, baseline)
    if (snapshot.started) {
      seenStart = true
    }

    if (snapshot.text) {
      const delta = incrementalText(emittedText, snapshot.text)
      if (delta) {
        emittedText = snapshot.text
        await onDelta(delta)
      }
    }

    if (snapshot.text && snapshot.text !== previousText) {
      previousText = snapshot.text
      stablePolls = 0
    } else if (snapshot.text) {
      stablePolls += 1
    }

    if (seenStart && snapshot.text && !snapshot.generating && stablePolls >= 3) {
      return {
        ...snapshot,
        text: emittedText || snapshot.text,
      }
    }

    await delay(600)
  }

  throw createExperimentalError(
    '等待 ChatGPT 网页流式响应超时。',
    504,
    'chatgpt_web_timeout',
  )
}

async function prepareExperimentalExecution(sessionName, transcript) {
  const session = getOrCreateExperimentalSession(sessionName)
  const promptPlan = buildExperimentalPromptPlan(session, transcript)
  if (promptPlan.resetConversation) {
    await resetExperimentalSessionState(sessionName, false)
  }

  const activeSession = getOrCreateExperimentalSession(sessionName)
  const page = await getExperimentalPageForSession(
    activeSession,
    promptPlan.resetConversation || !activeSession.conversationUrl,
  )
  const baseline = await captureExperimentalBaseline(page)
  await submitExperimentalPrompt(page, promptPlan.prompt)

  return {
    page,
    session: activeSession,
    baseline,
    promptText: promptPlan.prompt,
    startedAt: Date.now(),
  }
}

function buildTranscriptAfterResponse(transcript, responseText) {
  return normalizeExperimentalTranscriptState({
    systemText: transcript.systemText,
    messages: [
      ...transcript.messages,
      ...(responseText
        ? [
            {
              role: 'assistant',
              text: responseText,
            },
          ]
        : []),
    ],
  })
}

function finalizeExperimentalExecution(
  session,
  page,
  transcript,
  promptText,
  responseText,
  startedAt,
) {
  const updatedSession = persistExperimentalSession(session, {
    conversationUrl: page.url(),
    transcript: buildTranscriptAfterResponse(transcript, responseText),
    lastRequestAt: new Date(startedAt).toISOString(),
    lastResponseAt: new Date().toISOString(),
    lastError: null,
  })

  experimentalRuntime.lastResponseAt = updatedSession.lastResponseAt
  experimentalRuntime.browserStarted = true
  experimentalRuntime.authenticated = true
  clearExperimentalError()

  return {
    responseText,
    promptTokens: estimateTokens(promptText),
    outputTokens: estimateTokens(responseText),
    durationMs: Date.now() - startedAt,
    session: updatedSession,
  }
}

function buildExperimentalCompletionPayload(publicModel, result) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    created: Math.floor(Date.now() / 1000),
    model: publicModel,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: result.responseText,
        },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: result.promptTokens,
      completion_tokens: result.outputTokens,
      total_tokens: result.promptTokens + result.outputTokens,
    },
  }
}

async function executeExperimentalAnthropicRequest({ sessionName, body }) {
  return withExperimentalQueue(async () => {
    const publicModel = body.model || EXPERIMENTAL_CONFIG.modelAlias
    const transcript = buildExperimentalAnthropicTranscript(body)

    try {
      const execution = await prepareExperimentalExecution(sessionName, transcript)
      const snapshot = await waitForExperimentalResponse(
        execution.page,
        execution.baseline,
      )
      const result = finalizeExperimentalExecution(
        execution.session,
        execution.page,
        transcript,
        execution.promptText,
        snapshot.text,
        execution.startedAt,
      )
      return buildAnthropicResponseFromOpenAI(
        buildExperimentalCompletionPayload(publicModel, result),
        publicModel,
      )
    } catch (error) {
      const session = getOrCreateExperimentalSession(sessionName)
      persistExperimentalSession(session, {
        lastError: error?.message || 'Unknown experimental bridge error.',
      })
      noteExperimentalError(error)
      throw error
    }
  })
}

async function executeExperimentalOpenAIRequest({ sessionName, body }) {
  return withExperimentalQueue(async () => {
    const publicModel = body.model || EXPERIMENTAL_CONFIG.modelAlias
    const transcript = buildExperimentalOpenAITranscript(body)

    try {
      const execution = await prepareExperimentalExecution(sessionName, transcript)
      const snapshot = await waitForExperimentalResponse(
        execution.page,
        execution.baseline,
      )
      const result = finalizeExperimentalExecution(
        execution.session,
        execution.page,
        transcript,
        execution.promptText,
        snapshot.text,
        execution.startedAt,
      )
      return buildCompletionResponse(
        publicModel,
        buildExperimentalCompletionPayload(publicModel, result),
      )
    } catch (error) {
      const session = getOrCreateExperimentalSession(sessionName)
      persistExperimentalSession(session, {
        lastError: error?.message || 'Unknown experimental bridge error.',
      })
      noteExperimentalError(error)
      throw error
    }
  })
}

async function streamExperimentalAnthropicRequest(
  res,
  { sessionName, body },
) {
  return withExperimentalQueue(async () => {
    const publicModel = body.model || EXPERIMENTAL_CONFIG.modelAlias
    const transcript = buildExperimentalAnthropicTranscript(body)
    const execution = await prepareExperimentalExecution(sessionName, transcript)
    const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const writeEvent = (event, payload) => {
      const ok = res.write(
        `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`,
      )
      if (!ok) {
        return new Promise((resolve) => res.once('drain', resolve))
      }
    }

    await writeEvent('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: publicModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
        },
      },
    })
    await writeEvent('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: '',
      },
    })

    try {
      const snapshot = await streamExperimentalResponse(
        execution.page,
        execution.baseline,
        async (delta) => {
          await writeEvent('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: {
              type: 'text_delta',
              text: delta,
            },
          })
        },
      )

      const result = finalizeExperimentalExecution(
        execution.session,
        execution.page,
        transcript,
        execution.promptText,
        snapshot.text,
        execution.startedAt,
      )

      await writeEvent('content_block_stop', {
        type: 'content_block_stop',
        index: 0,
      })
      await writeEvent('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null,
        },
        usage: {
          output_tokens: result.outputTokens,
        },
      })
      await writeEvent('message_stop', {
        type: 'message_stop',
      })
      res.end()
    } catch (error) {
      const session = getOrCreateExperimentalSession(sessionName)
      persistExperimentalSession(session, {
        lastError: error?.message || 'Unknown experimental bridge error.',
      })
      noteExperimentalError(error)
      throw error
    }
  })
}

async function streamExperimentalOpenAIRequest(
  res,
  { sessionName, body },
) {
  return withExperimentalQueue(async () => {
    const publicModel = body.model || EXPERIMENTAL_CONFIG.modelAlias
    const transcript = buildExperimentalOpenAITranscript(body)
    const execution = await prepareExperimentalExecution(sessionName, transcript)
    const id = `chatcmpl-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    const writeChunk = (payload) => {
      const ok = res.write(`data: ${JSON.stringify(payload)}\n\n`)
      if (!ok) {
        return new Promise((resolve) => res.once('drain', resolve))
      }
    }

    await writeChunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: publicModel,
      choices: [
        {
          index: 0,
          delta: {
            role: 'assistant',
          },
          finish_reason: null,
        },
      ],
    })

    try {
      const snapshot = await streamExperimentalResponse(
        execution.page,
        execution.baseline,
        async (delta) => {
          await writeChunk({
            id,
            object: 'chat.completion.chunk',
            created,
            model: publicModel,
            choices: [
              {
                index: 0,
                delta: {
                  content: delta,
                },
                finish_reason: null,
              },
            ],
          })
        },
      )

      finalizeExperimentalExecution(
        execution.session,
        execution.page,
        transcript,
        execution.promptText,
        snapshot.text,
        execution.startedAt,
      )

      await writeChunk({
        id,
        object: 'chat.completion.chunk',
        created,
        model: publicModel,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
          },
        ],
      })
      res.write('data: [DONE]\n\n')
      res.end()
    } catch (error) {
      const session = getOrCreateExperimentalSession(sessionName)
      persistExperimentalSession(session, {
        lastError: error?.message || 'Unknown experimental bridge error.',
      })
      noteExperimentalError(error)
      throw error
    }
  })
}

function resolveExperimentalSessionName(body, headers, url) {
  return safeExperimentalSessionName(
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

async function buildExperimentalStatus({ probe = false } = {}) {
  ensureExperimentalSessionsLoaded()
  const browserStarted = Boolean(
    experimentalChromeProcess ||
      experimentalBrowser ||
      experimentalBrowserContext,
  )
  experimentalRuntime.browserStarted = browserStarted

  if (probe && browserStarted) {
    try {
      await probeExperimentalAuthentication()
    } catch (error) {
      noteExperimentalError(error)
    }
  }

  return {
    ok:
      EXPERIMENTAL_CONFIG.enabled &&
      browserStarted &&
      experimentalRuntime.authenticated,
    status: !EXPERIMENTAL_CONFIG.enabled
      ? 'disabled'
      : browserStarted
        ? experimentalRuntime.authenticated
          ? 'healthy'
          : 'degraded'
        : 'idle',
    enabled: EXPERIMENTAL_CONFIG.enabled,
    browserStarted,
    authenticated: experimentalRuntime.authenticated,
    modelAlias: EXPERIMENTAL_CONFIG.modelAlias,
    targetModel: EXPERIMENTAL_CONFIG.targetModel,
    baseUrl: EXPERIMENTAL_CONFIG.baseUrl,
    loginUrl: EXPERIMENTAL_CONFIG.loginUrl,
    chromeExecutable: EXPERIMENTAL_CONFIG.chromeExecutable,
    profileDir: EXPERIMENTAL_CONFIG.profileDir,
    sessionStorePath: EXPERIMENTAL_CONFIG.sessionStorePath,
    queueDepth: experimentalQueueDepth,
    sessionCount: experimentalBridgeSessions.size,
    lastError: experimentalRuntime.lastError,
    lastErrorCode: experimentalRuntime.lastErrorCode,
    lastObservedAt: experimentalRuntime.lastObservedAt,
    lastResponseAt: experimentalRuntime.lastResponseAt,
    sessions: listExperimentalSessions(),
  }
}

async function buildExperimentalHealth() {
  const status = await buildExperimentalStatus({ probe: true })
  return {
    ...status,
    host: CONFIG.host,
    port: CONFIG.port,
    cwd: CONFIG.cwd,
    compatibility: {
      protocol: 'anthropic-messages',
      supportsNativeTools: false,
      supportsMcpTools: false,
      supportsInstalledPluginTools: false,
      textOnly: true,
    },
  }
}

function createBridgeSession(sessionName) {
  const now = new Date().toISOString()
  return {
    session: sessionName,
    clientId: randomUUID(),
    fingerprintId: randomUUID(),
    accountId: null,
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
    lastAccountSwitchAt: null,
    lastAccountSwitchReason: null,
    // Freebuff session state (free mode only)
    freebuffInstanceId: null,
    freebuffSessionState: null,
    freebuffSessionCreatedAt: null,
    freebuffSessionUpdatedAt: null,
  }
}

function getOrCreateBridgeSession(sessionName) {
  let session = bridgeSessions.get(sessionName)
  if (!session) {
    session = createBridgeSession(sessionName)
    bridgeSessions.set(sessionName, session)
    logger.info('session', 'created', { session: sessionName })
  }
  return session
}

function buildCodebuffMetadata(session) {
  const metadata = {
    client_id: session.clientId,
    run_id: session.runId,
    cost_mode: session.costMode,
    n: session.n,
  }
  if (session.costMode === 'free' && session.freebuffInstanceId) {
    metadata.freebuff_instance_id = session.freebuffInstanceId
  }
  return metadata
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
      accountId: null,
      accountEmail: null,
      accountSource: null,
      lastAccountSwitchAt: null,
      lastAccountSwitchReason: null,
    }
  }

  const account = getSessionBoundAccount(session)
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
    lastAccountSwitchAt: session.lastAccountSwitchAt,
    lastAccountSwitchReason: session.lastAccountSwitchReason,
    ...getAccountPresentation(account),
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
      const account = getSessionBoundAccount(session)
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
        lastAccountSwitchAt: session?.lastAccountSwitchAt || null,
        lastAccountSwitchReason: session?.lastAccountSwitchReason || null,
        ...getAccountPresentation(account),
      }
    })
}

async function buildAdminOverview() {
  const accounts = listAuthAccounts()
  const auth = summarizeAuthPool(accounts)
  const sessions = listSessions()
  const boundSessionCounts = sessions.reduce((counts, session) => {
    if (session.accountId) {
      counts.set(session.accountId, (counts.get(session.accountId) || 0) + 1)
    }
    return counts
  }, new Map())
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
      totalAccounts: auth.totalAccounts,
      availableAccounts: auth.availableAccounts,
      environmentAccountPresent: auth.environmentAccountPresent,
    },
    accounts: accounts.map((account) => ({
      ...buildAccountRuntimeSummary(account.accountId),
      accountId: account.accountId,
      email: account.email,
      source: account.source,
      authenticated: account.authenticated,
      inPool: account.authenticated && !!account.authToken,
      readOnly: account.readOnly === true,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      boundSessionCount: boundSessionCounts.get(account.accountId) || 0,
    })),
    config: await getRuntimeConfig(),
    experimental: await buildExperimentalStatus(),
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
    login: {
      pending: Array.from(loginSessions.values()).some(
        (session) => session && !session.authenticated && !isLoginExpired(session),
      ),
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

function extractCodebuffErrorDetail(payload) {
  if (!payload) {
    return null
  }

  if (typeof payload === 'string') {
    return {
      message: payload,
      code: null,
      type: null,
    }
  }

  const error = payload.error && typeof payload.error === 'object'
    ? payload.error
    : null

  return {
    message:
      error?.message ||
      payload.message ||
      (typeof payload.error === 'string' ? payload.error : null) ||
      null,
    code:
      error?.code ||
      payload.code ||
      (typeof payload.error === 'string' ? payload.error : null) ||
      null,
    type: error?.type || payload.type || null,
  }
}

function buildCodebuffRequestError(response, fallbackMessage) {
  const detail = extractCodebuffErrorDetail(response?.data)
  const message = detail?.message || response?.text || fallbackMessage
  const error = new Error(message)
  error.statusCode = response?.status || 500
  error.errorCode = detail?.code || detail?.message || null
  error.errorType = detail?.type || null
  error.errorBody = response?.data || null
  return error
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

async function callCodebuffStreamRaw(token, body) {
  return fetch(`${CONFIG.apiBaseUrl}/api/v1/chat/completions`, {
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

// Freebuff session management helpers (official /api/v1/freebuff/session endpoints)
async function createFreebuffSession(token) {
  const response = await fetchJson(`${CONFIG.apiBaseUrl}/api/v1/freebuff/session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-codebuff-api-key': token,
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(CONFIG.responseTimeoutMs),
  })
  if (!response.ok) {
    throw buildCodebuffRequestError(response, 'Failed to create freebuff session.')
  }
  return response.data
}

async function getFreebuffSession(token, instanceId) {
  const response = await fetchJson(`${CONFIG.apiBaseUrl}/api/v1/freebuff/session`, {
    method: 'GET',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-codebuff-api-key': token,
      'x-freebuff-instance-id': instanceId,
    },
    signal: AbortSignal.timeout(CONFIG.responseTimeoutMs),
  })
  if (!response.ok) {
    throw buildCodebuffRequestError(response, 'Failed to get freebuff session.')
  }
  return response.data
}

async function deleteFreebuffSession(token, instanceId) {
  const response = await fetchJson(`${CONFIG.apiBaseUrl}/api/v1/freebuff/session`, {
    method: 'DELETE',
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-codebuff-api-key': token,
      'x-freebuff-instance-id': instanceId,
    },
    signal: AbortSignal.timeout(CONFIG.responseTimeoutMs),
  })
  if (!response.ok) {
    throw buildCodebuffRequestError(response, 'Failed to delete freebuff session.')
  }
  return response.data
}

function clearFreebuffSession(session) {
  if (!session) return
  session.freebuffInstanceId = null
  session.freebuffSessionState = null
  session.freebuffSessionCreatedAt = null
  session.freebuffSessionUpdatedAt = null
}

async function ensureFreebuffSession(token, session) {
  if (session.costMode !== 'free') return
  if (session.freebuffInstanceId) {
    try {
      const state = await getFreebuffSession(token, session.freebuffInstanceId)
      session.freebuffSessionState = state?.status || null
      session.freebuffSessionUpdatedAt = new Date().toISOString()
      if (state?.status === 'active') {
        return
      }
      if (state?.status === 'ended' || state?.status === 'superseded' || state?.status === 'none') {
        clearFreebuffSession(session)
      }
    } catch {
      clearFreebuffSession(session)
    }
  }
  if (!session.freebuffInstanceId) {
    const created = await createFreebuffSession(token)
    session.freebuffInstanceId = created?.instanceId || null
    session.freebuffSessionState = created?.status || 'queued'
    session.freebuffSessionCreatedAt = new Date().toISOString()
    session.freebuffSessionUpdatedAt = session.freebuffSessionCreatedAt
  }
}

function isFreebuffGateError(response) {
  if (!response) return false
  const code = response.status
  return code === 426 || code === 428 || code === 429 || code === 409 || code === 410
}

function isFreebuffSessionRecoverable(response) {
  if (!response) return false
  const code = response.status
  return code === 409 || code === 410 || code === 426
}

function isFreebuffWaitingRoomError(response) {
  if (!response) return false
  const code = response.status
  return code === 428 || code === 429
}

async function* readOpenAISseStream(response) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        try { yield JSON.parse(data) } catch {}
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

function mapOpenAIFinishReason(reason) {
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

async function startAgentRun(token, agentId) {
  const startedAt = Date.now()
  const response = await callCodebuffJson(token, '/api/v1/agent-runs', {
    action: 'START',
    agentId,
    ancestorRunIds: [],
  })

  if (!response.ok || typeof response.data?.runId !== 'string') {
    logger.error('codebuff', 'startAgentRun failed', { agentId, status: response.status, durationMs: Date.now() - startedAt })
    throw Object.assign(new Error(response.data?.error || 'Failed to create agent run.'), {
      statusCode: response.status || 500,
    })
  }

  logger.info('codebuff', 'agent run started', { agentId, runId: response.data.runId, durationMs: Date.now() - startedAt })
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

  if (session.costMode === 'free') {
    await ensureFreebuffSession(token, session)
  }

  let response = await callCodebuffJson(token, '/api/v1/chat/completions', {
    ...upstreamBody,
    codebuff_metadata: buildCodebuffMetadata(session),
  })

  if (!response.ok && isInvalidRunError(response)) {
    logger.warn('codebuff', 'invalid run, restarting', { session: session.session, runId: session.runId })
    await finishSessionRun(token, session, 'cancelled')
    session.runId = await startAgentRun(token, session.agentId)
    session.updatedAt = new Date().toISOString()
    bridgeSessions.set(session.session, session)
    response = await callCodebuffJson(token, '/api/v1/chat/completions', {
      ...upstreamBody,
      codebuff_metadata: buildCodebuffMetadata(session),
    })
  }

  if (!response.ok && session.costMode === 'free' && isFreebuffSessionRecoverable(response)) {
    logger.warn('codebuff', 'freebuff session recoverable error, resetting', { session: session.session, status: response.status })
    clearFreebuffSession(session)
    await ensureFreebuffSession(token, session)
    response = await callCodebuffJson(token, '/api/v1/chat/completions', {
      ...upstreamBody,
      codebuff_metadata: buildCodebuffMetadata(session),
    })
  }

  if (!response.ok) {
    if (session.costMode === 'free' && isFreebuffWaitingRoomError(response)) {
      const detail = extractCodebuffErrorDetail(response.data)
      const error = new Error(detail?.message || 'Freebuff waiting room required.')
      error.statusCode = response.status
      error.errorCode = detail?.code || 'waiting_room_required'
      error.errorType = detail?.type || 'server_error'
      throw error
    }
    throw buildCodebuffRequestError(response, 'Codebuff completion request failed.')
  }

  return response
}

function isAuthenticationFailure(error) {
  return error?.statusCode === 401 || error?.statusCode === 403
}

function isRetryableAccountFailure(error) {
  return (
    isAuthenticationFailure(error) ||
    error?.statusCode === 429 ||
    (typeof error?.statusCode === 'number' && error.statusCode >= 500)
  )
}

function isModeUnavailableError(error, mode) {
  if (!mode || !error) {
    return false
  }

  const code = String(error.errorCode || error.message || '').toLowerCase()
  return code === `${String(mode).toLowerCase()}_mode_unavailable`
}

function getFallbackModeForSession(session, error = null) {
  const currentMode = session?.costMode || runtimeConfig.costMode
  if (currentMode === 'free' && (!error || isModeUnavailableError(error, currentMode))) {
    return 'default'
  }
  return null
}

function shouldFallbackSessionMode(session, error = null) {
  if (runtimeConfig.allowPaidModeFallback !== true) {
    return false
  }

  const currentMode = session?.costMode || runtimeConfig.costMode
  if (!getFallbackModeForSession(session, error)) {
    return false
  }

  const availableAccounts = listAvailableAccounts()
  if (availableAccounts.length === 0) {
    return false
  }

  return (
    isModeUnavailableError(error, currentMode) ||
    availableAccounts.every((account) =>
      isAccountModeUnavailable(account.accountId, currentMode),
    )
  )
}

async function fallbackSessionMode(session, reason, fallbackMode = null) {
  if (!session) {
    return false
  }

  const nextMode = fallbackMode || getFallbackModeForSession(session)
  if (!nextMode || session.costMode === nextMode) {
    return false
  }

  const account = getSessionBoundAccount(session)
  await finishSessionRun(account?.authToken, session, 'cancelled')
  resetSessionRunState(session, reason || `Mode fallback to ${nextMode}.`)
  session.costMode = nextMode
  session.agentId = getAgentIdForMode(nextMode)
  session.updatedAt = new Date().toISOString()
  session.lastError = reason || `Mode fallback to ${nextMode}.`
  bridgeSessions.set(session.session, session)
  return true
}

function createMissingCredentialsError() {
  return Object.assign(
    new Error(
      'No Freebuff/Codebuff credentials found. Use /v1/freebuff/login or set CODEBUFF_API_KEY.',
    ),
    { statusCode: 401 },
  )
}

function createNoEligibleAccountsError(session, excludedAccountIds = []) {
  const availableAccounts = listAvailableAccounts(excludedAccountIds)
  if (availableAccounts.length === 0) {
    return createMissingCredentialsError()
  }

  const mode = session?.costMode || runtimeConfig.costMode
  const modeUnavailableReasons = availableAccounts
    .map((account) => accountRuntimeStats.get(account.accountId)?.unavailableModes?.[mode]?.reason)
    .filter(Boolean)

  if (modeUnavailableReasons.length === availableAccounts.length) {
    return Object.assign(
      new Error(
        modeUnavailableReasons[0] ||
          `${MODE_DEFINITIONS[mode]?.label || mode} mode is unavailable for all available accounts.`,
      ),
      {
        statusCode: 403,
        errorCode: `${mode}_mode_unavailable`,
      },
    )
  }

  return createMissingCredentialsError()
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
    'The repaired arguments MUST exactly satisfy the provided JSON schema.',
    'Fill every required parameter from the conversation context.',
    'Do not omit required fields.',
    '',
    `Tool name: ${tool.name}`,
    `Tool schema: ${JSON.stringify(tool.input_schema || {})}`,
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

async function executeWithAccountSelectionRecovery(session, executeSelection) {
  let excludedAccountIds = []
  let strategy = 'performance'
  let lastError = null
  let attemptedModeFallback = false

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const selection = selectAccountForRequest(session, excludedAccountIds, strategy)
    if (!selection?.account) {
      if (!attemptedModeFallback && shouldFallbackSessionMode(session, lastError)) {
        const nextMode = getFallbackModeForSession(session, lastError)
        logger.info('account', 'mode fallback', { session: session.session, from: session.costMode, to: nextMode, reason: lastError?.message })
        await fallbackSessionMode(
          session,
          `Mode fallback: ${session.costMode} -> ${nextMode} (${lastError?.message || 'mode unavailable'})`,
          nextMode,
        )
        excludedAccountIds = []
        strategy = 'mode_fallback'
        attemptedModeFallback = true
        continue
      }

      throw lastError || createNoEligibleAccountsError(session, excludedAccountIds)
    }

    if (attempt > 0) {
      logger.info('account', 'retry attempt', { session: session.session, attempt, accountId: selection.account.accountId, strategy })
    }

    try {
      return await executeSelection(selection)
    } catch (error) {
      session.lastError = error?.message || 'Unknown account execution error.'
      bridgeSessions.set(session.session, session)

      if (!isRetryableAccountFailure(error)) {
        markAccountBlocked(
          selection.account.accountId,
          error?.message || `http_${error?.statusCode || 'error'}`,
        )
        logger.error('account', 'non-retryable failure', { session: session.session, accountId: selection.account.accountId, statusCode: error?.statusCode, error: error?.message })
        throw error
      }

      const activeMode = session.costMode || runtimeConfig.costMode
      logger.warn('account', 'retryable failure', { session: session.session, attempt, accountId: selection.account.accountId, statusCode: error?.statusCode, error: error?.message })

      if (isModeUnavailableError(error, activeMode)) {
        markAccountModeUnavailable(
          selection.account.accountId,
          activeMode,
          error?.message || `${activeMode}_mode_unavailable`,
        )
      } else {
        markAccountFailure(
          selection.account.accountId,
          `http_${error?.statusCode || 'error'}`,
        )
      }

      excludedAccountIds = Array.from(
        new Set([...excludedAccountIds, selection.account.accountId]),
      )
      strategy = 'retry'
      lastError = error
    }
  }

  throw lastError || createMissingCredentialsError()
}

async function streamAnthropicRequest(res, { sessionName, body, headers, url }) {
  return withSessionLock(sessionName, async () => {
    if (shouldResetSession(body, headers)) {
      const previous = bridgeSessions.get(sessionName)
      const previousAccount = getSessionBoundAccount(previous)
      await finishSessionRun(previousAccount?.authToken, previous, 'cancelled')
      bridgeSessions.delete(sessionName)
    }

    const session = getOrCreateBridgeSession(sessionName)
    const requestStartedAt = Date.now()
    const publicModel = body.model || runtimeConfig.modelAlias
    const openAIMessages = convertAnthropicMessagesToOpenAIMessages(body.messages, body.system)
    const openAITools = convertAnthropicToolsToOpenAITools(body.tools)
    const openAIToolChoice = convertAnthropicToolChoiceToOpenAI(body.tool_choice)
    const upstreamBodyBase = {
      model: runtimeConfig.backendModel,
      stream: true,
      messages: openAIMessages,
      max_tokens: body.max_tokens,
      temperature: body.temperature,
      stop: body.stop_sequences,
      provider: { data_collection: 'deny' },
      tools: openAITools || [],
      tool_choice: openAIToolChoice,
    }

    const acquireUpstream = async (token, forSession) => {
      await ensureActiveRun(token, forSession)
      if (forSession.costMode === 'free') {
        await ensureFreebuffSession(token, forSession)
      }
      const rawBody = { ...upstreamBodyBase, codebuff_metadata: buildCodebuffMetadata(forSession) }
      let upstream = await callCodebuffStreamRaw(token, rawBody)
      if (!upstream.ok) {
        const text = await upstream.text()
        let data = null
        try { data = JSON.parse(text) } catch {}
        if (isInvalidRunError({ data, text })) {
          await finishSessionRun(token, forSession, 'cancelled')
          forSession.runId = await startAgentRun(token, forSession.agentId)
          forSession.updatedAt = new Date().toISOString()
          bridgeSessions.set(sessionName, forSession)
          upstream = await callCodebuffStreamRaw(token, {
            ...rawBody,
            codebuff_metadata: buildCodebuffMetadata(forSession),
          })
        }
        if (!upstream.ok && forSession.costMode === 'free' && isFreebuffSessionRecoverable({ status: upstream.status, data, text })) {
          logger.warn('codebuff', 'freebuff session recoverable error in stream, resetting', { session: forSession.session, status: upstream.status })
          clearFreebuffSession(forSession)
          await ensureFreebuffSession(token, forSession)
          upstream = await callCodebuffStreamRaw(token, {
            ...rawBody,
            codebuff_metadata: buildCodebuffMetadata(forSession),
          })
        }
        if (!upstream.ok) {
          if (forSession.costMode === 'free' && isFreebuffWaitingRoomError({ status: upstream.status, data, text })) {
            const detail = extractCodebuffErrorDetail(data)
            const error = new Error(detail?.message || 'Freebuff waiting room required.')
            error.statusCode = upstream.status
            error.errorCode = detail?.code || 'waiting_room_required'
            error.errorType = detail?.type || 'server_error'
            throw error
          }
          const errText = upstream.bodyUsed ? text : await upstream.text()
          let errData = null
          try { errData = JSON.parse(errText) } catch {}
          throw buildCodebuffRequestError(
            {
              status: upstream.status || 500,
              text: errText,
              data: errData,
            },
            'Codebuff completion failed.',
          )
        }
      }
      return upstream
    }

    const {
      upstream,
      account,
      reason,
      score,
      previousAccount,
      switched,
      activePreviousAccountId,
      accountAttemptStartedAt,
    } = await executeWithAccountSelectionRecovery(session, async (selection) => {
      const { account, reason, score, previousAccountId } = selection
      if (!account?.authToken) {
        throw createMissingCredentialsError()
      }

      markAccountSelected(account.accountId)
      const { previousAccount, switched } = await assignSessionToAccount(
        session,
        account,
        reason,
      )
      const accountAttemptStartedAt = Date.now()
      const upstream = await acquireUpstream(account.authToken, session)

      return {
        upstream,
        account,
        reason,
        score,
        previousAccount,
        switched,
        activePreviousAccountId: previousAccount?.accountId || previousAccountId,
        accountAttemptStartedAt,
      }
    })

    // Headers are confirmed OK — start writing SSE to client
    const msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const writeEvent = (event, payload) => {
      const ok = res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)
      if (!ok) return new Promise(resolve => res.once('drain', resolve))
    }

    await writeEvent('message_start', {
      type: 'message_start',
      message: {
        id: msgId, type: 'message', role: 'assistant', model: publicModel,
        content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })

    let blockIdx = 0
    let textIdx = -1
    let textBuf = ''
    const toolBlocks = new Map() // openAI tool index → { anthropicIdx, id, name, argsBuf }
    let stopReason = 'end_turn'
    let inputTokens = 0
    let outputTokens = 0

    for await (const chunk of readOpenAISseStream(upstream)) {
      const choice = chunk.choices?.[0]
      const delta = choice?.delta
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens || 0
        outputTokens = chunk.usage.completion_tokens || 0
      }
      if (choice?.finish_reason) stopReason = mapOpenAIFinishReason(choice.finish_reason)
      if (!delta) continue

      if (typeof delta.content === 'string' && delta.content !== '') {
        if (textIdx === -1) {
          textIdx = blockIdx++
          await writeEvent('content_block_start', {
            type: 'content_block_start', index: textIdx,
            content_block: { type: 'text', text: '' },
          })
        }
        textBuf += delta.content
        await writeEvent('content_block_delta', {
          type: 'content_block_delta', index: textIdx,
          delta: { type: 'text_delta', text: delta.content },
        })
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const ti = tc.index
          if (!toolBlocks.has(ti)) toolBlocks.set(ti, { anthropicIdx: blockIdx++, id: '', name: '', argsBuf: '' })
          const blk = toolBlocks.get(ti)
          if (tc.id) blk.id = tc.id
          if (tc.function?.name) blk.name += tc.function.name
          if (tc.function?.arguments) blk.argsBuf += tc.function.arguments
        }
      }
    }

    if (textIdx !== -1) {
      await writeEvent('content_block_stop', { type: 'content_block_stop', index: textIdx })
    }

    // Reconstruct full anthropicMessage for repair check
    const anthropicContent = []
    if (textIdx !== -1) anthropicContent[textIdx] = { type: 'text', text: textBuf }
    for (const [, blk] of toolBlocks) {
      let parsedInput = {}
      try { parsedInput = JSON.parse(blk.argsBuf || '{}') } catch {}
      anthropicContent[blk.anthropicIdx] = { type: 'tool_use', id: blk.id, name: blk.name, input: parsedInput }
    }

    const anthropicMessage = {
      id: msgId, type: 'message', role: 'assistant', model: publicModel,
      content: anthropicContent.filter(Boolean),
      stop_reason: stopReason, stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    }

    const repairResult = await repairInvalidToolUses({
      token: account.authToken, session, publicModel,
      system: body.system, messages: body.messages, tools: body.tools, anthropicMessage,
    })

    for (const [, blk] of toolBlocks) {
      const finalBlock = repairResult.message.content.find(c => c.type === 'tool_use' && c.id === blk.id)
        || { id: blk.id, name: blk.name, input: {} }
      await writeEvent('content_block_start', {
        type: 'content_block_start', index: blk.anthropicIdx,
        content_block: { type: 'tool_use', id: finalBlock.id, name: finalBlock.name, input: {} },
      })
      await writeEvent('content_block_delta', {
        type: 'content_block_delta', index: blk.anthropicIdx,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(finalBlock.input || {}) },
      })
      await writeEvent('content_block_stop', { type: 'content_block_stop', index: blk.anthropicIdx })
    }

    await writeEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: outputTokens },
    })
    await writeEvent('message_stop', { type: 'message_stop' })
    res.end()

    // Capture timing snapshot before releasing the session lock
    const endedAt = Date.now()
    const repairedCount = repairResult.repairedCount

    // Post-stream accounting runs outside the lock so the session is immediately
    // available for the next request — all operations here are in-memory only.
    setImmediate(() => {
      const accountDurationMs = endedAt - accountAttemptStartedAt
      const runtimeSummary = markAccountSuccess(account.accountId, {
        durationMs: accountDurationMs,
        outputTokens,
        reason: stopReason,
        mode: session.costMode,
      })
      logger.info('request', 'stream completed', {
        session: sessionName, accountId: account.accountId,
        durationMs: endedAt - requestStartedAt, accountDurationMs,
        inputTokens, outputTokens, stopReason, repairedCount,
      })
      session.requestCount += 1
      session.turns += 1
      session.updatedAt = new Date().toISOString()
      session.lastStopReason = stopReason
      session.lastError = null
      bridgeSessions.set(sessionName, session)

      const toolSummary = summarizeAnthropicTools(body.tools)
      const promptText = [normalizeAnthropicSystem(body.system), JSON.stringify(openAIMessages)]
        .filter(Boolean).join('\n')
      recordUsage({
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        session: sessionName,
        requestKind: 'anthropic',
        stream: true,
        model: publicModel,
        agentId: session.agentId,
        backendModel: runtimeConfig.backendModel,
        promptTokens: inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        promptChars: promptText.length,
        outputChars: textBuf.length,
        durationMs: endedAt - requestStartedAt,
        accountDurationMs,
        codebuffMetadata: buildCodebuffMetadata(session),
        stopReason,
        toolCount: toolSummary.toolCount,
        toolSources: toolSummary.toolSources,
        errorSummary: repairedCount > 0
          ? `Repaired ${repairedCount} invalid tool call(s)` : null,
        previousAccountId: previousAccount?.accountId || activePreviousAccountId,
        previousAccountEmail: previousAccount?.email || null,
        accountSwitched: switched,
        accountSelectionReason: reason,
        accountSelectionScore: score,
        accountSampleCount: runtimeSummary.sampleCount,
        accountTpsSnapshot: runtimeSummary.avgTps,
        accountAvgDurationMs: runtimeSummary.avgDurationMs,
        ...getAccountPresentation(account),
      })
    })
  })
}

async function executeAnthropicRequest({ sessionName, body, headers, url }) {
  return withSessionLock(sessionName, async () => {
    if (shouldResetSession(body, headers)) {
      const previous = bridgeSessions.get(sessionName)
      const previousAccount = getSessionBoundAccount(previous)
      await finishSessionRun(previousAccount?.authToken, previous, 'cancelled')
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

    const executeWithSelection = async (selection) => {
      const { account, reason, score, previousAccountId } = selection
      if (!account?.authToken) {
        throw createMissingCredentialsError()
      }

      markAccountSelected(account.accountId)
      const { previousAccount, switched } = await assignSessionToAccount(
        session,
        account,
        reason,
      )
      const accountAttemptStartedAt = Date.now()

      const response = await executeCodebuffChatCompletion({
        token: account.authToken,
        session,
        upstreamBody,
      })

      let anthropicMessage = buildAnthropicResponseFromOpenAI(
        response.data,
        publicModel,
      )
      const repairResult = await repairInvalidToolUses({
        token: account.authToken,
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
      const accountDurationMs = Date.now() - accountAttemptStartedAt
      const runtimeSummary = markAccountSuccess(account.accountId, {
        durationMs: accountDurationMs,
        outputTokens: anthropicMessage.usage.output_tokens,
        reason: anthropicMessage.stop_reason,
        mode: session.costMode,
      })

      logger.info('request', 'anthropic non-stream completed', {
        session: sessionName, accountId: account.accountId,
        durationMs: Date.now() - requestStartedAt, accountDurationMs,
        inputTokens: anthropicMessage.usage.input_tokens,
        outputTokens: anthropicMessage.usage.output_tokens,
        stopReason: anthropicMessage.stop_reason,
        repairedCount: repairResult.repairedCount,
      })

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
          anthropicMessage.usage.input_tokens +
          anthropicMessage.usage.output_tokens,
        promptChars: promptText.length,
        outputChars: responseText.length,
        durationMs: Date.now() - requestStartedAt,
        accountDurationMs,
        codebuffMetadata: buildCodebuffMetadata(session),
        stopReason: anthropicMessage.stop_reason,
        toolCount: toolSummary.toolCount,
        toolSources: toolSummary.toolSources,
        errorSummary:
          repairResult.repairedCount > 0
            ? `Repaired ${repairResult.repairedCount} invalid tool call(s)`
            : null,
        previousAccountId: previousAccount?.accountId || previousAccountId,
        previousAccountEmail: previousAccount?.email || null,
        accountSwitched: switched,
        accountSelectionReason: reason,
        accountSelectionScore: score,
        accountSampleCount: runtimeSummary.sampleCount,
        accountTpsSnapshot: runtimeSummary.avgTps,
        accountAvgDurationMs: runtimeSummary.avgDurationMs,
        ...getAccountPresentation(account),
      })

      return anthropicMessage
    }

    return executeWithAccountSelectionRecovery(session, executeWithSelection)
  })
}

async function executeOpenAIRequest({ sessionName, body, headers }) {
  return withSessionLock(sessionName, async () => {
    if (shouldResetSession(body, headers)) {
      const previous = bridgeSessions.get(sessionName)
      const previousAccount = getSessionBoundAccount(previous)
      await finishSessionRun(previousAccount?.authToken, previous, 'cancelled')
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

    const executeWithSelection = async (selection) => {
      const { account, reason, score, previousAccountId } = selection
      if (!account?.authToken) {
        throw createMissingCredentialsError()
      }

      markAccountSelected(account.accountId)
      const { previousAccount, switched } = await assignSessionToAccount(
        session,
        account,
        reason,
      )
      const accountAttemptStartedAt = Date.now()

      const response = await executeCodebuffChatCompletion({
        token: account.authToken,
        session,
        upstreamBody,
      })

      const usage = response.data?.usage || {}
      const toolCalls = response.data?.choices?.[0]?.message?.tool_calls || []
      const accountDurationMs = Date.now() - accountAttemptStartedAt
      const runtimeSummary = markAccountSuccess(account.accountId, {
        durationMs: accountDurationMs,
        outputTokens: usage.completion_tokens || 0,
        reason: response.data?.choices?.[0]?.finish_reason || 'stop',
        mode: session.costMode,
      })

      logger.info('request', 'openai non-stream completed', {
        session: sessionName, accountId: account.accountId,
        durationMs: Date.now() - requestStartedAt, accountDurationMs,
        inputTokens: usage.prompt_tokens || 0, outputTokens: usage.completion_tokens || 0,
        finishReason: response.data?.choices?.[0]?.finish_reason,
      })

      session.requestCount += 1
      session.turns += 1
      session.updatedAt = new Date().toISOString()
      session.lastStopReason =
        response.data?.choices?.[0]?.finish_reason || 'stop'
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
        outputChars: normalizeText(
          response.data?.choices?.[0]?.message?.content,
        ).length,
        durationMs: Date.now() - requestStartedAt,
        accountDurationMs,
        codebuffMetadata: buildCodebuffMetadata(session),
        stopReason: response.data?.choices?.[0]?.finish_reason || 'stop',
        toolCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
        toolSources: [],
        errorSummary: null,
        previousAccountId: previousAccount?.accountId || previousAccountId,
        previousAccountEmail: previousAccount?.email || null,
        accountSwitched: switched,
        accountSelectionReason: reason,
        accountSelectionScore: score,
        accountSampleCount: runtimeSummary.sampleCount,
        accountTpsSnapshot: runtimeSummary.avgTps,
        accountAvgDurationMs: runtimeSummary.avgDurationMs,
        ...getAccountPresentation(account),
      })

      return buildCompletionResponse(publicModel, response.data)
    }

    return executeWithAccountSelectionRecovery(session, executeWithSelection)
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
    authenticated: false,
    accountId: null,
    email: null,
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
    authenticated: false,
    accountId: null,
    email: null,
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

  const account = upsertStoredAccount(user, session)
  logger.info('auth', 'login completed', { email: account.email, accountId: account.accountId })
  const completedSession = {
    ...session,
    authenticated: true,
    accountId: account.accountId,
    email: account.email,
    updatedAt: new Date().toISOString(),
  }
  loginSessions.set(sessionName, completedSession)

  return {
    ok: true,
    authenticated: true,
    waiting: false,
    expired: false,
    session: sessionName,
    loginUrl: session.loginUrl,
    expiresAt: session.expiresAt,
    email: account.email,
    accountId: account.accountId,
    source: account.source,
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || CONFIG.host}`)
  const requestStartedAt = Date.now()
  const isApiRoute = url.pathname.startsWith('/v1/') || url.pathname === '/health'
  if (isApiRoute) {
    logger.debug('router', 'request', { method: req.method, path: url.pathname })
  }
  try {

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

    if (req.method === 'GET' && url.pathname === '/experimental/health') {
      sendJson(res, 200, await buildExperimentalHealth())
      return
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/experimental/v1/models'
    ) {
      sendJson(res, 200, buildExperimentalModelsResponse())
      return
    }

    if (
      req.method === 'GET' &&
      url.pathname === '/experimental/v1/chatgpt-web/status'
    ) {
      sendJson(res, 200, {
        ok: true,
        status: await buildExperimentalStatus({ probe: true }),
      })
      return
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/experimental/v1/chatgpt-web/browser/start'
    ) {
      ensureExperimentalEnabled()
      ensureExperimentalDirs()
      startExperimentalChromeProcess()
      experimentalRuntime.browserStarted = true
      ensureExperimentalBrowserContext().catch((error) => {
        noteExperimentalError(error)
      })
      sendJson(res, 202, {
        ok: true,
        browserStarted: true,
        authenticated: experimentalRuntime.authenticated,
        pending: true,
        status: await buildExperimentalStatus(),
      })
      return
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/experimental/v1/chatgpt-web/reset'
    ) {
      const body = await readJsonBody(req)
      const sessionName = resolveExperimentalSessionName(body, req.headers, url)
      await resetExperimentalSessionState(sessionName, true)
      sendJson(res, 200, {
        ok: true,
        reset: true,
        session: sessionName,
      })
      return
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/experimental/v1/messages/count_tokens'
    ) {
      const body = await readJsonBody(req)
      const promptText = [
        normalizeAnthropicSystem(body?.system),
        JSON.stringify(body?.messages || []),
      ]
        .filter(Boolean)
        .join('\n')

      sendJson(res, 200, {
        input_tokens: estimateTokens(promptText),
      })
      return
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/experimental/v1/messages'
    ) {
      const body = await readJsonBody(req)
      const sessionName = resolveExperimentalSessionName(body, req.headers, url)

      if (body.stream === true) {
        await streamExperimentalAnthropicRequest(res, {
          sessionName,
          body,
        })
        return
      }

      const payload = await executeExperimentalAnthropicRequest({
        sessionName,
        body,
      })
      sendJson(res, 200, payload)
      return
    }

    if (
      req.method === 'POST' &&
      url.pathname === '/experimental/v1/chat/completions'
    ) {
      const body = await readJsonBody(req)
      const sessionName = resolveExperimentalSessionName(body, req.headers, url)

      if (body.stream === true) {
        await streamExperimentalOpenAIRequest(res, {
          sessionName,
          body,
        })
        return
      }

      const payload = await executeExperimentalOpenAIRequest({
        sessionName,
        body,
      })
      sendJson(res, 200, payload)
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/freebuff/admin/overview') {
      sendJson(res, 200, await buildAdminOverview())
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/freebuff/models') {
      const mode =
        normalizeMode(
          url.searchParams.get('mode') || url.searchParams.get('costMode'),
        ) || runtimeConfig.costMode
      const models =
        mode === 'free' ? FREE_BACKEND_MODELS : await getOpenRouterModels()
      sendJson(res, 200, { ok: true, models })
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/freebuff/config') {
      sendJson(res, 200, {
        ok: true,
        config: await getRuntimeConfig(),
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
      const body = await readJsonBody(req)
      const accountId = firstNonEmpty(body?.accountId, req.headers['x-freebuff-account'])
      if (!accountId) {
        throw Object.assign(new Error('accountId is required.'), {
          statusCode: 400,
        })
      }

      const account = getAccountById(accountId)
      if (!account) {
        throw Object.assign(new Error(`Account not found: ${accountId}`), {
          statusCode: 404,
        })
      }

      if (account.source === 'environment') {
        throw Object.assign(
          new Error('Environment-backed account cannot be removed from the dashboard.'),
          { statusCode: 400 },
        )
      }

      await releaseSessionsForAccount(accountId, 'cancelled')
      clearLoginSessionsForAccount(accountId)
      removeStoredAccount(accountId)
      removeAccountRuntimeStats(accountId)
      logger.info('auth', 'account logged out', { accountId, email: account.email })
      sendJson(res, 200, {
        ok: true,
        loggedOut: true,
        accountId,
      })
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/freebuff/logout/all') {
      await finishAllSessions('cancelled')
      bridgeSessions.clear()
      loginSessions.clear()
      writeStoredAccounts([])
      accountRuntimeStats.clear()
      logger.info('auth', 'all accounts logged out')
      sendJson(res, 200, { ok: true, loggedOutAll: true })
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const sessionName = resolveSessionName({}, req.headers, url)
      const auth = buildAuthPresentation(sessionName)
      const backendCacheAge = Math.round((Date.now() - backendLiveness.checkedAt) / 1000)
      const backendCacheFresh = backendLiveness.checkedAt > 0 && (Date.now() - backendLiveness.checkedAt) < HEALTH_CACHE_TTL
      const status = computeHealthStatus({ backendOk: backendCacheFresh ? backendLiveness.ok : undefined, backendCacheFresh })
      const base = {
        ok: status !== 'unhealthy',
        status,
        host: CONFIG.host,
        port: CONFIG.port,
        cwd: CONFIG.cwd,
        model: runtimeConfig.modelAlias,
        agent: runtimeConfig.agentId,
        mode: runtimeConfig.costMode,
        backendModel: runtimeConfig.backendModel,
        costMode: runtimeConfig.costMode,
        authenticated: auth.authenticated,
        authSource: auth.authSource,
        email: auth.email,
        accountId: auth.boundAccountId,
        authPool: {
          totalAccounts: auth.totalAccounts,
          availableAccounts: auth.availableAccounts,
          environmentAccountPresent: auth.environmentAccountPresent,
        },
        bridgeSessions: bridgeSessions.size,
        backendCacheAge,
        system: buildSystemMetrics(),
        accountPool: buildAccountPoolHealth(),
        compatibility: {
          protocol: 'anthropic-messages',
          supportsNativeTools: true,
          supportsMcpTools: true,
          supportsInstalledPluginTools: true,
        },
        ...inspectBridgeSession(sessionName),
      }

      if (url.searchParams.get('verbose') !== '1') {
        sendJson(res, 200, base)
        return
      }

      // verbose mode: probe backend + each account
      const [backend, accounts] = await Promise.all([
        probeBackendConnectivity(),
        Promise.all(listAuthAccounts().map(async (acct) => {
          const liveness = await probeAccountLiveness(acct)
          const summary = buildAccountRuntimeSummary(acct.accountId)
          return { accountId: acct.accountId, email: acct.email, source: acct.source, liveness, ...summary }
        })),
      ])
      const verboseStatus = computeHealthStatus({ backendOk: backend.ok, backendCacheFresh: true })
      base.ok = verboseStatus !== 'unhealthy'
      base.status = verboseStatus
      base.backend = {
        reachable: backend.ok,
        latencyMs: backend.latencyMs,
        status: backend.status,
        error: backend.error,
        checkedAt: backend.checkedAt ? new Date(backend.checkedAt).toISOString() : null,
        cacheAge: Math.round((Date.now() - backend.checkedAt) / 1000),
      }
      base.accounts = accounts
      logger.debug('health', 'verbose check', { backendOk: backend.ok, status: verboseStatus, accountCount: accounts.length })
      sendJson(res, 200, base)
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/freebuff/status') {
      const sessionName = resolveSessionName({}, req.headers, url)
      const auth = buildAuthPresentation(sessionName)
      sendJson(res, 200, {
        ok: true,
        cwd: CONFIG.cwd,
        authenticated: auth.authenticated,
        authSource: auth.authSource,
        email: auth.email,
        accountId: auth.boundAccountId,
        authPool: {
          totalAccounts: auth.totalAccounts,
          availableAccounts: auth.availableAccounts,
          environmentAccountPresent: auth.environmentAccountPresent,
        },
        config: await getRuntimeConfig(),
        usageSummary: buildUsageSummary(),
        accounts: (await buildAdminOverview()).accounts,
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
      const sessionName = resolveSessionName(body, req.headers, url)
      const session = bridgeSessions.get(sessionName)
      const account = getSessionBoundAccount(session)
      await finishSessionRun(account?.authToken, session, 'cancelled')
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
        availableAccounts: resolveAuthState().availableAccounts,
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

      if (body.stream === true) {
        await streamAnthropicRequest(res, { sessionName, body, headers: req.headers, url })
        return
      }

      const anthropicMessage = await executeAnthropicRequest({
        sessionName, body, headers: req.headers, url,
      })
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
    if (res.headersSent) {
      logger.warn('router', 'response headers already sent on error', { method: req.method, path: url.pathname })
      try { res.end() } catch {}
      return
    }
    const statusCode =
      typeof error?.statusCode === 'number' ? error.statusCode : 500

    logger.error('router', 'request error', {
      method: req.method, path: url.pathname, statusCode,
      error: error?.message, errorCode: error?.errorCode, errorType: error?.errorType,
      durationMs: Date.now() - requestStartedAt,
    })

    sendJson(res, statusCode, {
      error: {
        message: error?.message || 'Unknown error',
        type:
          error?.errorType ||
          (statusCode === 401 ? 'authentication_error' : 'server_error'),
        code: error?.errorCode || null,
      },
    })
  }
})

server.listen(CONFIG.port, CONFIG.host, () => {
  logger.info('server', 'listening', {
    host: CONFIG.host, port: CONFIG.port, cwd: CONFIG.cwd,
    model: runtimeConfig.modelAlias, mode: runtimeConfig.costMode, agent: runtimeConfig.agentId,
  })
})
