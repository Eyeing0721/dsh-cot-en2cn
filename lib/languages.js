/**
 * dsh-cot-en2cn — target languages, shared by the host engine and the
 * settings schema. Kept import-free so both halves can use it.
 *
 * @module dsh-cot-en2cn/languages
 */

/** Target languages offered by the settings surface. */
export const TARGET_LANGUAGES = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
]

/** Human names used inside the translation prompt. */
export const TARGET_LANGUAGE_NAMES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
  ja: '日本語',
}
