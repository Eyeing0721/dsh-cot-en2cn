/**
 * dsh-cot-en2cn — settings shape and clamping.
 *
 * Deliberately dependency-free: no schema library is imported, so the plugin
 * loads from a linked source directory as happily as from an installed
 * package. The host validates every value with {@link normalizeConfig} before
 * it is stored or used, which also makes a hand-edited config file safe.
 *
 * @module dsh-cot-en2cn/config
 */
import { TARGET_LANGUAGES } from './languages.js'

export { TARGET_LANGUAGES }

/** Directory (under `$DSH_HOME/storages`) that holds this plugin's state. */
export const STORAGE_DIR_NAME = 'cot-en2cn'

/** File name of the persisted settings document. */
export const CONFIG_FILE_NAME = 'config.json'

/** Effective defaults; also the fallback when no file exists yet. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  autoTranslate: true,
  liveTranslate: false,
  targetLanguage: 'zh-CN',
  provider: '',
  model: '',
  disableThinking: true,
  maxChunkChars: 3000,
  maxInputChars: 24000,
  timeoutMs: 120000,
  concurrency: 2,
  cacheEntries: 600,
  skipMostlyChinese: true,
  fontSizePx: 13,
})

const BOOLEAN_KEYS = ['enabled', 'autoTranslate', 'liveTranslate', 'disableThinking', 'skipMostlyChinese']

const NUMBER_BOUNDS = {
  maxChunkChars: [200, 20000],
  maxInputChars: [500, 200000],
  timeoutMs: [5000, 600000],
  concurrency: [1, 8],
  cacheEntries: [0, 5000],
  fontSizePx: [11, 18],
}

const LANGUAGE_IDS = new Set(TARGET_LANGUAGES.map((entry) => entry.id))

/**
 * Coerce one possibly-hostile settings document into the effective config:
 * unknown keys are dropped, numbers are clamped, strings are trimmed, and an
 * unknown language falls back to the default.
 *
 * @param value - raw settings document (file content, request body, or memory).
 * @returns a fresh, fully populated config object.
 */
export function normalizeConfig(value) {
  const input = typeof value === 'object' && value !== null ? value : {}
  const next = { ...DEFAULT_CONFIG }
  for (const key of BOOLEAN_KEYS) {
    if (typeof input[key] === 'boolean') next[key] = input[key]
  }
  for (const [key, [min, max]] of Object.entries(NUMBER_BOUNDS)) {
    const raw = input[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) next[key] = Math.min(max, Math.max(min, Math.round(raw)))
  }
  const language = typeof input.targetLanguage === 'string' ? input.targetLanguage.trim() : ''
  next.targetLanguage = LANGUAGE_IDS.has(language) ? language : DEFAULT_CONFIG.targetLanguage
  next.provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  next.model = typeof input.model === 'string' ? input.model.trim() : ''
  return next
}
