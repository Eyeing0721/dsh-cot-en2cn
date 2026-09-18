/**
 * dsh-cot-en2cn — browser half (web platform).
 *
 * Two surfaces, one job: let a Chinese reader read the model's English
 * chain-of-thought without editing it.
 *
 *  1. Inline translator. Reasoning rows are shipped by ui-chat's `ReasoningRow`
 *     and there is no slot for a single reasoning block, so this half is a
 *     progressive enhancement over the rendered DOM: it finds each thinking row
 *     (`[data-variant="think"]`), and once the row is expanded it appends a
 *     Chinese translation panel right under the reasoning text. The original
 *     English is never touched, moved, or hidden — remove this plugin and the
 *     GUI is byte-identical to the stock one.
 *
 *  2. Settings section under Settings → Plugins: master switch, translation
 *     model, target language, budget knobs, cache controls and a live test box.
 *
 * Everything it needs from the host arrives over `/dsh-cot-en2cn/*`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cot-en2cn',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    /** Host routes, all same-origin. */
    const API = {
      state: '/dsh-cot-en2cn/state',
      config: '/dsh-cot-en2cn/config',
      translate: '/dsh-cot-en2cn/translate',
      providers: '/dsh-cot-en2cn/providers',
      models: '/dsh-cot-en2cn/models',
      cacheClear: '/dsh-cot-en2cn/cache/clear',
    }

    const LOCALE_NS = 'cot-en2cn'
    /** A thinking block shorter than this is not worth a model call. */
    const MIN_CHARS = 12
    /** Throttle for the DOM reconcile pass. */
    const SYNC_INTERVAL_MS = 220
    /** Quiet period before a still-streaming block is translated live. */
    const LIVE_DEBOUNCE_MS = 1400
    /** How often the translator re-reads the host config. */
    const CONFIG_POLL_MS = 15000
    /** Client-side translation cache entries. */
    const CLIENT_CACHE_LIMIT = 400

    const PANEL_ATTR = 'data-dsh-cot-en2cn'

    const MESSAGES = {
      zh: {
        section: 'CoT 英文转中文',
        'status.label': '状态',
        'badge.on': '已开启',
        'badge.off': '已关闭',
        'badge.error': '连接失败',
        'row.cache': '译文缓存',
        'row.route': '翻译模型',
        'row.configPath': '配置文件',
        'row.lastError': '最近一次错误',
        'row.lastCall': '最近一次调用',
        'heading.basic': '基础',
        'setting.enabled': '启用 CoT 中文翻译',
        'setting.enabledHint': '在每段「思考」下方显示中文译文，原文不改动。',
        'setting.auto': '展开时自动翻译',
        'setting.autoHint': '关闭后，每段思考需要手动点「翻译」。',
        'setting.live': '思考过程中也翻译',
        'setting.liveHint': '模型还在思考时就翻译（会重复调用模型，费 token）。',
        'heading.model': '翻译模型',
        'setting.provider': 'Provider',
        'setting.model': '模型',
        'setting.modelHint': '留空 = 跟随 DSH 默认模型。翻译是纯体力活，建议选便宜快的小模型。',
        'button.fetchModels': '拉取模型列表',
        'button.useDefault': '用默认模型',
        'setting.disableThinking': '关闭思考（推荐）',
        'setting.disableThinkingHint': '借用辅助请求通道，让翻译请求不产生思考 token。',
        'heading.advanced': '高级',
        'setting.language': '目标语言',
        'setting.chunk': '单块字符数',
        'setting.concurrency': '并发请求数',
        'setting.timeout': '单次超时',
        'setting.cacheEntries': '服务端缓存条数',
        'setting.skipChinese': '跳过已是中文的思考',
        'setting.fontSize': '译文文字大小',
        'unit.chars': '字符',
        'unit.seconds': '秒',
        'unit.entries': '条',
        'unit.px': 'px',
        'heading.test': '试译',
        'test.placeholder': '粘贴一段英文思维链，点「试译」看看效果',
        'button.test': '试译',
        'button.clearCache': '清空服务端缓存',
        'button.save': '保存',
        'button.reset': '恢复默认',
        'save.saved': '已保存',
        'save.failed': '保存失败',
        'test.running': '翻译中…',
        'test.failed': '翻译失败',
        'panel.title': '中文译文',
        'panel.cached': '缓存',
        'panel.settling': '模型还在思考，结束后自动翻译…',
        'panel.live': '边思考边翻译…',
        'panel.waiting': '展开后自动翻译',
        'panel.loading': '翻译中…',
        'panel.retry': '重新翻译',
        'panel.copy': '复制',
        'panel.copied': '已复制',
        'panel.collapse': '收起',
        'panel.expand': '展开',
        'panel.failed': '翻译失败',
        'panel.manual': '翻译这段思考',
        'panel.truncated': '原文过长，仅翻译了前一部分',
      },
      en: {
        section: 'CoT English → Chinese',
        'status.label': 'Status',
        'badge.on': 'Enabled',
        'badge.off': 'Disabled',
        'badge.error': 'Connection error',
        'row.cache': 'Translation cache',
        'row.route': 'Translation model',
        'row.configPath': 'Config file',
        'row.lastError': 'Last error',
        'row.lastCall': 'Last call',
        'heading.basic': 'Basics',
        'setting.enabled': 'Enable CoT translation',
        'setting.enabledHint': 'Show a Chinese translation under every thinking block; the original is untouched.',
        'setting.auto': 'Translate on expand',
        'setting.autoHint': 'When off, each block needs a manual click.',
        'setting.live': 'Translate while streaming',
        'setting.liveHint': 'Translate while the model is still thinking (repeated calls, more tokens).',
        'heading.model': 'Translation model',
        'setting.provider': 'Provider',
        'setting.model': 'Model',
        'setting.modelHint': 'Empty = follow the DSH default model. A cheap fast model is usually enough.',
        'button.fetchModels': 'Fetch models',
        'button.useDefault': 'Use default model',
        'setting.disableThinking': 'Disable thinking (recommended)',
        'setting.disableThinkingHint': 'Routes the call through the auxiliary channel so it spends no reasoning tokens.',
        'heading.advanced': 'Advanced',
        'setting.language': 'Target language',
        'setting.chunk': 'Characters per chunk',
        'setting.concurrency': 'Concurrent requests',
        'setting.timeout': 'Request timeout',
        'setting.cacheEntries': 'Host cache entries',
        'setting.skipChinese': 'Skip reasoning already in Chinese',
        'setting.fontSize': 'Translation font size',
        'unit.chars': 'chars',
        'unit.seconds': 's',
        'unit.entries': 'entries',
        'unit.px': 'px',
        'heading.test': 'Try it',
        'test.placeholder': 'Paste an English chain of thought and press Translate',
        'button.test': 'Translate',
        'button.clearCache': 'Clear host cache',
        'button.save': 'Save',
        'button.reset': 'Reset to defaults',
        'save.saved': 'Saved',
        'save.failed': 'Save failed',
        'test.running': 'Translating…',
        'test.failed': 'Translation failed',
        'panel.title': 'Chinese',
        'panel.cached': 'cached',
        'panel.settling': 'Still thinking — translating when it settles…',
        'panel.live': 'Translating while it thinks…',
        'panel.waiting': 'Translate on expand',
        'panel.loading': 'Translating…',
        'panel.retry': 'Retranslate',
        'panel.copy': 'Copy',
        'panel.copied': 'Copied',
        'panel.collapse': 'Collapse',
        'panel.expand': 'Expand',
        'panel.failed': 'Translation failed',
        'panel.manual': 'Translate this thinking block',
        'panel.truncated': 'Source was long; only the first part was translated',
      },
    }

    let t = (key) => MESSAGES.zh[key] ?? key

    // ---------------------------------------------------------------- utilities

    /** Cheap synchronous content hash (djb2 xor), stable inside one page. */
    function hashText(text) {
      let hash = 5381
      for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) + hash) ^ text.charCodeAt(i)
      }
      return (hash >>> 0).toString(36)
    }

    function readJson(response) {
      return response.json().then(
        (value) => {
          if (!response.ok) {
            const message = value !== null && typeof value === 'object' && typeof value.error === 'string'
              ? value.error
              : `HTTP ${response.status}`
            throw new Error(message)
          }
          return value
        },
        () => {
          throw new Error(`HTTP ${response.status}`)
        },
      )
    }

    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
      }).then(readJson)
    }

    function putJson(url, body) {
      return fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
      }).then(readJson)
    }

    // ------------------------------------------------------- inline translator

    /**
     * The inline translator. Deliberately plain DOM code: the reasoning row is
     * rendered by another package and has no slot, so this enhancement only
     * ever *adds* a sibling node next to the reasoning body.
     */
    const translator = {
      /** Live host config; `null` until the first successful fetch. */
      config: null,
      /** text hash -> translation. */
      cache: new Map(),
      /** text hash -> in-flight promise, so two rows never pay twice. */
      inflight: new Map(),
      observer: null,
      syncTimer: null,
      pollTimer: null,
      /** Set once `apply` has run; the router may call apply only once. */
      started: false,
    }

    function clientCacheGet(key) {
      const value = translator.cache.get(key)
      if (value === undefined) return undefined
      translator.cache.delete(key)
      translator.cache.set(key, value)
      return value
    }

    function clientCacheSet(key, value) {
      translator.cache.delete(key)
      translator.cache.set(key, value)
      while (translator.cache.size > CLIENT_CACHE_LIMIT) {
        translator.cache.delete(translator.cache.keys().next().value)
      }
    }

    function fetchState() {
      return fetch(API.state, { cache: 'no-store' }).then(readJson)
    }

    function requestTranslation(text, force) {
      const key = hashText(text)
      const running = translator.inflight.get(key)
      if (running !== undefined) return running
      const task = postJson(API.translate, force === true ? { text, force: true } : { text }).then((payload) => {
        if (payload.ok !== true) throw new Error(String(payload.error ?? 'translation failed'))
        return payload
      })
      translator.inflight.set(key, task)
      const settle = () => {
        if (translator.inflight.get(key) === task) translator.inflight.delete(key)
      }
      task.then(settle, settle)
      return task
    }

    /**
     * Find every reasoning row currently in the document.
     *
     * Primary anchor is the stable `data-variant="think"` attribute shipped by
     * ui-chat's ReasoningRow; the class-substring fallbacks keep the plugin
     * working if that attribute is ever renamed.
     *
     * @returns the reasoning row elements.
     */
    function findReasoningRoots() {
      const roots = document.querySelectorAll('[data-variant="think"]')
      if (roots.length > 0) return Array.from(roots)
      const found = new Set()
      for (const body of document.querySelectorAll('[class*="thinkBody"]')) {
        const root = body.closest('[data-state]')
        if (root !== null) found.add(root)
      }
      return Array.from(found)
    }

    /** The reasoning text container inside one row. */
    function findReasoningBody(root) {
      const direct = root.querySelector('[class*="thinkBody"]')
      if (direct !== null) return direct
      const candidates = Array.from(root.querySelectorAll('div'))
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const node = candidates[i]
        if (node.getAttribute('data-variant') !== null) continue
        if ((node.textContent ?? '').length > 0) return node
      }
      return null
    }

    /** Whether one reasoning row is currently opened by the user. */
    function isOpen(root) {
      if (root.hasAttribute('data-expanded')) return true
      // A collapsed row is a fixed-height strip (~24px). Measuring the real box
      // also covers builds that keep the body mounted behind `overflow:hidden`.
      return root.getBoundingClientRect().height > 48
    }

    const CSS = `
.dsh-cot-en2cn-panel{box-sizing:border-box;margin:6px 0 2px;padding:6px 10px 8px calc(22px + var(--dsh-content-font-delta,0px));border-left:2px solid var(--dsw-alias-state-business-primary,rgba(77,107,254,.65));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));border-radius:0 6px 6px 0;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));overflow-wrap:anywhere}
.dsh-cot-en2cn-head{display:flex;align-items:center;gap:8px;margin-bottom:2px;font-size:11px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));user-select:none}
.dsh-cot-en2cn-title{font-weight:600;letter-spacing:.02em}
.dsh-cot-en2cn-meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}
.dsh-cot-en2cn-actions{display:flex;gap:6px;flex:none}
.dsh-cot-en2cn-btn{border:0;background:transparent;color:inherit;cursor:pointer;padding:0 2px;font:inherit;opacity:.75;text-decoration:underline;text-underline-offset:2px}
.dsh-cot-en2cn-btn:hover{opacity:1}
.dsh-cot-en2cn-body{white-space:pre-wrap;word-break:break-word}
.dsh-cot-en2cn-body[data-collapsed='true']{display:none}
.dsh-cot-en2cn-status{opacity:.7;font-style:italic}
.dsh-cot-en2cn-error{color:var(--dsw-state-error-primary,#d94b4b);white-space:pre-wrap}
.dsh-cot-en2cn-panel[data-fontsize] .dsh-cot-en2cn-body,.dsh-cot-en2cn-panel[data-fontsize] .dsh-cot-en2cn-status,.dsh-cot-en2cn-panel[data-fontsize] .dsh-cot-en2cn-error{font-size:var(--dsh-cot-en2cn-font-size,inherit)}
`
    let styleInjected = false

    function injectStyle() {
      if (styleInjected) return
      styleInjected = true
      const style = document.createElement('style')
      style.setAttribute('data-dsh-cot-en2cn-style', '1')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function panelButton(action, label) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dsh-cot-en2cn-btn'
      button.setAttribute('data-act', action)
      button.textContent = label
      return button
    }

    /** Create the (still empty) panel element for one reasoning body. */
    function createPanel() {
      const panel = document.createElement('div')
      panel.className = 'dsh-cot-en2cn-panel'
      panel.setAttribute(PANEL_ATTR, 'panel')

      const head = document.createElement('div')
      head.className = 'dsh-cot-en2cn-head'
      head.setAttribute('data-role', 'head')

      const title = document.createElement('span')
      title.className = 'dsh-cot-en2cn-title'
      title.setAttribute('data-role', 'title')
      title.textContent = t('panel.title')

      const meta = document.createElement('span')
      meta.className = 'dsh-cot-en2cn-meta'
      meta.setAttribute('data-role', 'meta')

      const actions = document.createElement('span')
      actions.className = 'dsh-cot-en2cn-actions'
      actions.setAttribute('data-role', 'actions')

      const retry = panelButton('retry', t('panel.retry'))
      const copy = panelButton('copy', t('panel.copy'))
      const manual = panelButton('manual', t('panel.manual'))
      const toggle = panelButton('toggle', t('panel.collapse'))
      actions.append(manual, retry, copy, toggle)

      head.append(title, meta, actions)

      const status = document.createElement('div')
      status.className = 'dsh-cot-en2cn-status'
      status.setAttribute('data-role', 'status')
      status.hidden = true

      const error = document.createElement('div')
      error.className = 'dsh-cot-en2cn-error'
      error.setAttribute('data-role', 'error')
      error.hidden = true

      const body = document.createElement('div')
      body.className = 'dsh-cot-en2cn-body'
      body.setAttribute('data-role', 'body')
      body.hidden = true

      panel.append(head, status, error, body)
      return panel
    }

    function panelPart(panel, role) {
      return panel.querySelector(`[data-role="${role}"]`)
    }

    function setStatus(panel, text) {
      const status = panelPart(panel, 'status')
      if (status === null) return
      status.textContent = text ?? ''
      status.hidden = text === undefined || text === null || text === ''
    }

    function setError(panel, message) {
      const error = panelPart(panel, 'error')
      if (error === null) return
      error.textContent = message ?? ''
      error.hidden = message === undefined || message === null || message === ''
    }

    function renderTranslation(panel, payload) {
      const body = panelPart(panel, 'body')
      if (body === null) return
      body.textContent = String(payload.translation ?? '')
      body.hidden = false
      const meta = panelPart(panel, 'meta')
      if (meta !== null) {
        const route = payload.route
        const model = route === undefined || route === null ? '' : `${route.provider}/${route.model}`
        const bits = []
        if (model !== '') bits.push(model)
        if (payload.cached === true) bits.push(t('panel.cached'))
        if (typeof payload.ms === 'number' && payload.cached !== true) bits.push(`${Math.round(payload.ms)}ms`)
        if (payload.skipped === 'truncated') bits.push(t('panel.truncated'))
        meta.textContent = bits.join(' · ')
      }
      panel.dataset.state = 'done'
      setStatus(panel, '')
      setError(panel, '')
      const manual = panel.querySelector('[data-act="manual"]')
      if (manual !== null) manual.hidden = true
    }

    function beginTranslation(panel, text, key, force) {
      panel.__sourceText = text
      panel.dataset.srcKey = key
      panel.dataset.srcLength = String(text.length)
      panel.dataset.state = 'loading'
      setError(panel, '')
      setStatus(panel, t('panel.loading'))
      const manual = panel.querySelector('[data-act="manual"]')
      if (manual !== null) manual.hidden = true
      requestTranslation(text, force)
        .then((payload) => {
          clientCacheSet(key, payload)
          if (panel.dataset.srcKey !== key || !panel.isConnected) return
          renderTranslation(panel, payload)
        })
        .catch((error) => {
          if (panel.dataset.srcKey !== key || !panel.isConnected) return
          panel.dataset.state = 'error'
          setStatus(panel, '')
          setError(panel, `${t('panel.failed')}：${error instanceof Error ? error.message : String(error)}`)
          const manual = panel.querySelector('[data-act="manual"]')
          if (manual !== null) manual.hidden = false
        })
    }

    /** Reconcile one reasoning row with its panel. */
    function syncRow(root, config) {
      const body = findReasoningBody(root)
      if (body === null) return null
      if (!isOpen(root)) return null
      const text = (body.textContent ?? '').trim()
      if (text.length < MIN_CHARS) return null
      const running = root.getAttribute('data-state') === 'running'

      const host = body.parentElement ?? root
      let panel = host.querySelector(`:scope > [${PANEL_ATTR}="panel"]`)
      if (panel === null && host !== root) panel = root.querySelector(`:scope > [${PANEL_ATTR}="panel"]`)
      if (panel === null) {
        panel = createPanel()
        body.after(panel)
      }
      panel.style.setProperty('--dsh-cot-en2cn-font-size', `${config.fontSizePx ?? 13}px`)
      panel.setAttribute('data-fontsize', '1')
      const meta = panelPart(panel, 'meta')
      if (meta !== null && panel.dataset.state !== 'done') meta.textContent = ''
      panel.__sourceText = text

      const key = hashText(text)
      if (panel.dataset.srcKey === key && panel.dataset.state !== 'idle') return panel

      const cached = clientCacheGet(key)
      if (cached !== undefined) {
        renderTranslation(panel, cached)
        return panel
      }
      if (config.autoTranslate !== true) {
        panel.dataset.srcKey = key
        panel.dataset.state = 'idle'
        setStatus(panel, t('panel.waiting'))
        const manual = panel.querySelector('[data-act="manual"]')
        if (manual !== null) manual.hidden = false
        return panel
      }
      if (running && config.liveTranslate !== true) {
        // Hold the panel open with an honest status instead of translating a
        // half-finished block: the text is still changing, and a translation of
        // it would be thrown away. An empty srcKey lets the settle re-enter.
        panel.dataset.srcKey = ''
        panel.dataset.state = 'settling'
        setStatus(panel, t('panel.settling'))
        const manual = panel.querySelector('[data-act="manual"]')
        if (manual !== null) manual.hidden = true
        return panel
      }
      if (running && config.liveTranslate === true) {
        // Keep the newest source text, translate once the stream calms down.
        panel.dataset.srcKey = key
        panel.dataset.state = 'streaming'
        setStatus(panel, t('panel.live'))
        if (panel.__liveTimer !== undefined) clearTimeout(panel.__liveTimer)
        panel.__liveTimer = setTimeout(() => {
          panel.__liveTimer = undefined
          if (panel.isConnected && panel.dataset.srcKey === key) beginTranslation(panel, text, key, false)
        }, LIVE_DEBOUNCE_MS)
        return panel
      }
      beginTranslation(panel, text, key, false)
      return panel
    }

    /** One reconcile pass over every reasoning row in the document. */
    function sync() {
      const config = translator.config
      if (config === null) return
      if (config.enabled !== true) {
        removeAllPanels()
        return
      }
      const keep = new Set()
      const roots = findReasoningRoots()
      const limit = Math.min(roots.length, 80)
      for (let i = 0; i < limit; i += 1) {
        const panel = syncRow(roots[i], config)
        if (panel !== null) keep.add(panel)
      }
      for (const panel of document.querySelectorAll(`[${PANEL_ATTR}="panel"]`)) {
        if (!keep.has(panel)) panel.remove()
      }
    }

    function removeAllPanels() {
      for (const panel of document.querySelectorAll(`[${PANEL_ATTR}="panel"]`)) panel.remove()
    }

    function safeSync() {
      try {
        sync()
      } catch (error) {
        console.warn('cot-en2cn: reconcile failed', error)
      }
    }

    function scheduleSync() {
      if (translator.syncTimer !== null) return
      translator.syncTimer = setTimeout(() => {
        translator.syncTimer = null
        safeSync()
      }, SYNC_INTERVAL_MS)
    }

    /**
     * One delegated click listener for every panel action. Delegation means
     * panels survive React re-renders without re-binding anything.
     */
    function onDocumentClick(event) {
      const target = event.target
      if (!(target instanceof Element)) return
      const button = target.closest(`[${PANEL_ATTR}="panel"] [data-act]`)
      if (button === null) return
      const panel = button.closest(`[${PANEL_ATTR}="panel"]`)
      if (panel === null) return
      const action = button.getAttribute('data-act')
      event.preventDefault()
      event.stopPropagation()
      const body = panelPart(panel, 'body')
      if (action === 'copy') {
        const text = body === null ? '' : body.textContent ?? ''
        if (text !== '' && navigator.clipboard !== undefined) {
          navigator.clipboard.writeText(text).then(
            () => {
              button.textContent = t('panel.copied')
              setTimeout(() => {
                button.textContent = t('panel.copy')
              }, 1200)
            },
            () => {},
          )
        }
        return
      }
      if (action === 'toggle') {
        if (body === null) return
        const collapsed = body.getAttribute('data-collapsed') === 'true'
        body.setAttribute('data-collapsed', collapsed ? 'false' : 'true')
        button.textContent = collapsed ? t('panel.collapse') : t('panel.expand')
        return
      }
      if (action === 'retry' || action === 'manual') {
        const source = panel.__sourceText
        if (typeof source !== 'string' || source.length === 0) return
        beginTranslation(panel, source, hashText(source), action === 'retry')
      }
    }

    /**
     * Start the inline translator. Idempotent: the client router may apply the
     * plugin once per page, but a hot reload can call it again.
     *
     * @param locale - optional client locale service, for panel copy.
     */
    function startTranslator(locale) {
      if (translator.started) return
      if (typeof document === 'undefined') return
      translator.started = true
      injectStyle()

      translator.observer = new MutationObserver(() => {
        scheduleSync()
      })
      translator.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-expanded', 'data-state'],
      })
      document.addEventListener('click', onDocumentClick, true)

      const refresh = () => {
        fetchState()
          .then((payload) => {
            translator.config = payload.config ?? null
            safeSync()
          })
          .catch((error) => {
            // A failed poll leaves the last known config in place; the settings
            // panel is where the user sees the connection error.
            console.warn('cot-en2cn: state fetch failed', error)
          })
      }
      refresh()
      translator.pollTimer = setInterval(refresh, CONFIG_POLL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh()
      })
      if (locale !== undefined) {
        try {
          locale.subscribe(() => scheduleSync())
        } catch {
          /* locale is best-effort */
        }
      }
      safeSync()
    }

    // ------------------------------------------------------------ settings UI

    const styles = {
      panel: { display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)' },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      column: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { flex: 1, color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: 12, opacity: 0.65, marginTop: -2 },
      heading: { margin: 0, fontSize: 12, fontWeight: 600, opacity: 0.7, marginTop: 12 },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 },
      badgeBase: { display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 12, border: '1px solid var(--dsw-alias-border-l2)', whiteSpace: 'nowrap' },
      badgeOn: { color: 'var(--dsw-state-success-primary, #2f9e44)' },
      badgeOff: { color: 'var(--dsw-alias-label-tertiary)' },
      badgeErr: { color: 'var(--dsw-state-error-primary, #d94b4b)' },
      error: { color: 'var(--dsw-state-error-primary, #d94b4b)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      input: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-primary)', padding: '4px 8px', font: 'inherit', minWidth: 0 },
      number: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-primary)', padding: '4px 8px', font: 'inherit', width: 92 },
      textarea: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-primary)', padding: '6px 8px', font: 'inherit', minHeight: 72, resize: 'vertical' },
      button: { minHeight: 30, padding: '0 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 15, background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', font: 'inherit' },
      checkbox: { width: 16, height: 16, accentColor: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      result: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '8px 10px', maxHeight: 260, overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1, transparent)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, opacity: 0.8 },
    }

    const NUMBER_FIELDS = [
      { key: 'maxChunkChars', label: 'setting.chunk', unit: 'unit.chars' },
      { key: 'concurrency', label: 'setting.concurrency', unit: null },
      { key: 'timeoutMs', label: 'setting.timeout', unit: 'unit.seconds', scale: 1000 },
      { key: 'cacheEntries', label: 'setting.cacheEntries', unit: 'unit.entries' },
      { key: 'fontSizePx', label: 'setting.fontSize', unit: 'unit.px' },
    ]

    const BOOLEAN_FIELDS = [
      { key: 'enabled', label: 'setting.enabled', hint: 'setting.enabledHint' },
      { key: 'autoTranslate', label: 'setting.auto', hint: 'setting.autoHint' },
      { key: 'liveTranslate', label: 'setting.live', hint: 'setting.liveHint' },
      { key: 'disableThinking', label: 'setting.disableThinking', hint: 'setting.disableThinkingHint' },
      { key: 'skipMostlyChinese', label: 'setting.skipChinese', hint: null },
    ]

    function createSection(translate, locale) {
      function Section() {
        const [state, setState] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [error, setError] = React.useState('')
        const [notice, setNotice] = React.useState('')
        const [testInput, setTestInput] = React.useState('')
        const [testResult, setTestResult] = React.useState(null)
        const [testing, setTesting] = React.useState(false)
        const [models, setModels] = React.useState(null)
        // Text fields edit a local draft; the 5s status poll must not clobber
        // half-typed provider/model values.
        const dirty = React.useRef(false)

        const apply = React.useCallback((payload) => {
          setState(payload)
          if (!dirty.current) setDraft(payload.config)
        }, [])

        const refresh = React.useCallback(() => {
          fetchState()
            .then((payload) => {
              apply(payload)
              setError('')
            })
            .catch((reason) => setError(String(reason && reason.message ? reason.message : reason)))
        }, [apply])

        React.useEffect(() => {
          refresh()
          const timer = setInterval(refresh, 5000)
          return () => clearInterval(timer)
        }, [refresh])

        const save = (patch) => {
          const next = { ...(draft ?? {}), ...patch }
          dirty.current = false
          setDraft(next)
          putJson(API.config, { section: next })
            .then((payload) => {
              apply(payload)
              setNotice(translate('save.saved'))
              setError('')
              setTimeout(() => setNotice(''), 1500)
            })
            .catch((reason) => {
              setError(`${translate('save.failed')}：${reason && reason.message ? reason.message : reason}`)
            })
        }

        const runTest = () => {
          const text = testInput.trim()
          if (text === '') return
          setTesting(true)
          setTestResult(null)
          postJson(API.translate, { text })
            .then((payload) => {
              setTestResult({ ok: true, text: String(payload.translation ?? ''), meta: payload })
            })
            .catch((reason) => {
              setTestResult({ ok: false, text: String(reason && reason.message ? reason.message : reason) })
            })
            .then(() => setTesting(false))
        }

        const clearCache = () => {
          postJson(API.cacheClear, {})
            .then((payload) => {
              if (state !== null) setState({ ...state, stats: payload.stats })
              setNotice(translate('button.clearCache'))
              setTimeout(() => setNotice(''), 1500)
            })
            .catch((reason) => setError(String(reason && reason.message ? reason.message : reason)))
        }

        const fetchModels = () => {
          const provider = (draft ?? {}).provider ?? ''
          if (provider === '') {
            setError(translate('setting.modelHint'))
            return
          }
          fetch(`${API.models}?provider=${encodeURIComponent(provider)}`, { cache: 'no-store' })
            .then(readJson)
            .then((payload) => setModels(payload.models ?? []))
            .catch((reason) => setError(String(reason && reason.message ? reason.message : reason)))
        }

        let badge = [translate('badge.off'), styles.badgeOff]
        if (error !== '') badge = [translate('badge.error'), styles.badgeErr]
        else if (state !== null) {
          badge = state.config.enabled ? [translate('badge.on'), styles.badgeOn] : [translate('badge.off'), styles.badgeOff]
        }

        const stats = state === null ? null : state.stats
        const route = state === null ? null : state.route

        const numberInput = (field) => {
          const scale = field.scale ?? 1
          const value = draft === null ? '' : String(Math.round((draft[field.key] ?? 0) / scale))
          return h(
            'div',
            { style: styles.row, key: field.key },
            h('span', { style: styles.label }, translate(field.label)),
            h('input', {
              type: 'number',
              style: styles.number,
              value,
              onChange: (event) => {
                const raw = Number(event.target.value)
                if (!Number.isFinite(raw)) return
                save({ [field.key]: Math.round(raw * scale) })
              },
            }),
            field.unit === null ? null : h('span', { style: styles.hint }, translate(field.unit)),
          )
        }

        const booleanRow = (field) =>
          h(
            'div',
            { key: field.key, style: styles.column },
            h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, translate(field.label)),
              h('input', {
                type: 'checkbox',
                style: styles.checkbox,
                checked: draft !== null && draft[field.key] === true,
                onChange: (event) => save({ [field.key]: event.target.checked }),
              }),
            ),
            field.hint === null || field.hint === undefined
              ? null
              : h('div', { style: styles.hint }, translate(field.hint)),
          )

        const languageOptions = state === null
          ? []
          : state.languages.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label))

        const modelListId = 'dsh-cot-en2cn-models'

        return h(
          'div',
          { style: styles.panel },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, translate('status.label')),
            h('span', { style: { ...styles.badgeBase, ...badge[1] } }, badge[0]),
            notice !== '' ? h('span', { style: styles.hint }, notice) : null,
          ),
          error !== '' ? h('div', { style: styles.error }, error) : null,
          h(
            'div',
            { style: styles.card },
            h(
              'div',
              { style: styles.row },
              h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.route')),
              h('span', { style: styles.mono }, route === null ? '…' : `${route.provider || '—'} / ${route.model || '—'}`),
            ),
            h(
              'div',
              { style: styles.row },
              h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.cache')),
              h('span', null, stats === null ? '…' : `${stats.cacheSize} · hit ${stats.hits} · call ${stats.requests}`),
            ),
            stats !== null && stats.lastMs !== null
              ? h(
                  'div',
                  { style: styles.row },
                  h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.lastCall')),
                  h('span', null, `${stats.lastRoute ?? '—'} · ${stats.lastMs}ms`),
                )
              : null,
            stats !== null && stats.lastError !== null
              ? h(
                  'div',
                  { style: styles.row },
                  h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.lastError')),
                  h('span', { style: styles.error }, stats.lastError),
                )
              : null,
            state !== null && state.configPath
              ? h(
                  'div',
                  { style: styles.row },
                  h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.configPath')),
                  h('span', { style: styles.mono }, state.configPath),
                )
              : null,
          ),
          h('div', { style: styles.heading }, translate('heading.basic')),
          draft === null ? null : BOOLEAN_FIELDS.slice(0, 3).map(booleanRow),
          h('div', { style: styles.heading }, translate('heading.model')),
          h(
            'div',
            { style: styles.column },
            h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, translate('setting.provider')),
              h('input', {
                style: { ...styles.input, flex: 1 },
                value: draft === null ? '' : draft.provider,
                placeholder: 'deepseek / pi-ai / …',
                onChange: (event) => {
                  dirty.current = true
                  setDraft({ ...draft, provider: event.target.value })
                },
                onBlur: (event) => save({ provider: event.target.value }),
              }),
            ),
            h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, translate('setting.model')),
              h('input', {
                style: { ...styles.input, flex: 1 },
                value: draft === null ? '' : draft.model,
                list: models === null ? undefined : modelListId,
                placeholder: translate('setting.modelHint'),
                onChange: (event) => {
                  dirty.current = true
                  setDraft({ ...draft, model: event.target.value })
                },
                onBlur: (event) => save({ model: event.target.value }),
              }),
            ),
            models === null
              ? null
              : h('datalist', { id: modelListId }, models.map((entry) => h('option', { key: entry.id, value: entry.id }))),
            h(
              'div',
              { style: styles.row },
              h('button', { style: styles.button, type: 'button', onClick: fetchModels }, translate('button.fetchModels')),
              h(
                'button',
                { style: styles.button, type: 'button', onClick: () => save({ provider: '', model: '' }) },
                translate('button.useDefault'),
              ),
            ),
            h('div', { style: styles.hint }, translate('setting.modelHint')),
          ),
          draft === null ? null : BOOLEAN_FIELDS.slice(3).map(booleanRow),
          h('div', { style: styles.heading }, translate('heading.advanced')),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, translate('setting.language')),
            h(
              'select',
              {
                style: styles.input,
                value: draft === null ? 'zh-CN' : draft.targetLanguage,
                onChange: (event) => save({ targetLanguage: event.target.value }),
              },
              languageOptions,
            ),
          ),
          draft === null ? null : NUMBER_FIELDS.map(numberInput),
          h(
            'div',
            { style: styles.row },
            h('button', { style: styles.button, type: 'button', onClick: clearCache }, translate('button.clearCache')),
            h(
              'button',
              {
                style: styles.button,
                type: 'button',
                onClick: () => {
                  if (state !== null && state.defaults !== undefined) save(state.defaults)
                },
              },
              translate('button.reset'),
            ),
          ),
          h('div', { style: styles.heading }, translate('heading.test')),
          h('textarea', {
            style: styles.textarea,
            value: testInput,
            placeholder: translate('test.placeholder'),
            onChange: (event) => setTestInput(event.target.value),
          }),
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              { style: styles.button, type: 'button', onClick: runTest, disabled: testing || testInput.trim() === '' },
              testing ? translate('test.running') : translate('button.test'),
            ),
          ),
          testResult === null
            ? null
            : h(
                'div',
                { style: { ...styles.result, ...(testResult.ok ? {} : styles.error) } },
                testResult.ok ? testResult.text : `${translate('test.failed')}：${testResult.text}`,
              ),
        )
      }

      function LocaleAwareSection() {
        const [, bump] = React.useReducer((count) => count + 1, 0)
        React.useEffect(() => {
          if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
          return locale.subscribe(() => bump())
        }, [])
        return h(Section)
      }

      return LocaleAwareSection
    }

    // ------------------------------------------------------------------- wiring

    function apply(ctx) {
      const locale = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('locale') : undefined

      if (locale !== undefined && typeof locale.register === 'function') {
        try {
          ctx.effect(() => {
            const disposers = [
              locale.register(LOCALE_NS, 'zh', MESSAGES.zh),
              locale.register(LOCALE_NS, 'en', MESSAGES.en),
            ]
            return () => {
              for (const dispose of disposers) dispose()
            }
          })
        } catch (error) {
          console.warn('cot-en2cn: locale registration failed', error)
        }
      }
      if (locale !== undefined && typeof locale.bind === 'function') {
        const bound = locale.bind(LOCALE_NS)
        t = (key, params) => bound(key, params)
      }

      // The inline translator is independent of the slot system: start it even
      // when no slots service is mounted.
      try {
        startTranslator(locale)
      } catch (error) {
        console.warn('cot-en2cn: inline translator failed to start', error)
      }

      const slots = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (slots === undefined) return
      const Section = createSection(t, locale)
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'cot-en2cn',
            order: 240,
            label: () => t('section'),
          },
          Section,
        ),
      )
    }

    module.exports.apply = apply
    module.exports.inject = ['slots']
    return module.exports
  },
})
