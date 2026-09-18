/**
 * dsh-cot-en2cn — durable settings document.
 *
 * The plugin keeps its own config rather than a settings namespace, so it
 * needs no schema library and no host service beyond `webServer`. The file
 * lives beside the other plugin state in `$DSH_HOME/storages/cot-en2cn/`, which
 * survives plugin upgrades, reinstalls, and `dsh plugin remove`.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * half-written document behind.
 *
 * @module dsh-cot-en2cn/store
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { CONFIG_FILE_NAME, DEFAULT_CONFIG, STORAGE_DIR_NAME, normalizeConfig } from './config.js'

/**
 * Resolve the DeepSeek Harness home with the same precedence the harness uses:
 * `$DSH_HOME` when set to something other than whitespace, else `~/.dsh`.
 *
 * @param env - environment mapping (defaults to `process.env`).
 * @returns the absolute harness home directory.
 */
export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (configured !== '') return normalize(isAbsolute(configured) ? configured : join(process.cwd(), configured))
  return join(homedir(), '.dsh')
}

/** Absolute path of the settings document for one harness home. */
export function configFilePath(home) {
  return join(home, 'storages', STORAGE_DIR_NAME, CONFIG_FILE_NAME)
}

/**
 * Create the config store.
 *
 * @param options - `home` overrides the resolved harness home (tests).
 * @returns `{ path, load, save }`, where `load` never throws and `save` reports
 *   its own failure to the caller.
 */
export function createConfigStore(options = {}) {
  const home = options.home ?? resolveDshHome(options.env)
  const file = configFilePath(home)

  return {
    path: file,

    /**
     * Read the persisted document.
     * @returns `{ config, source }` — `source` is `'file'`, `'defaults'`, or
     *   `'invalid'` when a file existed but could not be used.
     */
    load() {
      let raw
      try {
        raw = readFileSync(file, 'utf8')
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
          return { config: { ...DEFAULT_CONFIG }, source: 'defaults' }
        }
        return { config: { ...DEFAULT_CONFIG }, source: 'invalid', error: String(error?.message ?? error) }
      }
      try {
        const parsed = JSON.parse(raw)
        const section = typeof parsed?.config === 'object' && parsed.config !== null ? parsed.config : parsed
        return { config: normalizeConfig(section), source: 'file' }
      } catch (error) {
        return { config: { ...DEFAULT_CONFIG }, source: 'invalid', error: String(error?.message ?? error) }
      }
    },

    /**
     * Persist one config atomically.
     * @param config - the config to store (normalized again here).
     */
    save(config) {
      const next = normalizeConfig(config)
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp-${String(process.pid)}`
      try {
        writeFileSync(temporary, `${JSON.stringify({ version: 1, config: next }, null, 2)}\n`, 'utf8')
        renameSync(temporary, file)
      } catch (error) {
        try {
          rmSync(temporary, { force: true })
        } catch {
          /* best effort */
        }
        throw error
      }
      return next
    },
  }
}
