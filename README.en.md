# dsh-cot-en2cn

A Web plugin for DeepSeek Harness (DSH). When a model thinks in English, expanding the "Thinking" block automatically displays the Chinese translation right below the original text—without modifying a single byte of the original content.

```text
+-- Thinking -------------------------------------------------------------
|  Let me check whether the settings service is mounted before calling
|  register on it, otherwise the row would throw.
|
|  | 中文译文 · deepseek/deepseek-chat            [重新翻译] [复制] [收起]
|  | 我先确认 settings 服务是否真的挂载了，否则注册这一行会抛错。
+------------------------------------------------------------------------
```

## Why This Plugin

When working with reasoning models such as DeepSeek, GLM, or Gemini, chain-of-thought outputs are frequently generated in English. Reading through extensive English reasoning chains is mentally exhausting for native Chinese speakers.

`dsh-cot-en2cn` solves this directly:
- **Zero Session Mutation**: Leaves conversation history completely untouched. It only injects a presentation panel in the browser DOM.
- **Cost & Token Efficient**: Collapsed blocks are never translated; Chinese text is skipped automatically; translations are cached on both server and client.
- **Zero Runtime Dependencies**: Uses Node.js standard library exclusively, importing zero third-party packages.

## Requirements

- DSH `>=0.1.0-rc.5`
- Node.js `>=20`

## Installation & Setup

### Install from GitHub (recommended)

```bash
dsh plugin --profile web add github:Eyeing0721/dsh-cot-en2cn
```

If the download stalls in mainland China, set a proxy for the current shell first:

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
```

### Install from Local Directory (Development)

```bash
dsh plugin --profile web add /path/to/deepseek-cot-en2cn
```

> Note: If linked from a local directory, do not move or delete the source folder; otherwise, the plugin registration will break.

After installing, **restart `dsh web`** and refresh your browser.

### Removal

```bash
dsh plugin --profile web remove dsh-cot-en2cn
```

Configuration files stored under the storages directory are preserved upon removal.

## How It Works

1. **Inline Display**: Expanding any thinking block renders the translated text directly beneath the original reasoning text. The panel features a vertical border on the left, an informational header indicating the model used, cache status, and response latency, and three action controls: `重新翻译` (Retranslate), `复制` (Copy), and `收起` (Collapse).
2. **Trigger Rules**:
   - Collapsed thinking blocks are **never translated** and incur zero cost.
   - If a block is opened while still streaming, the plugin waits until streaming completes before dispatching a translation request, displaying "模型还在思考，结束后自动翻译…".
   - Texts that are already in Chinese are **skipped immediately** without LLM invocation.
3. **Chunking & Caching**: Long inputs are split along paragraphs, line breaks, or sentences (default 3000 characters/chunk) and cached chunk-by-chunk. Up to 600 chunks are cached server-side alongside client-side memory. Re-expanding blocks or reloading pages does not trigger repeated requests.
4. **Settings UI**: Available at **Settings → Plugins → 「CoT 英文转中文」**. The configuration screen includes a real-time status card (active routing, cache hits, call counts, latency, recent errors, configuration path), toggles, provider/model fields (with "Fetch Models" and "Use Default Model" actions), numeric parameter inputs, cache clearing, reset options, and an inline testing sandbox.

## Configuration Options

Configuration is stored at `$DSH_HOME/storages/cot-en2cn/config.json`. It is decoupled from `settings.yaml` to avoid schema validation dependencies. Manual edits to this JSON file are safe: all properties are validated and clamped to allowed ranges upon loading.

| Setting Name | Default | Description |
|---|---|---|
| 启用 CoT 中文翻译 | 开 (On) | Master switch. Turning this off hides all translation panels immediately without affecting original content. |
| 展开时自动翻译 | 开 (On) | When disabled, translations must be triggered manually per block via "翻译这段思考". |
| 思考过程中也翻译 | 关 (Off) | Translates concurrently while the model is streaming tokens (increases token usage due to repetitive calls). |
| Provider / 模型 | Empty | Leave empty to follow DSH default model routing. Must both be populated or both left empty. Small, fast models are recommended. |
| 关闭思考（推荐） | 开 (On) | Routes translation requests through DSH auxiliary channel (`purpose: session-title`) to avoid generating thinking tokens. **Only supported by DeepSeek official adapter**; behaves as a no-op on generic OpenAI-compatible proxies such as pi-ai. |
| 目标语言 | 简体中文 | Target language. Options include 繁體中文, English, and 日本語. |
| 单块字符数 | 3000 | Maximum character limit per chunk. Smaller values prevent max-tokens truncation at the expense of additional requests. |
| 并发请求数 | 2 | Maximum concurrent translation requests sent to the model. |
| 单次超时 | 120 秒 | Request timeout in seconds. |
| 服务端缓存条数 | 600 | Maximum number of chunk translations cached in the host process. |
| 跳过已是中文的思考 | 开 (On) | Skips translation if the input is already detected as Chinese. |
| 译文文字大小 | 13px | Font size for translation panels. |

## Technical Architecture & Guarantees

The plugin consists of two runtime boundaries:
- **Host Process (`lib/index.js`)**: Registers six localhost-only, same-origin HTTP routes:
  - `GET /dsh-cot-en2cn/state`
  - `PUT /dsh-cot-en2cn/config`
  - `POST /dsh-cot-en2cn/translate`
  - `GET /dsh-cot-en2cn/providers`
  - `GET /dsh-cot-en2cn/models`
  - `POST /dsh-cot-en2cn/cache/clear`
  Translations are dispatched via DSH's internal `ctx.llm.stream()`, reusing existing credentials and model profiles configured in DSH. External and non-loopback requests are blocked.
- **Browser Client (`lib/client.js`)**: Watches the active chat container using `MutationObserver`, anchors thinking blocks using the stable `data-variant="think"` attribute (with fallback class names), and mounts translation views directly into the DOM tree.

Why not use official slots: DSH does not offer a dedicated slot for individual thinking segments. Overriding `conversation.chat.node` would discard the entire assistant renderer. Lightweight DOM augmentation provides stable attachment without platform side-effects.

Guarantees provided:
1. **Zero Session Mutation**: Translation outputs are never written to conversation records, trajectory views, KV caches, or context compression pipelines.
2. **Complete Cleanliness**: Disabling or removing the plugin restores the vanilla UI instantly.
3. **Safe Degradation**: If DSH updates its DOM structure in future versions, the plugin fails silently without breaking chat interactions.

## Privacy & Resource Usage

- **Zero Key Access**: The plugin does not manage, log, or request API keys. Calls run entirely through DSH's internal routing.
- **Predictable Overhead**: Only expanded, non-Chinese, completed thinking blocks are sent. Concurrency is throttled (default 2), with individual timeouts enforced (default 120s).
- **Fully Local**: Operates strictly between the local Node.js process and the local browser instance.

## FAQ

**Q: No translation appears after expanding a thinking block?**
A: Check the following in order:
1. Ensure "启用 CoT 中文翻译" is turned on in the settings panel.
2. Verify if the block is still actively streaming (by default, translation waits for the stream to conclude).
3. Check if the original thinking text is already Chinese (these are skipped intentionally).
4. Inspect the translation area for error banners such as timeouts.

**Q: The panel reports "没有可用的模型路由" (No model route available)?**
A: Either DSH has no default model configured, or only one of Provider/Model was entered in the plugin settings. Set both or leave both empty.

**Q: The output is truncated due to max-tokens limits?**
A: Decrease the "单块字符数" (Chunk character limit) in settings (e.g., to 1500).

**Q: Does translation output appear in Trajectory views?**
A: No. The plugin only mounts visual nodes inside the active conversational chat view.

**Q: Does it conflict with other UI extensions?**
A: No. It occupies no predefined slot IDs and does not replace core renderers. Click events inside the translation block are captured and stopped from bubbling, preventing unintentional folding of parent thinking accordions.

## Quality Assurance

The codebase includes 83 automated test assertions runnable without external testing frameworks:

```bash
npm test
```

Test suite breakdown:
- `tools/smoke.mjs` (33 tests): Verifies chunking reversibility (concatenated chunks match original byte-for-byte), Chinese language detection, in-memory cache, concurrency throttling, duplicate in-flight request deduplication, failure categorizations, schema value clamping, and package manifest constraints.
- `tools/host-integration.mjs` (14 tests): Mounts actual routes inside a simulated cordis container to validate state queries, translation handling, configuration writes, and loopback security boundaries.
- `tools/parity-check.mjs` (5 tests): Compares custom request message payloads against DSH's `createUserMessage` structure to guarantee protocol compatibility.
- `tools/browser-check.mjs` (31 tests): Runs genuine `lib/client.js` in Headless Chrome to assert expansion triggers, streaming deferral, duplicate request prevention, event propagation isolation, global disable cleanup, and configuration panel rendering.

## Project Structure

```text
dsh-cot-en2cn/
├── lib/
│   ├── index.js              # Host half: config IO + the six same-origin routes
│   ├── engine.js             # Translation engine: chunk cache, gate, deadlines, failures
│   ├── text.js               # Chunking and script detection (pure)
│   ├── config.js             # Defaults and clamping
│   ├── store.js              # Atomic $DSH_HOME/storages/cot-en2cn/config.json
│   ├── languages.js          # Target language table
│   └── client.js             # Browser half: DOM observer, panels, settings section
├── tools/
│   ├── browser-check.mjs     # Headless browser integration checks
│   ├── host-integration.mjs  # Host route & context integration tests
│   ├── parity-check.mjs      # Message protocol parity verification
│   └── smoke.mjs             # Unit and smoke test suite
├── cordis.patch.yml
├── package.json
├── README.md
├── README.en.md
└── LICENSE
```

## License

[MIT](LICENSE)
