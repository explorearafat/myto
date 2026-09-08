import type { Theme } from '@shared/types'

/**
 * Maps the app's theme to a built-in Monaco theme id. Monaco ships `vs` (light)
 * and `vs-dark`; we key both the file editor and the inline diff cards off this
 * so they follow the warm-light / dark toggle instead of hardcoding `vs-dark`.
 * (A bespoke warm-tinted Monaco theme via `monaco.editor.defineTheme` can be
 * layered on later; `vs` is a clean, readable baseline for the light palette.)
 */
export function monacoThemeFor(theme: Theme): 'vs' | 'vs-dark' {
  return theme === 'dark' ? 'vs-dark' : 'vs'
}

/**
 * Maps a file extension to a Monaco language id for diff syntax highlighting.
 * Lives here rather than beside one of its callers because the chat pane's tool
 * card, the approval bar and the canvas diff all need the same answer — three
 * copies would drift, and a diff highlighted as `plaintext` in one surface and
 * TypeScript in another reads as a bug in the diff itself.
 */
export function languageForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  switch (ext) {
    case 'ts':
    case 'mts':
    case 'cts':
      return 'typescript'
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript'
    case 'json':
      return 'json'
    case 'css':
      return 'css'
    case 'html':
      return 'html'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'py':
      return 'python'
    case 'sh':
    case 'bash':
      return 'shell'
    case 'yml':
    case 'yaml':
      return 'yaml'
    default:
      return 'plaintext'
  }
}
