/**
 * dsh-cot-en2cn — offline smoke test.
 *
 * Covers the parts that do not need a DSH host or a browser:
 *   - lib/text.js      chunking, script detection, hashing
 *   - lib/engine.js    cache, de-duplication, concurrency, failures, reassembly
 *   - lib/client.js    the browser bundle registers and exports the plugin face
 *
 * Run: node tools/smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')

const { chunkText, looksChinese, normalizeText, splitTrailingSpace, hashText } = await import(
  pathToFileURL(join(lib, 'text.js')).href
)
const { cleanTranslation, createTranslationEngine, translationSystemPrompt } = await import(
  pathToFileURL(join(lib, 'engine.js')).href
)
const { DEFAULT_CONFIG, normalizeConfig } = await import(pathToFileURL(join(lib, 'config.js')).href)
const { configFilePath, createConfigStore, resolveDshHome } = await import(
  pathToFileURL(join(lib, 'store.js')).href
)

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

const BASE_CONFIG = {
  enabled: true,
  autoTranslate: true,
  liveTranslate: false,
  targetLanguage: 'zh-CN',
  provider: '',
  model: '',
  disableThinking: true,
  maxChunkChars: 3000,
  maxInputChars: 24000,
  timeoutMs: 30000,
  concurrency: 2,
  cacheEntries: 100,
  skipMostlyChinese: true,
  showOriginal: false,
  fontSizePx: 13,
}

/** A fake `llm` service: yields one text block and a stop finish. */
function fakeLlm(transform, options = {}) {
  const calls = []
  const state = { active: 0, peak: 0 }
  const llm = {
    calls,
    state,
    async *stream(request) {
      calls.push(request)
      state.active += 1
      state.peak = Math.max(state.peak, state.active)
      try {
        const core = request.messages[0].content[0].text
        if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        if (options.finish !== undefined) {
          yield { type: 'finish', reason: options.finish }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: transform(core, request) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        state.active -= 1
      }
    },
  }
  return llm
}

function makeEngine(llm, configPatch = {}) {
  const config = { ...BASE_CONFIG, ...configPatch }
  return {
    config,
    engine: createTranslationEngine({
      getConfig: () => config,
      getLlm: () => llm,
      getRoute: () => ({ provider: 'fake', model: 'fake-1', source: 'override' }),
      log: () => {},
    }),
  }
}

process.stdout.write('text utilities\n')

await test('normalizeText trims and normalizes CRLF', () => {
  assert.equal(normalizeText('  a\r\nb  '), 'a\nb')
  assert.equal(normalizeText(undefined), '')
})

await test('hashText is stable and content sensitive', () => {
  assert.equal(hashText('abc'), hashText('abc'))
  assert.notEqual(hashText('abc'), hashText('abd'))
})

await test('looksChinese separates Chinese prose from English prose', () => {
  assert.equal(looksChinese('这是一段中文思维链，里面有几个 token 和 tool_call 之类的英文词。'), true)
  assert.equal(looksChinese('Let me check the file and then run the tests.'), false)
  assert.equal(looksChinese(''), false)
})

await test('chunkText never loses a byte and respects the ceiling', () => {
  const source = `${'para one line\n'.repeat(40)}\n${'para two '.repeat(120)}\n\nlast\n`
  for (const limit of [40, 137, 512, 3000]) {
    const chunks = chunkText(source, limit)
    assert.equal(chunks.join(''), source, `reassembly failed at limit ${limit}`)
    for (const chunk of chunks) assert.ok(chunk.length <= limit, `chunk over ${limit}`)
  }
  assert.deepEqual(chunkText('', 10), [])
  assert.deepEqual(chunkText('short', 10), ['short'])
})

await test('chunkText does not split surrogate pairs', () => {
  const source = '😀'.repeat(64)
  const chunks = chunkText(source, 21)
  assert.equal(chunks.join(''), source)
  for (const chunk of chunks) assert.equal([...chunk].every((char) => char === '😀'), true)
})

await test('splitTrailingSpace splits content from its separator', () => {
  assert.deepEqual(splitTrailingSpace('hello\n\n'), { core: 'hello', separator: '\n\n' })
  assert.deepEqual(splitTrailingSpace('\n\n'), { core: '', separator: '\n\n' })
})

process.stdout.write('engine\n')

await test('translate returns the model text and caches it', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`)
  const { engine } = makeEngine(llm)
  const first = await engine.translate('Hello world, this is a long enough sentence.')
  assert.equal(first.ok, true)
  assert.equal(first.translation, '[zh] Hello world, this is a long enough sentence.')
  assert.equal(first.cached, false)
  assert.equal(llm.calls.length, 1)
  const second = await engine.translate('Hello world, this is a long enough sentence.')
  assert.equal(second.cached, true)
  assert.equal(llm.calls.length, 1)
  assert.equal(engine.state().cacheSize, 1)
})

await test('translate reassembles chunk separators exactly', async () => {
  const llm = fakeLlm((core) => core.toUpperCase())
  const { engine } = makeEngine(llm, { maxChunkChars: 60 })
  const source = `${'line one\n'.repeat(12)}\n${'word '.repeat(60)}\n\ntail line\n`
  const expected = normalizeText(source).toUpperCase()
  const result = await engine.translate(source)
  assert.equal(result.translation, expected)
  assert.ok(result.chunks > 1, 'expected the source to be chunked')
  assert.ok(llm.calls.length > 1)
  // Interior blank lines are structural and must survive chunking untouched.
  assert.equal(
    (result.translation.match(/\n\n/g) ?? []).length,
    (expected.match(/\n\n/g) ?? []).length,
  )
  assert.equal((result.translation.match(/\n/g) ?? []).length, (expected.match(/\n/g) ?? []).length)
})

await test('already-Chinese text skips the model', async () => {
  const llm = fakeLlm((core) => core)
  const { engine } = makeEngine(llm)
  const result = await engine.translate('这里已经是中文思考了，不需要再翻译一遍。')
  assert.equal(result.skipped, 'already-chinese')
  assert.equal(llm.calls.length, 0)
  const forced = await engine.translate('这里已经是中文思考了，不需要再翻译一遍。', { force: true })
  assert.equal(forced.skipped, null)
  assert.equal(llm.calls.length, 1)
})

await test('concurrent requests for the same text share one model call', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`, { delayMs: 20 })
  const { engine } = makeEngine(llm)
  const text = 'A single reasoning paragraph that will be requested twice at once.'
  const [a, b] = await Promise.all([engine.translate(text), engine.translate(text)])
  assert.equal(a.translation, b.translation)
  assert.equal(llm.calls.length, 1)
  assert.equal(engine.state().deduped, 1)
})

await test('the concurrency gate serializes model calls', async () => {
  const llm = fakeLlm((core) => core.toUpperCase(), { delayMs: 10 })
  const { engine } = makeEngine(llm, { maxChunkChars: 60, concurrency: 1 })
  const source = Array.from({ length: 20 }, (_, index) => `alpha beta gamma delta ${index}\n`).join('')
  const result = await engine.translate(source)
  assert.equal(result.translation, normalizeText(source).toUpperCase())
  assert.equal(llm.state.peak, 1)
  assert.ok(llm.calls.length > 1, `expected several calls, got ${llm.calls.length}`)
  assert.equal(result.chunks, llm.calls.length)
})

await test('identical chunks collapse into one model call', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`)
  const { engine } = makeEngine(llm, { maxChunkChars: 40, concurrency: 4 })
  const source = `${'same line here\n'.repeat(12)}`
  const result = await engine.translate(source)
  assert.ok(result.chunks > 1, `expected several chunks, got ${result.chunks}`)
  assert.equal(llm.calls.length, 1)
})

await test('a truncated model finish fails the call and is counted', async () => {
  const llm = fakeLlm((core) => core, { finish: { kind: 'max-tokens' } })
  const { engine } = makeEngine(llm)
  await assert.rejects(() => engine.translate('A sentence long enough to be translated.'), /截断/)
  assert.equal(engine.state().failures, 1)
  assert.match(String(engine.state().lastError), /截断/)
})

await test('an empty model reply fails the call', async () => {
  const llm = fakeLlm(() => '   ')
  const { engine } = makeEngine(llm)
  await assert.rejects(() => engine.translate('Another sentence that is long enough.'), /没有返回译文/)
})

await test('maxInputChars clips the source', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`)
  const { engine } = makeEngine(llm, { maxInputChars: 600, maxChunkChars: 200, skipMostlyChinese: false })
  const source = 'word '.repeat(400)
  const result = await engine.translate(source)
  assert.equal(result.skipped, 'truncated')
  assert.ok(result.translation.length < source.length)
})

await test('clearCache empties the cache', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`)
  const { engine } = makeEngine(llm)
  await engine.translate('Some reasoning text that needs translating.')
  assert.equal(engine.state().cacheSize, 1)
  assert.equal(engine.clearCache(), 1)
  assert.equal(engine.state().cacheSize, 0)
})

await test('cacheEntries = 0 disables caching', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`)
  const { engine } = makeEngine(llm, { cacheEntries: 0 })
  await engine.translate('Some reasoning text that needs translating.')
  await engine.translate('Some reasoning text that needs translating.')
  assert.equal(llm.calls.length, 2)
})

await test('a missing llm service fails loudly', async () => {
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG }),
    getLlm: () => undefined,
    getRoute: () => ({ provider: 'fake', model: 'fake-1', source: 'override' }),
  })
  await assert.rejects(() => engine.translate('This needs the llm service to work.'), /LLM 服务不可用/)
})

await test('a missing route fails before any request', async () => {
  const llm = fakeLlm((core) => core)
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG }),
    getLlm: () => llm,
    getRoute: () => {
      throw new Error('没有可用的模型路由')
    },
  })
  await assert.rejects(() => engine.translate('This needs a route to work at all.'), /没有可用的模型路由/)
  assert.equal(llm.calls.length, 0)
})

await test('an empty input is a no-op', async () => {
  const llm = fakeLlm((core) => core)
  const { engine } = makeEngine(llm)
  const result = await engine.translate('   \n  ')
  assert.equal(result.skipped, 'empty')
  assert.equal(llm.calls.length, 0)
})

await test('thinking is disabled through the auxiliary purpose by default', async () => {
  const llm = fakeLlm((core) => core)
  const { engine } = makeEngine(llm)
  await engine.translate('A sentence that must reach the model somehow.')
  assert.equal(llm.calls[0].purpose, 'session-title')
  const llm2 = fakeLlm((core) => core)
  const second = makeEngine(llm2, { disableThinking: false })
  await second.engine.translate('A sentence that must reach the model somehow.')
  assert.equal(llm2.calls[0].purpose, undefined)
})

await test('messages look like a hand-built plugin user message', async () => {
  const llm = fakeLlm((core) => core)
  const { engine } = makeEngine(llm)
  await engine.translate('Message shape check for the plugin source tag.')
  const message = llm.calls[0].messages[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.plugin, 'dsh-cot-en2cn')
  assert.equal(message.content[0].type, 'text')
  assert.equal(typeof message.id, 'string')
  assert.ok(Object.isFrozen(message))
})

await test('cleanTranslation unwraps fences and "译文：" prefixes', () => {
  assert.equal(cleanTranslation('```\n你好\n```'), '你好')
  assert.equal(cleanTranslation('```markdown\n你好\n```'), '你好')
  assert.equal(cleanTranslation('译文：你好'), '你好')
  assert.equal(cleanTranslation('你好\n\n'), '你好')
  assert.equal(cleanTranslation('```js\nconst a = 1\n```'), 'const a = 1')
})

await test('the system prompt names the target language', () => {
  assert.match(translationSystemPrompt('zh-CN'), /简体中文/)
  assert.match(translationSystemPrompt('zh-TW'), /繁體中文/)
  assert.match(translationSystemPrompt('ja'), /日本語/)
  assert.match(translationSystemPrompt('nonsense'), /简体中文/)
})

process.stdout.write('config + store\n')

await test('normalizeConfig fills defaults and drops unknown keys', () => {
  const config = normalizeConfig({ enabled: false, nope: 1 })
  assert.equal(config.enabled, false)
  assert.equal(config.autoTranslate, DEFAULT_CONFIG.autoTranslate)
  assert.equal('nope' in config, false)
  assert.deepEqual(Object.keys(config).sort(), Object.keys(DEFAULT_CONFIG).sort())
})

await test('normalizeConfig clamps numbers and rejects unknown languages', () => {
  const config = normalizeConfig({
    maxChunkChars: 999999,
    concurrency: 0,
    timeoutMs: -5,
    fontSizePx: 99,
    targetLanguage: 'klingon',
    provider: '  deepseek  ',
  })
  assert.equal(config.maxChunkChars, 20000)
  assert.equal(config.concurrency, 1)
  assert.equal(config.timeoutMs, 5000)
  assert.equal(config.fontSizePx, 18)
  assert.equal(config.targetLanguage, 'zh-CN')
  assert.equal(config.provider, 'deepseek')
})

await test('normalizeConfig ignores non-json garbage', () => {
  assert.deepEqual(normalizeConfig(null), { ...DEFAULT_CONFIG })
  assert.deepEqual(normalizeConfig('nope'), { ...DEFAULT_CONFIG })
  assert.deepEqual(normalizeConfig([1, 2]), { ...DEFAULT_CONFIG })
  assert.equal(normalizeConfig({ enabled: 'yes' }).enabled, true)
})

await test('resolveDshHome honours DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\temp\\dsh-home' }), 'C:\\temp\\dsh-home')
  assert.match(resolveDshHome({}), /\.dsh$/)
  assert.match(resolveDshHome({ DSH_HOME: '   ' }), /\.dsh$/)
})

await test('the config store round-trips through a real file', () => {
  const home = mkdtempSync(join(tmpdir(), 'cot-en2cn-'))
  try {
    const store = createConfigStore({ home })
    assert.equal(store.path, configFilePath(home))
    const missing = store.load()
    assert.equal(missing.source, 'defaults')
    assert.deepEqual(missing.config, { ...DEFAULT_CONFIG })

    store.save({ ...DEFAULT_CONFIG, enabled: false, provider: 'acme', maxChunkChars: 100000 })
    const reloaded = store.load()
    assert.equal(reloaded.source, 'file')
    assert.equal(reloaded.config.enabled, false)
    assert.equal(reloaded.config.provider, 'acme')
    // Clamped on the way in, so a hand-edited file can never inject junk.
    assert.equal(reloaded.config.maxChunkChars, 20000)

    writeFileSync(store.path, '{ this is not json', 'utf8')
    const broken = store.load()
    assert.equal(broken.source, 'invalid')
    assert.deepEqual(broken.config, { ...DEFAULT_CONFIG })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('a bare config document is accepted (no version envelope)', () => {
  const home = mkdtempSync(join(tmpdir(), 'cot-en2cn-'))
  try {
    const store = createConfigStore({ home })
    store.save({ ...DEFAULT_CONFIG, fontSizePx: 15 })
    const bare = JSON.stringify({ fontSizePx: 16 })
    writeFileSync(store.path, bare, 'utf8')
    assert.equal(store.load().config.fontSizePx, 16)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

process.stdout.write('package manifest\n')

await test('the manifest satisfies the DSH bundle + client contract', async () => {
  const manifestPath = join(here, '..', 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.type, 'module')
  assert.equal(typeof manifest.name, 'string')
  assert.match(manifest.version, /^\d+\.\d+\.\d+/)
  assert.equal(manifest.license, 'MIT')

  // Bundle half: the patch file must exist, and every row it inserts must name
  // this package.
  const patchPath = manifest.dsh?.bundle?.patch
  assert.equal(typeof patchPath, 'string', 'dsh.bundle.patch is required')
  assert.ok(existsSync(join(here, '..', patchPath)), `${patchPath} is missing`)
  const patch = await readFile(join(here, '..', patchPath), 'utf8')
  assert.match(patch, new RegExp(`name:\\s*${manifest.name}`))

  // Client half: platform + an exports["./client"] the loader can resolve.
  assert.equal(manifest.dsh?.client?.platform, 'web')
  const clientExport = manifest.exports?.['./client']
  const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default
  assert.equal(typeof clientPath, 'string', 'exports["./client"] is required')
  assert.ok(existsSync(join(here, '..', clientPath)), `${clientPath} is missing`)
  const bundle = await readFile(join(here, '..', clientPath), 'utf8')
  // The module id must be the package name: that is the key the client module
  // table uses and the URL the host serves.
  assert.match(bundle, new RegExp(`__ModuleLoader__\\.load\\(\\{\\s*id:\\s*["']${manifest.name}["']`))

  // Host half: exports["."] must exist too.
  const mainExport = manifest.exports?.['.']
  const mainPath = typeof mainExport === 'string' ? mainExport : mainExport?.default
  assert.equal(typeof mainPath, 'string')
  assert.ok(existsSync(join(here, '..', mainPath)), `${mainPath} is missing`)

  // Everything published must actually be there.
  for (const entry of manifest.files ?? []) {
    assert.ok(existsSync(join(here, '..', entry)), `files[] names a missing path: ${entry}`)
  }
})

await test('the plugin declares no runtime dependencies', async () => {
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  // A linked source directory cannot resolve bare @deepseek-ai/* specifiers, so
  // the plugin must stay dependency-free to work in every install shape.
  assert.deepEqual(manifest.dependencies ?? {}, {})
  const sources = ['index.js', 'client.js', 'config.js', 'store.js', 'engine.js', 'text.js', 'languages.js']
  for (const file of sources) {
    const source = await readFile(join(lib, file), 'utf8')
    const bare = [...source.matchAll(/^\s*import[^'"]*from\s+'([^'.][^'"]*)'/gm)].map((match) => match[1])
    for (const specifier of bare) {
      assert.ok(specifier.startsWith('node:'), `${file} imports "${specifier}"; only node: builtins are allowed`)
    }
  }
})

process.stdout.write('client bundle\n')

await test('the browser bundle registers and exports apply/inject', async () => {
  let record = null
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        record = value
      },
    },
  }
  await import(pathToFileURL(join(lib, 'client.js')).href)
  assert.ok(record !== null, 'client.js did not call __ModuleLoader__.load')
  assert.equal(record.id, 'dsh-cot-en2cn')
  assert.equal(typeof record.factory, 'function')
  const reactStub = {
    createElement: () => ({}),
    useState: () => [undefined, () => {}],
    useRef: () => ({ current: undefined }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useReducer: () => [0, () => {}],
    memo: (fn) => fn,
  }
  const plugin = record.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require("${name}")`)
  })
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual([...plugin.inject], ['slots'])
  delete globalThis.window
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
