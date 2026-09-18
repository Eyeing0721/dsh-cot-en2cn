/**
 * dsh-cot-en2cn — pure text utilities for the host half.
 *
 * No DSH imports live here on purpose: this module is the part of the engine
 * that can be unit-tested with plain `node tools/smoke.mjs`.
 *
 * @module dsh-cot-en2cn/text
 */
import { createHash } from 'node:crypto'

/** Normalize line endings and trim the outer whitespace of one reasoning text. */
export function normalizeText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim()
}

/** Short stable content hash used for cache keys and DOM bookkeeping. */
export function hashText(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 16)
}

/** Count CJK ideographs and ASCII letters in one text. */
export function countScripts(text) {
  const value = String(text ?? '')
  let cjk = 0
  let latin = 0
  for (const char of value) {
    const code = char.codePointAt(0)
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1
    } else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) {
      latin += 1
    }
  }
  return { cjk, latin }
}

/**
 * Whether a reasoning text is already Chinese enough that translating it would
 * burn tokens for nothing. Latin identifiers (`tool_call`, `README.md`) do not
 * count as prose because Chinese technical writing is full of them.
 */
export function looksChinese(text) {
  const { cjk, latin } = countScripts(text)
  if (cjk === 0) return false
  return latin <= 24 || cjk >= latin * 4
}

/** Whether a UTF-16 code unit is the low half of a surrogate pair. */
function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Index just past the last sentence end at or before `end`, or -1. */
function lastSentenceBreak(window, end) {
  for (let i = end - 1; i > 0; i -= 1) {
    const char = window[i]
    if (char !== '.' && char !== '!' && char !== '?' && char !== '。' && char !== '！' && char !== '？' && char !== ';' && char !== '；') {
      continue
    }
    const next = window[i + 1]
    if (next === undefined || next === ' ' || next === '\n' || next === '\t') return i
  }
  return -1
}

/**
 * Split one long text into chunks of at most `maxChars` characters, preferring
 * paragraph, then line, then sentence, then word boundaries. Concatenating the
 * result reproduces the input byte for byte, so a caller can re-attach the
 * original separators to translated chunk cores.
 *
 * @param text - source text.
 * @param maxChars - per-chunk character ceiling (>= 1).
 * @returns the chunks in order; `[]` for an empty text.
 */
export function chunkText(text, maxChars) {
  const value = String(text ?? '')
  const limit = Math.max(1, Math.floor(Number(maxChars) || 1))
  if (value.length === 0) return []
  if (value.length <= limit) return [value]
  const floor = Math.floor(limit * 0.4)
  const chunks = []
  let rest = value
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n\n')
    if (cut < floor) {
      const line = window.lastIndexOf('\n')
      if (line > cut) cut = line
    }
    if (cut < floor) cut = lastSentenceBreak(window, limit)
    if (cut < floor) cut = window.lastIndexOf(' ')
    if (cut <= 0) cut = limit
    else cut += 1
    // Never split a surrogate pair in half.
    if (cut < rest.length && isLowSurrogate(rest.charCodeAt(cut))) cut -= 1
    if (cut <= 0) cut = Math.min(limit, rest.length)
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** Split one chunk into its content core and its trailing whitespace run. */
export function splitTrailingSpace(chunk) {
  const core = String(chunk ?? '').replace(/\s+$/, '')
  return { core, separator: String(chunk ?? '').slice(core.length) }
}

/** Conservative output-token ceiling for one chunk of translated prose. */
export function estimateMaxTokens(text) {
  const length = String(text ?? '').length
  return Math.min(8192, Math.max(512, Math.ceil(length * 1.6) + 256))
}
