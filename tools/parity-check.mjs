/**
 * dsh-cot-en2cn — parity check against DSH's own message factory.
 *
 * `lib/engine.js` hand-builds the auxiliary user message it sends to the model
 * instead of importing `createUserMessage` from `@deepseek-ai/dsh-llm`. That
 * keeps the plugin loadable from a linked source directory (where bare
 * `@deepseek-ai/*` specifiers do not resolve), but it is only safe while the
 * hand-built object is field-for-field what the shipped factory produces.
 *
 * This script resolves the real `@deepseek-ai/dsh-llm` through the DSH
 * installation and compares the two objects. It skips (exit 0) when the
 * installed package cannot be found, so it stays usable on a bare checkout.
 *
 * Run: node tools/parity-check.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const { buildUserMessage } = await import(pathToFileURL(join(root, 'lib', 'engine.js')).href)

/** Anchors that can resolve the real dsh-llm package, in probe order. */
const ANCHORS = [
  'P:\\dsh\\npm-global\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-llm\\package.json',
  'P:\\dsh\\home\\profiles\\node_modules\\@deepseek-ai\\dsh-llm\\package.json',
  '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/package.json',
]

async function loadReal() {
  for (const anchor of ANCHORS) {
    if (!existsSync(anchor)) continue
    try {
      const require = createRequire(anchor)
      const resolved = require.resolve('@deepseek-ai/dsh-llm')
      return await import(pathToFileURL(resolved).href)
    } catch {
      /* try the next anchor */
    }
  }
  return null
}

const real = await loadReal()
if (real === null || typeof real.createUserMessage !== 'function') {
  process.stdout.write('dsh-llm not resolvable here; skipping the parity check\n')
  process.exit(0)
}

const TEXT = 'Let me check the parity of this message shape against the shipped factory.'
const mine = buildUserMessage(TEXT)
const theirs = real.createUserMessage({ content: [{ type: 'text', text: TEXT }], source: { kind: 'plugin', plugin: 'dsh-cot-en2cn' } })

let passed = 0
let failed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

process.stdout.write('message parity\n')

check('the same key set', () => {
  assert.deepEqual(Object.keys(mine).sort(), Object.keys(theirs).sort())
})

check('the same role and content', () => {
  assert.equal(mine.role, theirs.role)
  assert.deepEqual(mine.content, theirs.content)
})

check('the same source tag', () => {
  assert.deepEqual(mine.source, theirs.source)
})

check('a branded uuid identity of the same shape', () => {
  assert.equal(typeof mine.id, 'string')
  assert.match(mine.id, /^[0-9a-f-]{36}$/i)
  assert.match(theirs.id, /^[0-9a-f-]{36}$/i)
  assert.notEqual(mine.id, theirs.id, 'ids must be fresh per message')
})

check('both are frozen and structurally identical', () => {
  assert.ok(Object.isFrozen(mine))
  assert.ok(Object.isFrozen(theirs))
  assert.ok(Object.isFrozen(mine.content[0]))
  const strip = (value) => JSON.parse(JSON.stringify({ ...value, id: 'x' }))
  assert.deepEqual(strip(mine), strip(theirs))
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
