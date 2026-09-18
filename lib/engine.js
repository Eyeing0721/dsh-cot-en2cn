/**
 * dsh-cot-en2cn — host-side translation engine.
 *
 * One engine instance owns: the chunk-level LRU cache, in-flight de-duplication
 * (expanding the same thinking block twice costs one model call), the
 * concurrency gate, per-request deadlines, and the statistics the settings
 * panel shows.
 *
 * The engine never touches the session transcript: it takes text in and gives
 * a translation back. Everything the user sees changes in the browser only.
 *
 * @module dsh-cot-en2cn/engine
 */
import { createHash, randomUUID } from 'node:crypto'
import { TARGET_LANGUAGE_NAMES } from './languages.js'
import {
  chunkText,
  estimateMaxTokens,
  looksChinese,
  normalizeText,
  splitTrailingSpace,
} from './text.js'

/** Attribution stamped on every message this plugin sends to a model. */
const PLUGIN_ID = 'dsh-cot-en2cn'

/**
 * Build the translation instruction for one target language.
 *
 * The wording is deliberately strict: the model is a translator here, not an
 * assistant, and the output has to survive re-attachment to the original
 * separators, so structure preservation and "do not translate code" come first.
 *
 * @param target - target language id (`zh-CN`, `zh-TW`, `en`, `ja`).
 * @returns the system prompt.
 */
export function translationSystemPrompt(target) {
  const name = TARGET_LANGUAGE_NAMES[target] ?? '简体中文'
  return [
    '你是一个思维链（Chain of Thought）翻译引擎，不是助手，不要与用户对话。',
    `输入是一段大语言模型在推理阶段输出的文本，通常是英文，也可能夹带代码、路径、变量名或少量中文。请把它翻译成${name}。`,
    '',
    '硬性要求：',
    `1. 只输出${name}译文本身。不要前言、不要解释、不要「以下是译文」之类的话，也不要用代码块把整段译文包起来。`,
    '2. 完整保留原文结构：行数、空行、缩进、列表符号、编号、Markdown 标记（**、###、表格竖线等）都要对应。',
    '3. 以下内容原样保留、绝不翻译：代码片段、变量名/函数名/类名、文件名与路径、命令行与参数、URL、包名、API 与协议名、报错信息原文、数学公式与符号。',
    '4. 术语保持一致：chain-of-thought → 思维链，prompt → 提示词，context → 上下文，tool call → 工具调用，token 保留为 token。',
    '5. 原文里已经是中文的句子保持原样，不要改写、不要润色。',
    '6. 译文准确、简洁、像技术文档：不要扩写，不要总结，不要补充原文没有的信息。',
    '7. 如果输入本身不是一个完整句子（例如只有几个词或一个标识符），给出最短的对应译文即可。',
  ].join('\n')
}

/** Recursively freeze one message so adapters can rely on the immutable contract. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/** One hand-built auxiliary user message, frozen before dispatch. */
export function buildUserMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_ID },
  })
}

/** Trim a model reply down to the translation, unwrapping an accidental fence. */
export function cleanTranslation(raw) {
  let value = String(raw ?? '')
  const fenced = /^\s*```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(value)
  if (fenced !== null) value = fenced[1]
  value = value.replace(/^(?:译文|翻译|Translation|Translated text)\s*[:：]\s*/i, '')
  return value.replace(/\s+$/, '')
}

/** Human-readable message for any thrown value. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/** Join two optional abort signals into one, without requiring AbortSignal.any. */
function composeSignals(signals) {
  const list = signals.filter((signal) => signal !== undefined && signal !== null)
  if (list.length === 1) return list[0]
  const controller = new AbortController()
  const onAbort = (signal) => () => {
    controller.abort(signal.reason)
  }
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', onAbort(signal), { once: true })
  }
  return controller.signal
}

/** The finish reasons that mean "this translation is unusable". */
function finishFailure(reason) {
  if (reason === undefined || reason === null) return null
  const kind = reason.kind
  if (kind === 'stop') return null
  if (kind === 'max-tokens') return new Error('模型输出被 max-tokens 截断（把「单块字符数」调小一点会更稳）')
  if (kind === 'tool-calls') return new Error('模型返回了工具调用而不是译文')
  if (kind === 'aborted') return new Error(`模型调用被中断：${errorMessage(reason.failure?.message ?? reason.failure ?? 'aborted')}`)
  return new Error(`模型以 ${String(kind)} 结束，而不是正常结束`)
}

/**
 * Create one translation engine.
 *
 * @param options - engine wiring.
 * @param options.getConfig - reads the live effective config.
 * @param options.getLlm - returns the `llm` service (or undefined).
 * @param options.getRoute - resolves `{ provider, model, source }` or throws.
 * @param options.log - optional `(level, message)` sink for diagnostics.
 * @returns the engine face used by the routes.
 */
export function createTranslationEngine(options) {
  const getConfig = options.getConfig
  const getLlm = options.getLlm
  const getRoute = options.getRoute
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  /** chunk key -> translated text (insertion order == LRU order). */
  const cache = new Map()
  /** chunk key -> in-flight promise. */
  const inflight = new Map()
  /** Waiting resolvers for the concurrency gate. */
  const waiters = []
  let active = 0

  const stats = {
    requests: 0,
    chunks: 0,
    hits: 0,
    deduped: 0,
    failures: 0,
    skipped: 0,
    translatedChars: 0,
    sourceChars: 0,
    lastError: null,
    lastMs: null,
    lastRoute: null,
    lastAt: null,
  }

  function cacheKey(route, target, core) {
    return createHash('sha1')
      .update(`${route.provider}\u0000${route.model}\u0000${target}\u0000${core}`, 'utf8')
      .digest('hex')
      .slice(0, 24)
  }

  function remember(key, value) {
    const limit = Math.max(0, Math.floor(getConfig().cacheEntries))
    if (limit === 0) return
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > limit) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
    }
  }

  function acquire() {
    const limit = Math.max(1, Math.floor(getConfig().concurrency))
    if (active < limit) {
      active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      waiters.push(resolve)
    })
  }

  function release() {
    const next = waiters.shift()
    if (next !== undefined) {
      // The slot transfers to the waiter: `active` stays as it is.
      next()
      return
    }
    if (active > 0) active -= 1
  }

  /** One model round trip for one chunk core. */
  async function callModel(core, config, route, callerSignal) {
    const llm = getLlm()
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new Error('LLM 服务不可用：请确认 DSH 已配置可用的模型提供方')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error(`翻译超时（${Math.round(config.timeoutMs / 1000)}s）`))
    }, config.timeoutMs)
    const signal = composeSignals([controller.signal, callerSignal])
    const request = {
      provider: route.provider,
      model: route.model,
      system: translationSystemPrompt(config.targetLanguage),
      messages: [buildUserMessage(core)],
      maxTokens: estimateMaxTokens(core),
      signal,
    }
    // The adapter maps this auxiliary purpose to a thinking-disabled request,
    // which keeps a pure translation from paying for hidden reasoning tokens.
    if (config.disableThinking) request.purpose = 'session-title'

    const startedAt = now()
    let text = ''
    let finish
    try {
      for await (const chunk of llm.stream(request)) {
        if (chunk === null || chunk === undefined) continue
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish') finish = chunk.reason
      }
    } catch (error) {
      if (signal.aborted) {
        throw new Error(`翻译调用被中断：${errorMessage(signal.reason ?? error)}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (signal.aborted) throw new Error(`翻译调用被中断：${errorMessage(signal.reason ?? 'aborted')}`)
    const failure = finishFailure(finish)
    if (failure !== null) throw failure
    const cleaned = cleanTranslation(text)
    if (cleaned.length === 0) throw new Error('模型没有返回译文')
    stats.lastMs = now() - startedAt
    return cleaned
  }

  /** Translate one chunk core through the cache + gate. */
  function translateChunk(core, config, route, signal) {
    const key = cacheKey(route, config.targetLanguage, core)
    const hit = cache.get(key)
    if (hit !== undefined) {
      stats.hits += 1
      cache.delete(key)
      cache.set(key, hit)
      return Promise.resolve(hit)
    }
    const running = inflight.get(key)
    if (running !== undefined) {
      stats.deduped += 1
      return running
    }
    const task = (async () => {
      await acquire()
      try {
        stats.requests += 1
        const value = await callModel(core, config, route, signal)
        stats.translatedChars += value.length
        remember(key, value)
        return value
      } catch (error) {
        stats.failures += 1
        stats.lastError = errorMessage(error)
        log('warn', `translate failed: ${stats.lastError}`)
        throw error
      } finally {
        release()
      }
    })()
    inflight.set(key, task)
    const settled = () => {
      if (inflight.get(key) === task) inflight.delete(key)
    }
    task.then(settled, settled)
    return task
  }

  return {
    /**
     * Translate one reasoning text.
     *
     * @param text - the source text (typically one thinking block).
     * @param options - `signal` cancels the caller's interest; `force` bypasses the already-Chinese shortcut.
     * @returns `{ ok, translation, skipped, chunks, cached, route, ms }`.
     */
    async translate(text, translateOptions = {}) {
      const startedAt = now()
      const config = getConfig()
      const normalized = normalizeText(text)
      if (normalized.length === 0) {
        return { ok: true, translation: '', skipped: 'empty', chunks: 0, cached: true, ms: 0 }
      }
      if (!translateOptions.force && config.skipMostlyChinese && looksChinese(normalized)) {
        stats.skipped += 1
        return { ok: true, translation: normalized, skipped: 'already-chinese', chunks: 0, cached: true, ms: 0 }
      }
      const truncated = normalized.length > config.maxInputChars
      const source = truncated ? normalized.slice(0, config.maxInputChars) : normalized
      const route = getRoute()
      stats.lastRoute = `${route.provider}/${route.model}`
      stats.lastAt = new Date().toISOString()
      stats.sourceChars += source.length

      const parts = chunkText(source, config.maxChunkChars).map((chunk) => {
        const { core, separator } = splitTrailingSpace(chunk)
        return { core, separator, translation: '' }
      })
      const pending = parts.filter((part) => part.core.length > 0)
      stats.chunks += pending.length
      const requestsBefore = stats.requests
      await Promise.all(
        pending.map(async (part) => {
          part.translation = await translateChunk(part.core, config, route, translateOptions.signal)
        }),
      )
      const translation = parts.map((part) => (part.core.length === 0 ? '' : part.translation) + part.separator).join('')
      return {
        ok: true,
        translation,
        skipped: truncated ? 'truncated' : null,
        chunks: pending.length,
        cached: pending.length > 0 && stats.requests === requestsBefore,
        route: { provider: route.provider, model: route.model, source: route.source },
        ms: now() - startedAt,
      }
    },

    /** Current counters plus cache occupancy, for the settings panel. */
    state() {
      return {
        ...stats,
        cacheSize: cache.size,
        inflight: inflight.size,
        active,
        queued: waiters.length,
      }
    },

    /** Drop every cached translation. */
    clearCache() {
      const size = cache.size
      cache.clear()
      return size
    },
  }
}
