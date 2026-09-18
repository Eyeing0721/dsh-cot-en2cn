/**
 * dsh-cot-en2cn — host integration test.
 *
 * Boots the real host half (`lib/index.js`) against a minimal cordis-shaped
 * context, captures the routes it registers, and drives every handler with
 * fake `req`/`res` objects — including a real config file on disk under a
 * throwaway `$DSH_HOME`.
 *
 * This is what proves the parts `tools/smoke.mjs` cannot: route wiring, HTTP
 * guards, the settings round trip, and the engine being reachable end to end
 * through `/translate`.
 *
 * Run: node tools/host-integration.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')

// The plugin resolves its config through $DSH_HOME, so point that at a scratch
// directory before the module is loaded.
const home = mkdtempSync(join(tmpdir(), 'cot-en2cn-host-'))
process.env.DSH_HOME = home

const plugin = await import(pathToFileURL(join(lib, 'index.js')).href)
const { createConfigStore } = await import(pathToFileURL(join(lib, 'store.js')).href)

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

// ------------------------------------------------------------------ test doubles

/** A fake `llm` service that echoes a marker for every translated chunk. */
function createFakeLlm() {
  const calls = []
  let failure = null
  return {
    calls,
    failWith(error) {
      failure = error
    },
    listProviders() {
      return [{ id: 'fake', name: 'Fake provider' }]
    },
    async listModels(provider) {
      if (provider !== 'fake') throw new Error(`unknown provider ${provider}`)
      return [{ id: 'fake-1', name: 'Fake One' }]
    },
    async *stream(request) {
      calls.push(request)
      if (failure !== null) throw failure
      const core = request.messages[0].content[0].text
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `[中文] ${core}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** Build a cordis-shaped context and capture the routes the plugin registers. */
async function boot(options = {}) {
  const routes = new Map()
  const effects = []
  const llm = createFakeLlm()
  const services = {
    llm,
    agentDefaultModel: options.noDefaultModel === true ? undefined : { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) },
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
  }
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => services[name],
    on: () => () => {},
    effect: (fn) => {
      const dispose = fn()
      effects.push(dispose)
      return dispose
    },
  }
  await plugin.apply(ctx)
  return { routes, llm, effects }
}

function makeReq({ method = 'GET', path = '/', headers = {}, body, remoteAddress = '127.0.0.1' } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url: path,
    headers: {
      host: '127.0.0.1:3080',
      origin: 'http://127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      ...headers,
    },
    socket: { remoteAddress },
    setEncoding() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      res.headers[String(key).toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined) res.body += String(chunk)
    },
  }
  return res
}

/** Drive one captured route. */
async function call(routes, path, requestOptions) {
  const handler = routes.get(path)
  assert.ok(handler !== undefined, `no route registered for ${path}`)
  const res = makeRes()
  await handler(makeReq({ path, ...requestOptions }), res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { status: res.statusCode, headers: res.headers, json, raw: res.body }
}

// ------------------------------------------------------------------------ tests

process.stdout.write(`host integration (DSH_HOME=${home})\n`)

const { routes, llm } = await boot()

await test('every documented route is registered', () => {
  for (const path of [
    '/dsh-cot-en2cn/state',
    '/dsh-cot-en2cn/config',
    '/dsh-cot-en2cn/translate',
    '/dsh-cot-en2cn/providers',
    '/dsh-cot-en2cn/models',
    '/dsh-cot-en2cn/cache/clear',
  ]) {
    assert.ok(routes.has(path), `missing route ${path}`)
  }
})

await test('GET /state reports defaults, the route, and the config path', async () => {
  const response = await call(routes, '/dsh-cot-en2cn/state')
  assert.equal(response.status, 200)
  assert.equal(response.json.ok, true)
  assert.equal(response.json.config.enabled, true)
  assert.equal(response.json.config.targetLanguage, 'zh-CN')
  assert.deepEqual(response.json.route, { provider: 'fake', model: 'fake-1', source: 'default' })
  assert.equal(response.json.configPath, join(home, 'storages', 'cot-en2cn', 'config.json'))
  assert.equal(response.json.languages.length, 4)
})

await test('GET /state is loopback-only', async () => {
  const response = await call(routes, '/dsh-cot-en2cn/state', { remoteAddress: '10.0.0.5' })
  assert.equal(response.status, 403)
  assert.equal(response.json.ok, false)
})

await test('POST /translate returns a translation and caches it', async () => {
  const text = 'Let me read the file and check the failing assertion.'
  const first = await call(routes, '/dsh-cot-en2cn/translate', { method: 'POST', body: { text } })
  assert.equal(first.status, 200)
  assert.equal(first.json.ok, true)
  assert.equal(first.json.translation, `[中文] ${text}`)
  assert.equal(first.json.cached, false)
  const second = await call(routes, '/dsh-cot-en2cn/translate', { method: 'POST', body: { text } })
  assert.equal(second.json.cached, true)
  assert.equal(llm.calls.length, 1)
})

await test('POST /translate marks already-Chinese text as skipped', async () => {
  const response = await call(routes, '/dsh-cot-en2cn/translate', {
    method: 'POST',
    body: { text: '这段思维链本来就是中文，不需要翻译，也不该花钱。' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.skipped, 'already-chinese')
  assert.equal(llm.calls.length, 1)
})

await test('POST /translate rejects a wrong method, a bad body, and a remote caller', async () => {
  const wrongMethod = await call(routes, '/dsh-cot-en2cn/translate', { method: 'GET' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.headers.allow, 'POST')

  const badBody = await call(routes, '/dsh-cot-en2cn/translate', { method: 'POST', body: { text: 42 } })
  assert.equal(badBody.status, 502)
  assert.match(String(badBody.json.error), /text 必须是字符串/)

  const remote = await call(routes, '/dsh-cot-en2cn/translate', {
    method: 'POST',
    body: { text: 'hello there, translate me please.' },
    remoteAddress: '8.8.8.8',
  })
  assert.equal(remote.status, 403)
})

await test('POST /translate is disabled while the master switch is off', async () => {
  await call(routes, '/dsh-cot-en2cn/config', { method: 'PUT', body: { section: { enabled: false } } })
  const response = await call(routes, '/dsh-cot-en2cn/translate', {
    method: 'POST',
    body: { text: 'This must not reach the model at all.' },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.skipped, 'disabled')
  assert.equal(llm.calls.length, 1)
  await call(routes, '/dsh-cot-en2cn/config', { method: 'PUT', body: { section: { enabled: true } } })
})

await test('PUT /config persists to disk and survives a reload', async () => {
  const response = await call(routes, '/dsh-cot-en2cn/config', {
    method: 'PUT',
    body: { section: { provider: 'fake', model: 'fake-1', maxChunkChars: 999999, targetLanguage: 'ja' } },
  })
  assert.equal(response.status, 200)
  assert.equal(response.json.config.maxChunkChars, 20000, 'clamped on write')
  assert.equal(response.json.config.targetLanguage, 'ja')
  assert.deepEqual(response.json.route, { provider: 'fake', model: 'fake-1', source: 'override' })

  const file = join(home, 'storages', 'cot-en2cn', 'config.json')
  assert.ok(existsSync(file), 'config file was not written')
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.version, 1)
  assert.equal(onDisk.config.provider, 'fake')
  assert.equal(onDisk.config.targetLanguage, 'ja')

  const reopened = createConfigStore().load()
  assert.equal(reopened.source, 'file')
  assert.equal(reopened.config.model, 'fake-1')
  assert.equal(reopened.config.maxChunkChars, 20000)
})

await test('PUT /config rejects cross-origin, wrong content type, and a missing section', async () => {
  const crossOrigin = await call(routes, '/dsh-cot-en2cn/config', {
    method: 'PUT',
    body: { section: { enabled: false } },
    headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' },
  })
  assert.equal(crossOrigin.status, 403)

  const wrongType = await call(routes, '/dsh-cot-en2cn/config', {
    method: 'PUT',
    body: { section: {} },
    headers: { 'content-type': 'text/plain' },
  })
  assert.equal(wrongType.status, 415)

  const noSection = await call(routes, '/dsh-cot-en2cn/config', { method: 'PUT', body: { nope: true } })
  assert.equal(noSection.status, 400)
  assert.match(String(noSection.json.error), /section/)
})

await test('GET /providers and /models report the LLM catalogue', async () => {
  const providers = await call(routes, '/dsh-cot-en2cn/providers')
  assert.equal(providers.status, 200)
  assert.deepEqual(providers.json.providers, [{ id: 'fake', name: 'Fake provider' }])

  const models = await call(routes, '/dsh-cot-en2cn/models', { path: '/dsh-cot-en2cn/models?provider=fake' })
  assert.equal(models.status, 200)
  assert.deepEqual(models.json.models, [{ id: 'fake-1', name: 'Fake One' }])

  const missing = await call(routes, '/dsh-cot-en2cn/models')
  assert.equal(missing.status, 400)

  const unknown = await call(routes, '/dsh-cot-en2cn/models', { path: '/dsh-cot-en2cn/models?provider=nope' })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.json.ok, false)
  assert.deepEqual(unknown.json.models, [])
})

await test('POST /cache/clear drops cached chunks', async () => {
  const text = 'A fresh sentence that is not cached yet, honestly.'
  await call(routes, '/dsh-cot-en2cn/translate', { method: 'POST', body: { text } })
  const before = await call(routes, '/dsh-cot-en2cn/state')
  assert.ok(before.json.stats.cacheSize > 0)
  const cleared = await call(routes, '/dsh-cot-en2cn/cache/clear', { method: 'POST', body: {} })
  assert.equal(cleared.status, 200)
  assert.ok(cleared.json.cleared > 0)
  assert.equal(cleared.json.stats.cacheSize, 0)
})

await test('a model failure is reported in band with 502', async () => {
  llm.failWith(new Error('上游 429'))
  const response = await call(routes, '/dsh-cot-en2cn/translate', {
    method: 'POST',
    body: { text: 'This call is going to fail upstream for sure.' },
  })
  assert.equal(response.status, 502)
  assert.equal(response.json.ok, false)
  assert.match(String(response.json.error), /429/)
  llm.failWith(null)
})

await test('without a default model the route is reported unavailable', async () => {
  const { routes: bareRoutes } = await boot({ noDefaultModel: true })
  // The earlier tests left a provider/model override on disk; clear it so this
  // boot really has no route at all.
  const cleared = await call(bareRoutes, '/dsh-cot-en2cn/config', {
    method: 'PUT',
    body: { section: { provider: '', model: '' } },
  })
  assert.equal(cleared.json.config.provider, '')
  const state = await call(bareRoutes, '/dsh-cot-en2cn/state')
  assert.equal(state.json.route.source, 'unavailable')
  assert.match(String(state.json.route.error), /模型路由/)
  const translate = await call(bareRoutes, '/dsh-cot-en2cn/translate', {
    method: 'POST',
    body: { text: 'No route exists, so this must fail cleanly.' },
  })
  assert.equal(translate.status, 502)
  assert.match(String(translate.json.error), /模型路由/)
})

await test('no route is registered when webServer is absent', async () => {
  const captured = []
  const ctx = {
    logger: { info() {}, warn() {} },
    get: (name) => (name === 'webServer' ? undefined : undefined),
    on: () => () => {},
    effect: (fn) => {
      captured.push(fn)
      return () => {}
    },
  }
  await plugin.apply(ctx)
  assert.equal(captured.length, 0)
})

rmSync(home, { recursive: true, force: true })

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
