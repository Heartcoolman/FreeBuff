import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
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
}

const APP_DIR = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.join(APP_DIR, 'public')

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

const ACCOUNT_STATS_WINDOW = 5
const ACCOUNT_COOLDOWN_MS = 45_000
const ACCOUNT_SELECTION_RECENCY_MS = 12_000
const ACCOUNT_SLOW_TPS_THRESHOLD = 8
const ACCOUNT_SLOW_DURATION_MS = 7_500

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
      selectionCount: 0,
      lastSelectedAtMs: 0,
      lastSuccessAtMs: 0,
      lastFailureAtMs: 0,
      lastFailureReason: null,
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
    cooldownUntil:
      stats?.cooldownUntilMs && stats.cooldownUntilMs > 0
        ? new Date(stats.cooldownUntilMs).toISOString()
        : null,
    cooldownUntilMs: stats?.cooldownUntilMs || 0,
    isCoolingDown: Boolean(stats?.cooldownUntilMs && stats.cooldownUntilMs > now),
    consecutiveSlowCount: stats?.consecutiveSlowCount || 0,
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
  { durationMs = 0, outputTokens = 0, reason = 'success' } = {},
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
  stats.cooldownUntilMs = 0
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
) {
  const stats = getOrCreateAccountRuntimeStats(accountId)
  if (!stats) {
    return buildAccountRuntimeSummary(accountId)
  }

  const now = Date.now()
  stats.lastFailureAtMs = now
  stats.lastFailureReason = reason
  stats.cooldownUntilMs = cooldownMs > 0 ? now + cooldownMs : 0

  return buildAccountRuntimeSummary(accountId, now)
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
  const candidates = availableAccounts.map((account) => {
    const summary = buildAccountRuntimeSummary(account.accountId, now)
    return {
      account,
      summary,
      score: scoreAccountCandidate(summary, now),
    }
  })

  const activeCandidates = candidates.filter((candidate) => !candidate.summary.isCoolingDown)
  const pool = activeCandidates.length > 0 ? activeCandidates : candidates
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
    console.error('[freebuff-bridge] finishSessionRun failed', error)
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

  const next = await getRuntimeConfig()
  const changed =
    previous.modelAlias !== next.modelAlias ||
    previous.mode !== next.mode ||
    previous.agentId !== next.agentId ||
    previous.backendModel !== next.backendModel

  if (changed) {
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

function createMissingCredentialsError() {
  return Object.assign(
    new Error(
      'No Freebuff/Codebuff credentials found. Use /v1/freebuff/login or set CODEBUFF_API_KEY.',
    ),
    { statusCode: 401 },
  )
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

    const selection = selectAccountForRequest(session)
    if (!selection?.account) {
      throw createMissingCredentialsError()
    }

    try {
      return await executeWithSelection(selection)
    } catch (error) {
      session.lastError = error?.message || 'Unknown account execution error.'
      bridgeSessions.set(sessionName, session)

      if (!isRetryableAccountFailure(error)) {
        throw error
      }

      markAccountFailure(
        selection.account.accountId,
        `http_${error?.statusCode || 'error'}`,
      )
      const retrySelection = selectAccountForRequest(
        session,
        [selection.account.accountId],
        'retry',
      )
      if (!retrySelection?.account) {
        throw error
      }

      return executeWithSelection(retrySelection)
    }
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

    const selection = selectAccountForRequest(session)
    if (!selection?.account) {
      throw createMissingCredentialsError()
    }

    try {
      return await executeWithSelection(selection)
    } catch (error) {
      session.lastError = error?.message || 'Unknown account execution error.'
      bridgeSessions.set(sessionName, session)

      if (!isRetryableAccountFailure(error)) {
        throw error
      }

      markAccountFailure(
        selection.account.accountId,
        `http_${error?.statusCode || 'error'}`,
      )
      const retrySelection = selectAccountForRequest(
        session,
        [selection.account.accountId],
        'retry',
      )
      if (!retrySelection?.account) {
        throw error
      }

      return executeWithSelection(retrySelection)
    }
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
      sendJson(res, 200, { ok: true, loggedOutAll: true })
      return
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      const sessionName = resolveSessionName({}, req.headers, url)
      const auth = buildAuthPresentation(sessionName)
      sendJson(res, 200, {
        ok: true,
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
    `Freebuff bridge listening on http://${CONFIG.host}:${CONFIG.port} using cwd ${CONFIG.cwd}, model ${runtimeConfig.modelAlias}, mode ${runtimeConfig.costMode}, agent ${runtimeConfig.agentId}`,
  )
})
