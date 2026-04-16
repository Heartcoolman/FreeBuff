const state = {
  overview: null,
  loginSession: null,
}

const fallbackBackendModels = [
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

const els = {
  authPill: document.querySelector('#auth-pill'),
  authEmail: document.querySelector('#auth-email'),
  authSource: document.querySelector('#auth-source'),
  authMeta: document.querySelector('#auth-meta'),
  loginActions: document.querySelector('#login-actions'),
  loginUrlBox: document.querySelector('#login-url-box'),
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
  configAgentId: document.querySelector('#config-agent-id'),
  configBackendModel: document.querySelector('#config-backend-model'),
  configCostMode: document.querySelector('#config-cost-mode'),
  tutorialModelAlias: document.querySelector('#tutorial-model-alias'),
  tutorialModelCommand: document.querySelector('#tutorial-model-command'),
  tutorialSettingsJson: document.querySelector('#tutorial-settings-json'),
  autoRefreshSelect: document.querySelector('#auto-refresh-select'),
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

function renderAccount(overview) {
  const auth = overview.auth
  els.authPill.textContent = auth.authenticated ? '已登录' : '未登录'
  els.authPill.classList.toggle('pill-ok', !!auth.authenticated)
  els.authPill.classList.toggle('pill-err', !auth.authenticated)

  const s = state.loginSession
  const loginUrl = s?.loginUrl

  if (auth.authenticated) {
    els.authEmail.textContent = auth.email || '-'
    els.authSource.textContent = auth.source || '-'
    els.authMeta.style.display = ''
    els.loginUrlBox.innerHTML = ''
    els.loginActions.innerHTML = `
      <div class="button-row">
        <button class="button button-danger" data-action="logout">清除本地登录</button>
      </div>`
  } else if (loginUrl && s?.expired) {
    els.authMeta.style.display = 'none'
    els.loginUrlBox.innerHTML = `
      <div class="callout callout-err">
        <p class="callout-title">登录链接已过期</p>
        <p class="muted" style="margin: 4px 0 0;">请重新生成登录链接后在浏览器中完成验证。</p>
      </div>`
    els.loginActions.innerHTML = `
      <div class="button-row">
        <button class="button button-primary" data-action="start-login">重新生成登录链接</button>
      </div>`
  } else if (loginUrl) {
    const polling = !!autoPoll.timerId
    els.authMeta.style.display = 'none'
    els.loginUrlBox.innerHTML = `
      <div class="callout">
        <p class="callout-title">登录链接${polling ? '<span class="poll-dot"></span>' : ''}</p>
        <div class="url-row">
          <a href="${loginUrl}" target="_blank" rel="noreferrer">${loginUrl}</a>
          <button class="button button-ghost button-sm" data-action="copy-url" data-url="${loginUrl}">复制</button>
        </div>
        <p class="login-status login-status-waiting" style="margin: 6px 0 0;">
          ${polling ? '自动检测中，请在浏览器完成登录…' : s?.note || '登录流程已启动，请在浏览器中完成登录。'}
        </p>
      </div>`
    els.loginActions.innerHTML = `
      <div class="button-row">
        <button class="button button-primary" data-action="open-url" data-url="${loginUrl}">在浏览器中打开</button>
        <button class="button button-ghost" data-action="check-login">手动检查状态</button>
        <button class="button button-ghost" data-action="start-login">重新生成</button>
      </div>`
  } else {
    els.authMeta.style.display = 'none'
    els.loginUrlBox.innerHTML = `
      <div class="callout">
        <p class="muted" style="margin: 0;">点击开始登录后会生成官方 Freebuff 登录地址。</p>
      </div>`
    els.loginActions.innerHTML = `
      <div class="button-row">
        <button class="button button-primary" data-action="start-login">开始登录</button>
      </div>`
  }
}

function renderConfig(overview) {
  const config = overview.config
  els.configModelAlias.value = config.modelAlias || ''
  els.configAgentId.value = config.agentId || ''
  const availableModels = Array.isArray(config.availableBackendModels)
    ? config.availableBackendModels
    : fallbackBackendModels

  const selectedBackendModel =
    config.backendModel ||
    availableModels[0]?.value ||
    fallbackBackendModels[0].value

  const modelOptions = [...availableModels]
  if (!modelOptions.some((model) => model.value === selectedBackendModel)) {
    modelOptions.unshift({
      value: selectedBackendModel,
      label: selectedBackendModel,
      provider: '当前值',
    })
  }

  els.configBackendModel.innerHTML = modelOptions
    .map(
      (model) =>
        `<option value="${model.value}">${model.label} (${model.provider})</option>`,
    )
    .join('')
  els.configBackendModel.value = selectedBackendModel
  els.configCostMode.innerHTML = '<option value="free">free</option>'
  els.configCostMode.value = 'free'

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

function metricCard(label, value, detail) {
  const article = document.createElement('article')
  article.className = 'metric'
  article.innerHTML = `<span>${label}</span><strong>${value}</strong><div class="muted">${detail}</div>`
  return article
}

function renderSummary(summary) {
  els.summaryCards.innerHTML = ''
  els.summaryCards.append(
    metricCard('请求次数', summary.requests, '已记录的桥接请求'),
    metricCard('输入 Tokens', summary.promptTokens, '估算的输入 token 数'),
    metricCard('输出 Tokens', summary.outputTokens, '估算的输出 token 数'),
    metricCard('总 Tokens', summary.totalTokens, '输入 + 输出'),
    metricCard('平均延迟', formatDuration(summary.avgDurationMs), '首字 token 平均耗时'),
    metricCard('平均速度', summary.avgTps ? `${summary.avgTps} t/s` : '-', '输出 token/秒'),
  )
}

function renderCompatibility(overview) {
  const compatibility = overview.compatibility || {}
  const recentErrors = compatibility.recentErrors || []
  const sourceSummary = compatibility.toolSourceSummary || {}

  els.compatibilityCard.innerHTML = `
    <div class="meta-list">
      <div><dt>协议</dt><dd>${compatibility.protocol || '-'}</dd></div>
      <div><dt>原生工具</dt><dd>${compatibility.supportsNativeTools ? '支持' : '不支持'}</dd></div>
      <div><dt>MCP 工具</dt><dd>${compatibility.supportsMcpTools ? '支持' : '不支持'}</dd></div>
      <div><dt>插件工具</dt><dd>${compatibility.supportsInstalledPluginTools ? '支持' : '不支持'}</dd></div>
    </div>
    <div class="muted">工具来源统计：builtin ${sourceSummary.builtin || 0} / mcp ${sourceSummary.mcp || 0} / plugin ${sourceSummary.plugin || 0}</div>
    <div class="stack compact">
      ${
        recentErrors.length === 0
          ? '<div class="empty">最近没有协议或工具错误。</div>'
          : recentErrors
              .map(
                (item) => `<div class="session-card">
                  <div><strong>${item.session}</strong></div>
                  <div class="muted">${formatDate(item.createdAt)}</div>
                  <div class="muted">${item.errorSummary}</div>
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
      <div class="panel-head">
        <div>
          <p class="label">会话</p>
          <h2>${session.session}</h2>
        </div>
        <button class="button button-ghost" data-reset-session="${session.session}">重置</button>
      </div>
      <div class="meta-list">
      <div><dt>轮次</dt><dd>${session.turns}</dd></div>
      <div><dt>请求数</dt><dd>${session.usage.requests}</dd></div>
      <div><dt>总 Tokens</dt><dd>${session.usage.totalTokens}</dd></div>
      <div><dt>计费模式</dt><dd>free</dd></div>
      </div>
      <div class="muted">client_id: ${session.codebuffMetadata?.client_id || '-'}</div>
      <div class="muted">run_id: ${session.codebuffMetadata?.run_id || '-'}</div>
    `
    els.sessionsList.append(card)
  }
}

function renderUsageRecords(records) {
  els.usageTable.innerHTML = ''

  if (records.length === 0) {
    els.usageTable.innerHTML = '<tr><td colspan="11" class="empty">当前还没有使用记录。</td></tr>'
    return
  }

  for (const record of records.slice(0, 50)) {
    const row = document.createElement('tr')
    row.innerHTML = `
      <td>${formatDate(record.createdAt)}</td>
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

async function refreshOverview() {
  const overview = await request('/v1/freebuff/admin/overview', { headers: {} })
  state.overview = overview
  renderAccount(overview)
  renderConfig(overview)
  renderSummary(overview.usage.summary)
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
  const s = state.loginSession
  if (!autoPoll.timerId && s?.loginUrl && !s?.authenticated && !s?.expired) {
    startAutoPoll()
  }
}

async function refreshUsageOnly() {
  const data = await request('/v1/freebuff/usage')
  renderSummary(data.summary)
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
        renderAccount(state.overview || { auth: { authenticated: false } })
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
  } else if (action === 'logout') {
    try {
      await withLoading(btn, async () => {
        await request('/v1/freebuff/logout', {
          method: 'POST',
          body: JSON.stringify({}),
        })
        state.loginSession = null
        stopAutoPoll()
        await refreshOverview()
      })
      showToast('本地登录已清除')
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
          agentId: els.configAgentId.value,
          backendModel: els.configBackendModel.value,
          costMode: els.configCostMode.value,
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

refreshAll().catch((error) => {
  showToast(error.message, true)
})
