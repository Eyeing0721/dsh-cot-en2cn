/**
 * dsh-cot-en2cn — browser check.
 *
 * Loads the real `lib/client.js` in headless Chrome against a fixture page that
 * mimics ui-chat's reasoning rows, with a stub of the plugin's own routes. It
 * then asserts on the DOM Chrome prints back:
 *
 *   - a Chinese panel appears only under the rows a reader can actually read
 *     (expanded, or tall enough to be open, and no longer streaming)
 *   - two rows with the same text cost exactly one translate request
 *   - the original reasoning text is never touched
 *   - panel buttons do not bubble into the row's own expand/collapse handler
 *   - the master switch removes every panel again
 *   - the settings section mounts and renders its controls
 *
 * Run: node tools/browser-check.mjs [--chrome <path>]
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const chromeFlag = process.argv.indexOf('--chrome')
const CHROME_CANDIDATES = [
  chromeFlag === -1 ? undefined : process.argv[chromeFlag + 1],
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((value) => typeof value === 'string' && value !== '')

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (chrome === undefined) {
  process.stdout.write('no Chrome/Edge found; skipping the browser check\n')
  process.exit(0)
}

const REACT_UMD = [
  'P:\\dsh\\home\\profiles\\web\\node_modules\\react\\umd\\react.development.js',
  '/usr/lib/node_modules/react/umd/react.development.js',
]
const REACT_DOM_UMD = [
  'P:\\dsh\\ytai-replica\\_tools\\node_modules\\react-dom\\umd\\react-dom.development.js',
  'P:\\dsh\\home\\profiles\\web\\node_modules\\react-dom\\umd\\react-dom.development.js',
]
const firstExisting = (candidates) => candidates.find((candidate) => existsSync(candidate))

const reactFile = firstExisting(REACT_UMD)
const reactDomFile = firstExisting(REACT_DOM_UMD)

// ------------------------------------------------------------------ stub host

const REASONING_A = 'I should check whether the settings service is even mounted before calling register on it.'
const REASONING_B = 'This block is collapsed, so a reader cannot see it and it must not be translated.'
const REASONING_C = 'The geometry fallback has to catch rows a build renders open without the data-expanded attribute on them.'
const REASONING_D = 'Streaming blocks are only translated when live translation is switched on explicitly.'

const server = {
  config: {
    enabled: true,
    autoTranslate: true,
    liveTranslate: false,
    targetLanguage: 'zh-CN',
    provider: 'fake',
    model: 'fake-1',
    disableThinking: true,
    maxChunkChars: 3000,
    maxInputChars: 24000,
    timeoutMs: 120000,
    concurrency: 2,
    cacheEntries: 600,
    skipMostlyChinese: true,
    showOriginal: false,
    fontSizePx: 13,
  },
  translateCalls: [],
  configWrites: [],
  cacheClears: 0,
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req) {
  let text = ''
  for await (const chunk of req) text += chunk
  return text === '' ? {} : JSON.parse(text)
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (path === '/dsh-cot-en2cn/state') {
    jsonResponse(res, 200, {
      ok: true,
      version: '0.1.0-test',
      config: server.config,
      defaults: { ...server.config, enabled: true, provider: '', model: '' },
      configPath: 'C:\\temp\\cot-en2cn\\config.json',
      configSource: 'file',
      route: { provider: 'fake', model: 'fake-1', source: 'override' },
      stats: { requests: server.translateCalls.length, hits: 0, cacheSize: 0, lastMs: 12, lastError: null, lastRoute: 'fake/fake-1' },
      languages: [
        { id: 'zh-CN', label: '简体中文' },
        { id: 'zh-TW', label: '繁體中文' },
        { id: 'en', label: 'English' },
        { id: 'ja', label: '日本語' },
      ],
    })
    return
  }

  if (path === '/dsh-cot-en2cn/translate') {
    const body = await readBody(req)
    server.translateCalls.push(String(body.text ?? ''))
    // A small real delay so the loading state is observable.
    await new Promise((resolve) => setTimeout(resolve, 40))
    jsonResponse(res, 200, {
      ok: true,
      translation: `【中】${String(body.text ?? '')}`,
      skipped: null,
      chunks: 1,
      cached: false,
      route: { provider: 'fake', model: 'fake-1', source: 'override' },
      ms: 40,
    })
    return
  }

  if (path === '/dsh-cot-en2cn/config') {
    const body = await readBody(req)
    server.configWrites.push(body)
    if (body !== null && typeof body.section === 'object' && body.section !== null) {
      Object.assign(server.config, body.section)
    }
    jsonResponse(res, 200, {
      ok: true,
      version: '0.1.0-test',
      config: server.config,
      defaults: { ...server.config, enabled: true, provider: '', model: '' },
      configPath: 'C:\\temp\\cot-en2cn\\config.json',
      configSource: 'file',
      route: { provider: 'fake', model: 'fake-1', source: 'override' },
      stats: { requests: server.translateCalls.length, hits: 0, cacheSize: 0, lastMs: 12, lastError: null, lastRoute: 'fake/fake-1' },
      languages: [{ id: 'zh-CN', label: '简体中文' }],
    })
    return
  }

  if (path === '/dsh-cot-en2cn/cache/clear') {
    server.cacheClears += 1
    jsonResponse(res, 200, { ok: true, cleared: 3, stats: { requests: 1, hits: 3, cacheSize: 0, lastMs: 5, lastError: null, lastRoute: 'fake/fake-1' } })
    return
  }

  if (path === '/__stats') {
    jsonResponse(res, 200, { translateCalls: server.translateCalls, configWrites: server.configWrites.length, cacheClears: server.cacheClears })
    return
  }

  if (path === '/plugins/dsh-cot-en2cn/client.js') {
    const body = readFileSync(join(root, 'lib', 'client.js'))
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(body)
    return
  }

  if (path === '/react.js' && reactFile !== undefined) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(readFileSync(reactFile))
    return
  }

  if (path === '/react-dom.js' && reactDomFile !== undefined) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(readFileSync(reactDomFile))
    return
  }

  if (path === '/fixture.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(fixtureHtml())
    return
  }

  if (path === '/settings.html' && reactFile !== undefined && reactDomFile !== undefined) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(settingsHtml())
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

function shellFixtures() {
  return `
<style>
  body { font-family: sans-serif; margin: 0; padding: 16px; }
  .lcKema_root { display: flex; flex-direction: column; }
  .lcKema_root:not([data-expanded]) { height: 24px; overflow: hidden; }
  .lcKema_row { height: 24px; }
  .lcKema_thinkBody { white-space: pre-wrap; padding: 4px 0 4px 22px; }
  .tall { min-height: 140px; }
</style>
<div class="lcKema_root" id="row-expanded" data-variant="think" data-state="ok" data-expanded>
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_A}</div></div>
</div>
<div class="lcKema_root" id="row-duplicate" data-variant="think" data-state="ok" data-expanded>
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_A}</div></div>
</div>
<div class="lcKema_root" id="row-collapsed" data-variant="think" data-state="ok">
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_B}</div></div>
</div>
<div class="lcKema_root tall" id="row-geometry" data-variant="think" data-state="ok">
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_C}</div></div>
</div>
<div class="lcKema_root" id="row-running" data-variant="think" data-state="running" data-expanded>
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_D}</div></div>
</div>
<pre id="report"></pre>
`
}

function fixtureHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>cot-en2cn fixture</title></head>
<body>
${shellFixtures()}
<script>
  window.__report = []
  function log(name, ok, detail) { window.__report.push({ name: name, ok: ok === true, detail: detail === undefined ? '' : String(detail) }) }
  window.onerror = function (message) { log('window.onerror', false, message) }
  window.addEventListener('unhandledrejection', function (event) { log('unhandledrejection', false, String(event.reason)) })
  window.__ModuleLoader__ = { load: function (record) { window.__pluginRecord = record } }
</script>
<script src="/plugins/dsh-cot-en2cn/client.js"></script>
<script>
  ;(async function () {
    try {
      var record = window.__pluginRecord
      log('bundle registered', record !== undefined && record.id === 'dsh-cot-en2cn', record && record.id)
      var plugin = record.factory(function (name) {
        if (name === 'react') return { createElement: function () { return {} } }
        throw new Error('unexpected require: ' + name)
      })
      log('apply exported', typeof plugin.apply === 'function')

      // A row-level click listener stands in for DisclosureRow's own
      // expand/collapse handling: panel buttons must never reach it.
      document.getElementById('row-expanded').addEventListener('click', function () {
        window.__rowClicked = (window.__rowClicked || 0) + 1
      })

      var sections = []
      var slots = {
        inject: function (name, callback) { callback() },
        register: function (options, component) { sections.push({ options: options, component: component }); return function () {} },
      }
      plugin.apply({ get: function (name) { return name === 'slots' ? slots : undefined }, effect: function (fn) { return fn() } })
      log('settings section registered', sections.length === 1 && sections[0].options.id === 'cot-en2cn', sections.length)

      function panels() { return document.querySelectorAll('[data-dsh-cot-en2cn="panel"]') }
      function translatedPanels() {
        return Array.prototype.filter.call(panels(), function (panel) { return /【中】/.test(panel.textContent) })
      }
      function panelIn(id) { var row = document.getElementById(id); return row === null ? null : row.querySelector('[data-dsh-cot-en2cn="panel"]') }
      function waitFor(predicate, timeoutMs) {
        var deadline = Date.now() + timeoutMs
        return new Promise(function (resolve) {
          ;(function tick() {
            var value = null
            try { value = predicate() } catch (error) { value = null }
            if (value) { resolve(value); return }
            if (Date.now() > deadline) { resolve(null); return }
            setTimeout(tick, 60)
          })()
        })
      }

      var ok = await waitFor(function () { return translatedPanels().length >= 3 }, 12000)
      log('three rows translated', ok !== null, translatedPanels().length)

      var expanded = panelIn('row-expanded')
      var duplicate = panelIn('row-duplicate')
      var geometry = panelIn('row-geometry')
      log('expanded row translated', expanded !== null && /【中】/.test(expanded.textContent), expanded ? expanded.textContent.slice(0, 40) : 'missing')
      log('duplicate row translated from cache', duplicate !== null && /【中】/.test(duplicate.textContent))
      log('open-by-geometry row translated', geometry !== null && /【中】/.test(geometry.textContent))
      log('collapsed row untouched', panelIn('row-collapsed') === null)
      var runningPanel = panelIn('row-running')
      log(
        'streaming row shows a status, not a translation',
        runningPanel !== null && runningPanel.textContent.indexOf('【中】') === -1 && /自动翻译/.test(runningPanel.textContent),
        runningPanel === null ? 'no panel' : runningPanel.textContent.slice(0, 40),
      )

      // The original reasoning text must survive verbatim.
      var original = document.querySelector('#row-expanded .lcKema_thinkBody').textContent
      log('original text preserved', original === ${JSON.stringify(REASONING_A)}, original.slice(0, 30))

      var stats = await (await fetch('/__stats', { cache: 'no-store' })).json()
      log('two distinct texts, two requests', stats.translateCalls.length === 2, JSON.stringify(stats.translateCalls.map(function (t) { return t.slice(0, 20) })))
      log('identical text requested once', stats.translateCalls.filter(function (t) { return t === ${JSON.stringify(REASONING_A)} }).length === 1)
      log('collapsed text never requested', stats.translateCalls.indexOf(${JSON.stringify(REASONING_B)}) === -1)
      log('streaming text never requested', stats.translateCalls.indexOf(${JSON.stringify(REASONING_D)}) === -1)

      // Panel buttons must stop propagation into the row handler.
      window.__rowClicked = 0
      var toggle = expanded.querySelector('[data-act="toggle"]')
      var copy = expanded.querySelector('[data-act="copy"]')
      log('panel has toggle and copy', toggle !== null && copy !== null)
      toggle.click()
      copy.click()
      var body = expanded.querySelector('[data-role="body"]')
      log('toggle collapses the translation', body !== null && body.getAttribute('data-collapsed') === 'true')
      log('buttons do not bubble into the row', window.__rowClicked === 0, window.__rowClicked)
      toggle.click()
      log('toggle restores the translation', body !== null && body.getAttribute('data-collapsed') === 'false')

      // Master switch off: every panel goes away.
      await fetch('/dsh-cot-en2cn/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ section: { enabled: false } }),
      })
      document.dispatchEvent(new Event('visibilitychange'))
      var gone = await waitFor(function () { return panels().length === 0 }, 20000)
      log('disabling removes every panel', gone !== null, panels().length)

      document.getElementById('report').textContent = JSON.stringify(window.__report)
    } catch (error) {
      log('harness crashed', false, (error && error.stack) || String(error))
      document.getElementById('report').textContent = JSON.stringify(window.__report)
    }
  })()
</script>
</body></html>`
}

function settingsHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>cot-en2cn settings</title></head>
<body>
<div id="root"></div>
<pre id="report"></pre>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>window.__ModuleLoader__ = { load: function (record) { window.__pluginRecord = record } }</script>
<script src="/plugins/dsh-cot-en2cn/client.js"></script>
<script>
  ;(async function () {
    var report = []
    function log(name, ok, detail) { report.push({ name: name, ok: ok === true, detail: detail === undefined ? '' : String(detail) }) }
    window.onerror = function (message) { log('window.onerror', false, message) }
    try {
      var plugin = window.__pluginRecord.factory(function (name) {
        if (name === 'react') return window.React
        throw new Error('unexpected require: ' + name)
      })
      var sections = []
      var slots = {
        inject: function (name, callback) { callback() },
        register: function (options, component) { sections.push({ options: options, component: component }); return function () {} },
      }
      plugin.apply({ get: function (name) { return name === 'slots' ? slots : undefined }, effect: function (fn) { return fn() } })
      log('section registered', sections.length === 1)
      log('section label', sections.length === 1 && sections[0].options.label() === 'CoT 英文转中文', sections.length === 1 ? sections[0].options.label() : '')

      var root = window.ReactDOM.createRoot(document.getElementById('root'))
      root.render(window.React.createElement(sections[0].component))

      var deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        var text = document.getElementById('root').textContent
        if (text.indexOf('翻译模型') !== -1 && text.indexOf('fake / fake-1') !== -1) break
        await new Promise(function (resolve) { setTimeout(resolve, 80) })
      }
      var rendered = document.getElementById('root').textContent
      log('renders the status card', rendered.indexOf('fake / fake-1') !== -1, rendered.slice(0, 60))
      log('renders the config path', rendered.indexOf('cot-en2cn') !== -1 && rendered.indexOf('config.json') !== -1)
      log('renders basic switches', rendered.indexOf('启用 CoT 中文翻译') !== -1 && rendered.indexOf('展开时自动翻译') !== -1)
      log('renders model fields', rendered.indexOf('翻译模型') !== -1 && rendered.indexOf('拉取模型列表') !== -1 && rendered.indexOf('用默认模型') !== -1)
      log('renders advanced knobs', rendered.indexOf('目标语言') !== -1 && rendered.indexOf('单块字符数') !== -1 && rendered.indexOf('并发请求数') !== -1)
      log('renders the test box', rendered.indexOf('试译') !== -1)
      log('renders no crash text', rendered.indexOf('Something went wrong') === -1)

      var buttons = Array.prototype.slice.call(document.querySelectorAll('#root button'))
      log('has buttons', buttons.length >= 3, buttons.length)
      var clearButton = buttons.filter(function (button) { return button.textContent.indexOf('清空服务端缓存') !== -1 })[0]
      if (clearButton !== undefined) {
        clearButton.click()
        await new Promise(function (resolve) { setTimeout(resolve, 300) })
      }
      var stats = await (await fetch('/__stats', { cache: 'no-store' })).json()
      log('clear cache button hits the host', stats.cacheClears === 1, stats.cacheClears)

      document.getElementById('report').textContent = JSON.stringify(report)
    } catch (error) {
      log('harness crashed', false, (error && error.stack) || String(error))
      document.getElementById('report').textContent = JSON.stringify(report)
    }
  })()
</script>
</body></html>`
}

// ------------------------------------------------------------------- run it

let passed = 0
let failed = 0

function check(name, ok, detail) {
  if (ok === true) {
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } else {
    failed += 1
    process.stdout.write(`  FAIL ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}\n`)
  }
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

async function dumpDom(port, path) {
  const profileDir = mkdtempSync(join(tmpdir(), 'cot-en2cn-chrome-'))
  try {
    const { stdout } = await run(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--hide-scrollbars',
        `--user-data-dir=${profileDir}`,
        '--virtual-time-budget=30000',
        '--dump-dom',
        `http://127.0.0.1:${port}${path}`,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 180000, windowsHide: true },
    )
    return stdout
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
}

function readReport(dom) {
  const match = /<pre id="report">([\s\S]*?)<\/pre>/.exec(dom)
  if (match === null) return null
  const raw = decodeEntities(match[1]).trim()
  if (raw === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const port = httpServer.address().port

try {
  process.stdout.write(`browser check (chrome=${chrome}, port=${port})\n`)

  process.stdout.write('inline translator\n')
  const fixtureDom = await dumpDom(port, '/fixture.html')
  const fixtureReport = readReport(fixtureDom)
  if (fixtureReport === null) {
    check('fixture produced a report', false, 'no <pre id="report"> payload found')
    process.stdout.write(fixtureDom.slice(0, 2000))
  } else {
    for (const entry of fixtureReport) check(entry.name, entry.ok, entry.detail)
  }
  check('panels exist in the serialized DOM', /data-dsh-cot-en2cn="panel"/.test(fixtureDom))

  if (reactFile !== undefined && reactDomFile !== undefined) {
    process.stdout.write('settings section\n')
    const settingsDom = await dumpDom(port, '/settings.html')
    const settingsReport = readReport(settingsDom)
    if (settingsReport === null) {
      check('settings fixture produced a report', false, 'no <pre id="report"> payload found')
      process.stdout.write(settingsDom.slice(0, 2000))
    } else {
      for (const entry of settingsReport) check(entry.name, entry.ok, entry.detail)
    }
  } else {
    process.stdout.write('settings section\n  skip no React UMD build found\n')
  }
} finally {
  httpServer.close()
}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
