const state = {
  overview: null,
  loginSession: null,
}

const fallbackBackendModels = {
  free: [
    { value: 'z-ai/glm-5.1', label: 'GLM 5.1', provider: 'Z.AI / Fireworks' },
    { value: 'minimax/minimax-m2.7', label: 'MiniMax M2.7', provider: 'MiniMax' },
  ],
}

const fallbackModes = [
  {
    value: 'free',
    label: 'Free',
    description: '免费优先模式，适合本地桥接和多账号轮训。',
    agentId: 'base2-free',
  },
  {
    value: 'default',
    label: 'Default',
    description: '通用默认模式，平衡速度、规划和稳定性。',
    agentId: 'base2',
  },
  {
    value: 'lite',
    label: 'Lite',
    description: '更轻更快，适合小改动与快速迭代。',
    agentId: 'base2-lite',
  },
  {
    value: 'max',
    label: 'Max',
    description: '更强推理与更重规划，适合复杂任务。',
    agentId: 'base2-max',
  },
  {
    value: 'plan',
    label: 'Plan',
    description: '偏规划和方案推演，适合先出计划。',
    agentId: 'base2-plan',
  },
]

function populateModelDropdown(models, selectedValue) {
  const opts = [...models]
  if (selectedValue && !opts.some((m) => m.value === selectedValue)) {
    opts.unshift({ value: selectedValue, label: selectedValue, provider: '当前值' })
  }
  els.configBackendModel.innerHTML = opts
    .map((m) => `<option value="${m.value}">${m.label} (${m.provider})</option>`)
    .join('')
  els.configBackendModel.value = selectedValue || ''
}

const els = {
  authPill: document.querySelector('#auth-pill'),
  authSummary: document.querySelector('#auth-summary'),
  loginActions: document.querySelector('#login-actions'),
  loginUrlBox: document.querySelector('#login-url-box'),
  accountsList: document.querySelector('#accounts-list'),
  summaryCards: document.querySelector('#summary-cards'),
  compatibilityCard: document.querySelector('#compatibility-card'),
  sessionsList: document.querySelector('#sessions-list'),
  usageTable: document.querySelector('#usage-table'),
  toast: document.querySelector('#toast'),
  refreshAll: document.querySelector('#refresh-all'),
  refreshUsage: document.querySelector('#refresh-usage'),
  resetUsage: document.querySelector('#reset-usage'),
  configForm: document.querySelector('#config-form'),
  configModelAlias: document.querySelector('#config-model-alias'),
  configMode: document.querySelector('#config-mode'),
  configModeHelp: document.querySelector('#config-mode-help'),
  configBackendModel: document.querySelector('#config-backend-model'),
  configAllowPaidFallback: document.querySelector('#config-allow-paid-fallback'),
  tutorialModelAlias: document.querySelector('#tutorial-model-alias'),
  tutorialModelCommand: document.querySelector('#tutorial-model-command'),
  tutorialSettingsJson: document.querySelector('#tutorial-settings-json'),
  autoRefreshSelect: document.querySelector('#auto-refresh-select'),
  connectionStatus: document.querySelector('#connection-status'),
  currentTime: document.querySelector('#current-time'),
  pillMode: document.querySelector('#pill-mode'),
  pillModel: document.querySelector('#pill-model'),
  pillAgent: document.querySelector('#pill-agent'),
  usageUpdatedAt: document.querySelector('#usage-updated-at'),
}

const autoRefresh = { intervalId: null }

function setAutoRefresh(seconds) {
  clearInterval(autoRefresh.intervalId)
  autoRefresh.intervalId = seconds > 0
    ? setInterval(() => refreshAll(), seconds * 1000)
    : null
}

const autoPoll = { timerId: null }

function startAutoPoll() {
  stopAutoPoll()
  let elapsed = 0
  autoPoll.timerId = setInterval(async () => {
    elapsed += 3
    await refreshLoginStatus()
    await refreshOverview()
    const s = state.loginSession
    if (!s || s.authenticated || s.expired || elapsed >= 120) stopAutoPoll()
  }, 3000)
}

function stopAutoPoll() {
  clearInterval(autoPoll.timerId)
  autoPoll.timerId = null
}

async function withLoading(btn, fn) {
  const orig = btn.textContent
  btn.disabled = true
  btn.textContent = '处理中…'
  try {
    await fn()
  } finally {
    btn.disabled = false
    btn.textContent = orig
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const message = data?.error?.message || data?.message || `Request failed: ${response.status}`
    throw new Error(message)
  }

  return data
}

function showToast(message, isError = false) {
  els.toast.textContent = message
  els.toast.classList.toggle('error', isError)
  els.toast.classList.add('visible')
  window.clearTimeout(showToast.timer)
  showToast.timer = window.setTimeout(() => {
    els.toast.classList.remove('visible')
  }, 2400)
}

function formatDuration(ms) {
  if (!ms) return '-'
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

function formatTps(outputTokens, durationMs) {
  if (!outputTokens || !durationMs) return '-'
  return `${(outputTokens / (durationMs / 1000)).toFixed(1)} t/s`
}

function formatDate(value) {
  if (!value) {
    return '-'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return String(value)
  }
  return date.toLocaleString()
}

function formatCooldown(value) {
  if (!value) {
    return '-'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return '-'
  }

  const remainingMs = date.getTime() - Date.now()
  if (remainingMs <= 0) {
    return '就绪'
  }

  return `${Math.ceil(remainingMs / 1000)}s`
}

function formatAccountName(account) {
  if (!account) {
    return '-'
  }

  if (account.email) {
    return account.email
  }

  if (account.source === 'environment') {
    return '环境变量账号'
  }

  return account.accountId || '-'
}

function accountStatusPill(label, tone = 'neutral') {
  const toneClass = tone === 'ok' ? 'badge-success' : tone === 'err' ? 'badge-error' : tone === 'warn' ? 'badge-warning' : 'badge-muted'
  return `<span class="badge ${toneClass}">${label}</span>`
}

function summarizeUnavailableModes(account, activeMode) {
  const unavailableModes =
    account?.unavailableModes && typeof account.unavailableModes === 'object'
      ? account.unavailableModes
      : {}

  const current = unavailableModes[activeMode]
  if (current?.reason) {
    return {
      label: '当前模式不可用',
      tone: 'err',
      detail: `${activeMode}: ${current.reason}`,
    }
  }

  const firstEntry = Object.entries(unavailableModes).find(
    ([, value]) => value?.reason,
  )
  if (firstEntry) {
    return {
      label: '部分模式受限',
      tone: 'err',
      detail: `${firstEntry[0]}: ${firstEntry[1].reason}`,
    }
  }

  return null
}

function describeAccountStatus(account, activeMode) {
  if (!account?.inPool) {
    return {
      label: '停用',
      tone: 'err',
      detail: account?.lastFailureReason || '',
    }
  }

  if (account?.lastFailureLevel === 'blocking') {
    return {
      label: '不可用',
      tone: 'err',
      detail: account?.lastFailureReason || '该账号当前不可用。',
    }
  }

  const unavailable = summarizeUnavailableModes(account, activeMode)
  if (unavailable) {
    return unavailable
  }

  if (account?.isCoolingDown) {
    return {
      label: `冷却 ${formatCooldown(account.cooldownUntil)}`,
      tone: 'warn',
      detail: account?.lastFailureReason || '最近请求失败，暂时降权。',
    }
  }

  return {
    label: '就绪',
    tone: 'ok',
    detail: '',
  }
}

function populateModeDropdown(modes, selectedValue) {
  const options = Array.isArray(modes) && modes.length > 0 ? modes : fallbackModes
  els.configMode.innerHTML = options
    .map((mode) => `<option value="${mode.value}">${mode.label}</option>`)
    .join('')
  els.configMode.value = selectedValue || options[0]?.value || 'free'
}

function resolveModeDefinition(config) {
  const modes =
    Array.isArray(config.availableModes) && config.availableModes.length > 0
      ? config.availableModes
      : fallbackModes
  return (
    modes.find((mode) => mode.value === (config.mode || config.costMode)) ||
    modes[0] ||
    fallbackModes[0]
  )
}

function renderAccount(overview) {
  const auth = overview.auth
  const accounts = Array.isArray(overview.accounts) ? overview.accounts : []
  const activeMode = overview?.config?.mode || overview?.config?.costMode || 'free'

  els.authPill.textContent = auth.authenticated
    ? `${auth.availableAccounts || 0} 个可用账号`
    : '未登录'
  els.authPill.className = `badge ${auth.authenticated ? 'badge-success' : 'badge-error'}`

  if (els.connectionStatus) {
    els.connectionStatus.textContent = auth.authenticated ? '已连接' : '未连接'
    els.connectionStatus.className = `connection-status ${auth.authenticated ? 'connected' : 'disconnected'}`
  }

  els.authSummary.innerHTML = `
    <div class="config-pills">
      <div class="config-pill">
        <span class="config-pill-label">可用账号</span>
        <span class="config-pill-value">${auth.availableAccounts || 0}</span>
      </div>
      <div class="config-pill">
        <span class="config-pill-label">总账号数</span>
        <span class="config-pill-value">${auth.totalAccounts || 0}</span>
      </div>
      <div class="config-pill">
        <span class="config-pill-label">环境账号</span>
        <span class="config-pill-value">${auth.environmentAccountPresent ? '有' : '无'}</span>
      </div>
    </div>`

  const s = state.loginSession
  const loginUrl = s?.loginUrl

  if (s?.authenticated) {
    els.loginUrlBox.innerHTML = `
      <div class="callout callout-success">
        <p class="callout-title">账号已加入池</p>
        <p class="muted text-sm" style="margin-top: 4px;">${s.email || s.accountId || '新账号'} 已保存到本地，可参与新会话轮训。</p>
      </div>`
    els.loginActions.innerHTML = `
      <button class="button button-primary" data-action="start-login">新增登录账号</button>`
  } else if (loginUrl && s?.expired) {
    els.loginUrlBox.innerHTML = `
      <div class="callout callout-error">
        <p class="callout-title">登录链接已过期</p>
        <p class="muted text-sm" style="margin-top: 4px;">请重新生成登录链接后在浏览器中完成验证。</p>
      </div>`
    els.loginActions.innerHTML = `
      <button class="button button-primary" data-action="start-login">重新生成登录链接</button>`
  } else if (loginUrl) {
    const polling = !!autoPoll.timerId
    els.loginUrlBox.innerHTML = `
      <div class="callout callout-accent">
        <p class="callout-title">登录链接${polling ? '<span class="poll-dot"></span>' : ''}</p>
        <div class="url-row" style="margin-top: 8px;">
          <a href="${loginUrl}" target="_blank" rel="noreferrer">${loginUrl}</a>
          <button class="button button-ghost button-sm" data-action="copy-url" data-url="${loginUrl}">复制</button>
        </div>
        <p class="login-status login-status-waiting" style="margin-top: 8px;">
          ${polling ? '自动检测中，请在浏览器完成登录…' : s?.note || '登录流程已启动，请在浏览器中完成登录。'}
        </p>
      </div>`
    els.loginActions.innerHTML = `
      <button class="button button-primary" data-action="open-url" data-url="${loginUrl}">在浏览器中打开</button>
      <button class="button button-secondary" data-action="check-login">手动检查状态</button>
      <button class="button button-ghost" data-action="start-login">重新生成</button>`
  } else {
    els.loginUrlBox.innerHTML = `
      <div class="callout">
        <p class="muted text-sm">点击新增登录账号后会生成官方 Codebuff 登录地址，可连续加入多个账号。</p>
      </div>`
    els.loginActions.innerHTML = `
      <button class="button button-primary" data-action="start-login">新增登录账号</button>`
  }

  els.accountsList.innerHTML = ''
  if (accounts.length === 0) {
    els.accountsList.innerHTML = '<div class="empty">当前还没有可用账号。</div>'
    return
  }

  els.accountsList.innerHTML = `
    <div class="account-pool-header">
      <div class="account-pool-title-row">
        <div class="account-pool-title-group">
          <h3 class="account-pool-title">账号池</h3>
          <span class="account-pool-meta">按近期性能自动选择 · 优先高 TPS 账号</span>
        </div>
        <span class="badge badge-muted">${accounts.length} 个账号</span>
      </div>
    </div>
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>账号</th>
            <th>来源</th>
            <th>TPS</th>
            <th>延迟</th>
            <th>状态</th>
            <th>会话</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${accounts
            .map(
              (account) => {
                const status = describeAccountStatus(account, activeMode)
                return `
                <tr>
                  <td>
                    <div class="account-cell-main">${formatAccountName(account)}</div>
                    <div class="account-subline">${account.accountId}</div>
                  </td>
                  <td>${account.source || '-'}</td>
                  <td>${account.avgTps ? `<span class="numeric-cell">${account.avgTps} t/s</span>` : '-'}</td>
                  <td>${account.avgDurationMs ? `<span class="numeric-cell">${formatDuration(account.avgDurationMs)}</span>` : '-'}</td>
                  <td>
                    ${accountStatusPill(status.label, status.tone)}
                    ${status.detail ? `<div class="account-subline" style="margin-top: 6px; white-space: normal;">${status.detail}</div>` : ''}
                  </td>
                  <td>${account.boundSessionCount || 0}</td>
                  <td class="account-action-cell">
                    ${
                      account.readOnly
                        ? '<span class="badge badge-muted">只读</span>'
                        : `<button class="button button-danger button-sm" data-action="logout-account" data-account-id="${account.accountId}">登出</button>`
                    }
                  </td>
                </tr>`
              },
            )
            .join('')}
        </tbody>
      </table>
    </div>`
}

function renderConfig(overview) {
  const config = overview.config
  els.configModelAlias.value = config.modelAlias || ''
  const mode = config.mode || config.costMode || 'free'
  const modeDefinition = resolveModeDefinition(config)
  populateModeDropdown(config.availableModes, mode)
  els.configModeHelp.textContent =
    modeDefinition?.description || '选择 Codebuff 模式；保存后会重建现有会话。'

  if (els.pillMode) {
    els.pillMode.textContent = modeDefinition?.label || mode || '-'
  }
  if (els.pillModel) {
    els.pillModel.textContent = config.backendModel || '-'
  }
  if (els.pillAgent) {
    els.pillAgent.textContent = config.agentId || modeDefinition?.agentId || '-'
  }

  const availableModels = Array.isArray(config.availableBackendModels)
    ? config.availableBackendModels
    : (fallbackBackendModels[mode] ?? fallbackBackendModels.free)

  const selectedBackendModel =
    config.backendModel || availableModels[0]?.value || ''

  populateModelDropdown(availableModels, selectedBackendModel)
  els.configAllowPaidFallback.checked = config.allowPaidModeFallback === true

  const modelAlias = config.modelAlias || 'freebuff-bridge'
  els.tutorialModelAlias.textContent = modelAlias
  els.tutorialModelCommand.textContent = `claude --model ${modelAlias}`
  els.tutorialSettingsJson.textContent = `{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8765",
    "ANTHROPIC_API_KEY": "dummy"
  },
  "model": "${modelAlias}"
}`
}

function formatNumber(value, digits = 0) {
  const num = Number(value || 0)
  if (!Number.isFinite(num)) return digits > 0 ? '0.00' : '0'
  return num.toLocaleString('zh-CN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function computeUsageStats(summary, records) {
  const list = Array.isArray(records) ? records : []
  const successCount = list.filter((record) => !record.errorSummary && !record.error).length
  const failureCount = Math.max(list.length - successCount, 0)
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  const recent = list.filter((record) => {
    const time = new Date(record.createdAt).getTime()
    return Number.isFinite(time) && time >= oneHourAgo
  })
  const recentRequests = recent.length
  const recentTokens = recent.reduce((sum, record) => sum + Number(record.totalTokens || 0), 0)

  return {
    totalRequests: Number(summary?.requests || 0),
    totalTokens: Number(summary?.totalTokens || 0),
    promptTokens: Number(summary?.promptTokens || 0),
    outputTokens: Number(summary?.outputTokens || 0),
    successCount,
    failureCount,
    rpm: recentRequests,
    tpm: recentTokens,
  }
}

function createStatCard({ title, value, meta, tone = 'neutral' }) {
  const card = document.createElement('div')
  card.className = `usage-stat-card usage-stat-card-${tone}`
  card.innerHTML = `
    <div class="usage-stat-card-title">${title}</div>
    <div class="usage-stat-card-value">${value}</div>
    ${meta ? `<div class="usage-stat-card-meta">${meta}</div>` : ''}
  `
  return card
}

function renderSummary(summary, records = []) {
  const stats = computeUsageStats(summary, records)
  els.summaryCards.innerHTML = ''

  els.summaryCards.append(
    createStatCard({
      title: '总请求数',
      value: formatNumber(stats.totalRequests),
      meta: `成功: ${formatNumber(stats.successCount)} · 失败: ${formatNumber(stats.failureCount)}`,
      tone: 'primary',
    })
  )
  els.summaryCards.append(
    createStatCard({
      title: '总Token数',
      value: formatNumber(stats.totalTokens, 2),
      meta: `输入 / 输出 Tokens 统计`,
      tone: 'success',
    })
  )
  els.summaryCards.append(
    createStatCard({
      title: 'RPM (每分钟请求)',
      value: formatNumber(stats.rpm, 2),
      meta: `最近1分钟请求速率`,
      tone: 'warning',
    })
  )
  els.summaryCards.append(
    createStatCard({
      title: 'TPM (每分钟Token)',
      value: formatNumber(stats.tpm, 2),
      meta: `最近1分钟Token速率`,
      tone: 'error',
    })
  )
  els.summaryCards.append(
    createStatCard({
      title: '总花费',
      value: '--',
      meta: `费用统计功能开发中`,
      tone: 'primary',
    })
  )
}

function renderCompatibility(overview) {
  const compatibility = overview.compatibility || {}
  const recentErrors = compatibility.recentErrors || []
  const sourceSummary = compatibility.toolSourceSummary || {}

  els.compatibilityCard.innerHTML = `
    <div class="config-pills" style="margin-bottom: var(--spacing-md);">
      <div class="config-pill">
        <span class="config-pill-label">协议</span>
        <span class="config-pill-value">${compatibility.protocol || '-'}</span>
      </div>
      <div class="config-pill">
        <span class="config-pill-label">原生工具</span>
        <span class="config-pill-value">${compatibility.supportsNativeTools ? '✓ 支持' : '✗ 不支持'}</span>
      </div>
      <div class="config-pill">
        <span class="config-pill-label">MCP 工具</span>
        <span class="config-pill-value">${compatibility.supportsMcpTools ? '✓ 支持' : '✗ 不支持'}</span>
      </div>
      <div class="config-pill">
        <span class="config-pill-label">插件工具</span>
        <span class="config-pill-value">${compatibility.supportsInstalledPluginTools ? '✓ 支持' : '✗ 不支持'}</span>
      </div>
    </div>
    <p class="muted text-sm" style="margin-bottom: var(--spacing-md);">
      工具来源统计：builtin ${sourceSummary.builtin || 0} / mcp ${sourceSummary.mcp || 0} / plugin ${sourceSummary.plugin || 0}
    </p>
    <div class="stack-sm">
      ${
        recentErrors.length === 0
          ? '<div class="empty" style="padding: var(--spacing-md);">最近没有协议或工具错误。</div>'
          : recentErrors
              .map(
                (item) => `<div class="callout">
                  <div style="font-weight: 600; margin-bottom: 4px;">${item.session}</div>
                  <div class="muted text-sm">${formatDate(item.createdAt)}</div>
                  <div class="muted text-sm" style="margin-top: 4px;">${item.errorSummary}</div>
                </div>`,
              )
              .join('')
      }
    </div>
  `
}

function renderSessions(overview) {
  const sessions = overview.sessions
  els.sessionsList.innerHTML = ''

  if (sessions.length === 0) {
    els.sessionsList.innerHTML = '<div class="empty">当前还没有活跃的桥接会话。</div>'
    return
  }

  for (const session of sessions) {
    const card = document.createElement('div')
    card.className = 'session-card'
    card.innerHTML = `
      <div class="session-header">
        <div>
          <div class="section-title">会话</div>
          <div class="session-title">${session.session}</div>
        </div>
        <button class="button button-ghost button-sm" data-reset-session="${session.session}">重置</button>
      </div>
      <div class="session-meta">
        <div class="meta-item">
          <span class="meta-label">轮次</span>
          <span class="meta-value">${session.turns}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">请求数</span>
          <span class="meta-value">${session.usage.requests}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">总 Tokens</span>
          <span class="meta-value">${session.usage.totalTokens}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">最近账号</span>
          <span class="meta-value">${session.accountEmail || session.accountId || '-'}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">模式</span>
          <span class="meta-value">${session.costMode || 'free'}</span>
        </div>
      </div>
      <div class="session-details">
        <div>最近切换: ${formatDate(session.lastAccountSwitchAt)}</div>
        <div>切换原因: ${session.lastAccountSwitchReason || '-'}</div>
        <div>client_id: ${session.codebuffMetadata?.client_id || '-'}</div>
        <div>run_id: ${session.codebuffMetadata?.run_id || '-'}</div>
      </div>
    `
    els.sessionsList.append(card)
  }
}

function renderUsageRecords(records) {
  els.usageTable.innerHTML = ''

  if (records.length === 0) {
    els.usageTable.innerHTML = '<tr><td colspan="12" class="empty">当前还没有使用记录。</td></tr>'
    return
  }

  for (const record of records.slice(0, 50)) {
    const row = document.createElement('tr')
    row.innerHTML = `
      <td>${formatDate(record.createdAt)}</td>
      <td>${record.accountEmail || record.accountId || '-'}</td>
      <td>${record.session}</td>
      <td>${record.requestKind}${record.stream ? ' · 流式' : ''}</td>
      <td>${record.model}</td>
      <td>${record.promptTokens}</td>
      <td>${record.outputTokens}</td>
      <td>${record.totalTokens}</td>
      <td>${record.toolCount || 0}</td>
      <td>${record.stopReason || '-'}</td>
      <td>${formatDuration(record.durationMs)}</td>
      <td>${formatTps(record.outputTokens, record.durationMs)}</td>
    `
    els.usageTable.append(row)
  }
}

function updateTime() {
  if (els.currentTime) {
    const now = new Date()
    els.currentTime.textContent = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    if (els.usageUpdatedAt) {
      els.usageUpdatedAt.textContent = `更新于：${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
    }
  }
}

async function refreshOverview() {
  const overview = await request('/v1/freebuff/admin/overview', { headers: {} })
  state.overview = overview
  renderAccount(overview)
  renderConfig(overview)
  renderSummary(overview.usage.summary, overview.usage.records)
  renderCompatibility(overview)
  renderSessions(overview)
  renderUsageRecords(overview.usage.records)
}

async function refreshLoginStatus() {
  try {
    state.loginSession = await request('/v1/freebuff/login/status?session=login', {
      headers: {},
    })
  } catch {
    state.loginSession = null
  }
}

async function refreshAll() {
  await refreshLoginStatus()
  await refreshOverview()
  updateTime()
  const s = state.loginSession
  if (!autoPoll.timerId && s?.loginUrl && !s?.authenticated && !s?.expired) {
    startAutoPoll()
  }
}

async function refreshUsageOnly() {
  const data = await request('/v1/freebuff/usage')
  renderSummary(data.summary, data.records)
  renderUsageRecords(data.records)
}

els.refreshAll.addEventListener('click', async () => {
  try {
    await withLoading(els.refreshAll, () => refreshAll())
    showToast('面板已刷新')
  } catch (e) {
    showToast(e.message, true)
  }
})

els.refreshUsage.addEventListener('click', async () => {
  try {
    await withLoading(els.refreshUsage, () => refreshUsageOnly())
    showToast('Token 统计已刷新')
  } catch (e) {
    showToast(e.message, true)
  }
})

els.autoRefreshSelect.addEventListener('change', () => {
  const seconds = Number(els.autoRefreshSelect.value)
  setAutoRefresh(seconds)
  showToast(seconds > 0 ? `已开启自动刷新（${seconds}s）` : '已关闭自动刷新')
})

els.configMode.addEventListener('change', async () => {
  const selectedMode = els.configMode.value
  const availableModes =
    state.overview?.config?.availableModes || fallbackModes
  const modeDefinition =
    availableModes.find((mode) => mode.value === selectedMode) ||
    fallbackModes.find((mode) => mode.value === selectedMode) ||
    fallbackModes[0]
  els.configModeHelp.textContent =
    modeDefinition?.description || '选择 Codebuff 模式；保存后会重建现有会话。'

  if (els.pillMode) {
    els.pillMode.textContent = modeDefinition?.label || selectedMode
  }
  if (els.pillAgent) {
    els.pillAgent.textContent = modeDefinition?.agentId || '-'
  }

  try {
    const res = await request(`/v1/freebuff/models?mode=${selectedMode}`)
    const models = res.models ?? []
    populateModelDropdown(models, models[0]?.value ?? '')
  } catch (_) {
    populateModelDropdown(
      fallbackBackendModels[selectedMode] ?? fallbackBackendModels.free,
      '',
    )
  }
})

document.addEventListener('click', async (event) => {
  const btn = event.target.closest('[data-action]')
  if (!btn) return

  const action = btn.dataset.action
  const url = btn.dataset.url

  if (action === 'start-login') {
    try {
      await withLoading(btn, async () => {
        state.loginSession = await request('/v1/freebuff/login', {
          method: 'POST',
          body: JSON.stringify({ reset: true }),
        })
        stopAutoPoll()
        renderAccount(
          state.overview || {
            auth: {
              authenticated: false,
              availableAccounts: 0,
              totalAccounts: 0,
              environmentAccountPresent: false,
            },
            accounts: [],
          },
        )
        startAutoPoll()
      })
      showToast('登录链接已生成')
    } catch (e) {
      showToast(e.message, true)
    }
  } else if (action === 'open-url') {
    window.open(url, '_blank', 'noreferrer')
  } else if (action === 'copy-url') {
    navigator.clipboard.writeText(url).then(() => showToast('链接已复制')).catch((e) => showToast(e.message, true))
  } else if (action === 'check-login') {
    try {
      await withLoading(btn, async () => {
        await refreshLoginStatus()
        await refreshOverview()
      })
      showToast(state.loginSession?.authenticated ? '登录已完成' : '登录仍在等待中')
    } catch (e) {
      showToast(e.message, true)
    }
  } else if (action === 'logout-account') {
    try {
      await withLoading(btn, async () => {
        await request('/v1/freebuff/logout', {
          method: 'POST',
          body: JSON.stringify({
            accountId: btn.dataset.accountId,
          }),
        })
        if (state.loginSession?.accountId === btn.dataset.accountId) {
          state.loginSession = null
        }
        stopAutoPoll()
        await refreshLoginStatus()
        await refreshOverview()
      })
      showToast('账号已登出')
    } catch (e) {
      showToast(e.message, true)
    }
  }
})

els.resetUsage.addEventListener('click', async () => {
  try {
    await withLoading(els.resetUsage, async () => {
      await request('/v1/freebuff/usage/reset', {
        method: 'POST',
        body: JSON.stringify({}),
      })
      await refreshOverview()
    })
    showToast('使用记录已清空')
  } catch (e) {
    showToast(e.message, true)
  }
})

els.configForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  try {
    await withLoading(event.submitter, async () => {
      await request('/v1/freebuff/config', {
        method: 'POST',
        body: JSON.stringify({
          modelAlias: els.configModelAlias.value,
          mode: els.configMode.value,
          backendModel: els.configBackendModel.value,
          allowPaidModeFallback: els.configAllowPaidFallback.checked,
        }),
      })
      await refreshOverview()
    })
    showToast('运行配置已保存')
  } catch (e) {
    showToast(e.message, true)
  }
})

els.sessionsList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-reset-session]')
  if (!button) {
    return
  }

  try {
    await withLoading(button, async () => {
      await request('/v1/freebuff/reset', {
        method: 'POST',
        body: JSON.stringify({
          session: button.dataset.resetSession.replace(/^freebuff-bridge-/, ''),
        }),
      })
      await refreshOverview()
    })
    showToast('会话已重置')
  } catch (e) {
    showToast(e.message, true)
  }
})

setInterval(updateTime, 60000)

function navigateTo(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'))
  document.querySelectorAll('.top-nav-link').forEach(l => l.classList.remove('active'))
  const targetPage = document.getElementById(`page-${page}`)
  const targetLink = document.querySelector(`.top-nav-link[data-page="${page}"]`)
  if (targetPage) targetPage.classList.add('active')
  if (targetLink) targetLink.classList.add('active')
}

function handleHashRoute() {
  const hash = location.hash.replace('#', '') || 'overview'
  navigateTo(hash)
}

window.addEventListener('hashchange', handleHashRoute)

refreshAll().catch((error) => {
  showToast(error.message, true)
})

handleHashRoute()
