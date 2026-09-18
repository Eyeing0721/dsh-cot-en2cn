/**
 * dsh-cot-en2cn — host half.
 *
 * Owns the settings document and the translation engine, and exposes them to
 * the browser half over same-origin routes:
 *
 *   GET  /dsh-cot-en2cn/state          effective config + engine counters
 *   PUT  /dsh-cot-en2cn/config         persist one settings section
 *   POST /dsh-cot-en2cn/translate      translate one thinking block
 *   GET  /dsh-cot-en2cn/providers      model routes DSH currently advertises
 *   GET  /dsh-cot-en2cn/models         models of one provider route
 *   POST /dsh-cot-en2cn/cache/clear    drop the translation cache
 *
 * The plugin never writes to the session log. The original English reasoning is
 * what the model produced and what the transcript keeps; only the browser adds
 * a Chinese reading aid next to it.
 *
 * @module dsh-cot-en2cn
 */
import { DEFAULT_CONFIG, TARGET_LANGUAGES, normalizeConfig } from './config.js'
import { createTranslationEngine } from './engine.js'
import { createConfigStore } from './store.js'

export const name = 'dsh-cot-en2cn'

// `webServer` is the last service to register in the web profile, so waiting
// for it also guarantees `llm` and `agentDefaultModel` are live by then.
export const inject = ['webServer']

/** Keep in sync with package.json. */
const VERSION = '0.1.0'

const ROUTE_PREFIX = '/dsh-cot-en2cn'
const ROUTES = {
  state: `${ROUTE_PREFIX}/state`,
  config: `${ROUTE_PREFIX}/config`,
  translate: `${ROUTE_PREFIX}/translate`,
  providers: `${ROUTE_PREFIX}/providers`,
  models: `${ROUTE_PREFIX}/models`,
  cacheClear: `${ROUTE_PREFIX}/cache/clear`,
}

/** A translate body carries at most one clipped reasoning block. */
const MAX_BODY_BYTES = 1024 * 1024
/** Absolute ceiling for one submitted text, before settings clamping. */
const MAX_TEXT_CHARS = 200000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Same-origin browser mutation guard, mirroring the shipped plugins. */
function isSameOriginMutation(req) {
  const host = req.headers.host
  const origin = req.headers.origin
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  if (typeof origin === 'string') {
    try {
      const parsed = new URL(origin)
      return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host && loopbackHost
    } catch {
      return false
    }
  }
  return loopbackHost && req.headers['sec-fetch-site'] === 'same-origin'
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

async function readJsonBody(req) {
  req.setEncoding('utf8')
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('请求体过大（超过 1 MiB）')
  }
  if (text.length === 0) throw new Error('请求体不能为空')
  const value = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象')
  return value
}

export async function apply(ctx) {
  const webServer = ctx.get('webServer')

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`cot-en2cn: ${message}`)
    } catch {
      /* logger is optional */
    }
  }
  const info = (message) => {
    try {
      ctx.logger?.info?.(`cot-en2cn: ${message}`)
    } catch {
      /* logger is optional */
    }
  }

  // ------------------------------------------------------------------ settings

  const store = createConfigStore()
  const loaded = store.load()
  let config = loaded.config
  if (loaded.source === 'file') info(`settings loaded from ${store.path}`)
  else if (loaded.source === 'invalid') {
    warn(`settings file unusable (${loaded.error ?? 'unknown'}); falling back to defaults`)
  }

  // -------------------------------------------------------------------- engine

  /**
   * Resolve the route one translation call uses: the explicit override pair
   * when both halves are set, otherwise the agent default model.
   */
  function currentRoute() {
    if (config.provider !== '' && config.model !== '') {
      return { provider: config.provider, model: config.model, source: 'override' }
    }
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (
      selection !== null &&
      selection !== undefined &&
      typeof selection.provider === 'string' &&
      selection.provider !== '' &&
      typeof selection.model === 'string' &&
      selection.model !== ''
    ) {
      return { provider: selection.provider, model: selection.model, source: 'default' }
    }
    throw new Error('没有可用的模型路由：请在设置里填写 provider/model，或先给 DSH 配好默认模型')
  }

  const engine = createTranslationEngine({
    getConfig: () => config,
    getLlm: () => ctx.get('llm'),
    getRoute: currentRoute,
    log: (level, message) => {
      if (level === 'warn') warn(message)
      else info(message)
    },
  })

  function statePayload() {
    let route
    try {
      route = currentRoute()
    } catch (error) {
      route = { provider: '', model: '', source: 'unavailable', error: errorMessage(error) }
    }
    return {
      ok: true,
      version: VERSION,
      config,
      defaults: DEFAULT_CONFIG,
      configPath: store.path,
      configSource: loaded.source,
      route,
      stats: engine.state(),
      languages: TARGET_LANGUAGES,
    }
  }

  // -------------------------------------------------------------------- routes

  function route(path, handler) {
    if (webServer === undefined) return
    ctx.effect(() => {
      try {
        return webServer.register({ kind: 'exact', path, handler })
      } catch (error) {
        warn(`route register failed (${path}): ${errorMessage(error)}`)
        return () => {}
      }
    }, `dsh-cot-en2cn: ${path}`)
  }

  /** Reject anything that is not this machine's own browser. */
  function guardLocal(req, res, method) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: '该接口仅允许本机访问' })
      return false
    }
    if (req.method !== method) {
      res.setHeader('allow', method)
      sendJson(res, 405, { ok: false, error: `只接受 ${method}` })
      return false
    }
    return true
  }

  route(ROUTES.state, async (req, res) => {
    if (!guardLocal(req, res, 'GET')) return
    sendJson(res, 200, statePayload())
  })

  route(ROUTES.config, async (req, res) => {
    if (req.method !== 'PUT' && req.method !== 'POST') {
      res.setHeader('allow', 'PUT, POST')
      sendJson(res, 405, { ok: false, error: '只接受 PUT/POST' })
      return
    }
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !isSameOriginMutation(req)) {
      sendJson(res, 403, { ok: false, error: '配置写入需要来自本机、同源的浏览器请求' })
      return
    }
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
      sendJson(res, 415, { ok: false, error: '请用 application/json 提交配置' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const section = body.section
      if (typeof section !== 'object' || section === null || Array.isArray(section)) {
        throw new Error('缺少 section 对象')
      }
      const next = normalizeConfig({ ...config, ...section })
      store.save(next)
      config = next
      sendJson(res, 200, statePayload())
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorMessage(error) })
    }
  })

  route(ROUTES.translate, async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: '只接受 POST' })
      return
    }
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !isSameOriginMutation(req)) {
      // Loopback alone is not enough: a cross-origin page in the user's own
      // browser could otherwise trigger paid model calls it cannot even read.
      sendJson(res, 403, { ok: false, error: '翻译接口只接受本机、同源的浏览器请求' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const text = body.text
      if (typeof text !== 'string') throw new Error('text 必须是字符串')
      if (text.length > MAX_TEXT_CHARS) throw new Error(`text 过长（上限 ${MAX_TEXT_CHARS} 字符）`)
      if (!config.enabled) {
        sendJson(res, 200, { ok: true, translation: text, skipped: 'disabled', chunks: 0, cached: true, ms: 0 })
        return
      }
      const result = await engine.translate(text, { force: body.force === true })
      sendJson(res, 200, result)
    } catch (error) {
      // Model and route failures are reported in-band so the panel can render
      // the reason next to the block that failed.
      sendJson(res, 502, { ok: false, error: errorMessage(error), stats: engine.state() })
    }
  })

  route(ROUTES.providers, async (req, res) => {
    if (!guardLocal(req, res, 'GET')) return
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.listProviders !== 'function') {
      sendJson(res, 200, { ok: false, error: 'LLM 服务不可用', providers: [] })
      return
    }
    try {
      const providers = llm.listProviders().map((entry) => ({ id: entry.id, name: entry.name ?? entry.id }))
      sendJson(res, 200, { ok: true, providers })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: errorMessage(error), providers: [] })
    }
  })

  route(ROUTES.models, async (req, res) => {
    if (!guardLocal(req, res, 'GET')) return
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.listModels !== 'function') {
      sendJson(res, 200, { ok: false, error: 'LLM 服务不可用', models: [] })
      return
    }
    let provider = ''
    try {
      provider = new URL(req.url ?? '/', 'http://localhost').searchParams.get('provider') ?? ''
    } catch {
      provider = ''
    }
    if (provider === '') {
      sendJson(res, 400, { ok: false, error: '缺少 provider 参数', models: [] })
      return
    }
    try {
      const models = await llm.listModels(provider)
      sendJson(res, 200, { ok: true, models: models.map((entry) => ({ id: entry.id, name: entry.name ?? entry.id })) })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: errorMessage(error), models: [] })
    }
  })

  route(ROUTES.cacheClear, async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: '只接受 POST' })
      return
    }
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !isSameOriginMutation(req)) {
      sendJson(res, 403, { ok: false, error: '仅允许本机同源请求' })
      return
    }
    const cleared = engine.clearCache()
    sendJson(res, 200, { ok: true, cleared, stats: engine.state() })
  })

  if (webServer === undefined) warn('webServer service missing; routes NOT registered')
  else info(`ready (routes under ${ROUTE_PREFIX})`)
}

export { DEFAULT_CONFIG }
