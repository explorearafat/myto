/**
 * Preview heuristics shared by both processes.
 *
 * The renderer needs to know whether a freshly written HTML file can be served
 * as-is, and the main-process preview server needs the same answer to decide
 * between a static serve and a dev server (and to explain itself when neither
 * will work). Keeping the test here means the two can never drift apart and
 * disagree about whether a project is previewable.
 */

/**
 * An `index.html` that is a *bundler entry point* — a script tag pointing at
 * unbuilt source (`/src/…`, or a `.ts`/`.tsx`/`.jsx` file). Serving such a file
 * statically renders a blank page: the browser fetches `/src/main.tsx` as-is and
 * chokes on the raw TypeScript/JSX. This is exactly why "React apps don't
 * preview" — the page loads, the module 404s or fails to parse, and all the user
 * sees is white. These projects must be shown through their dev server
 * (Vite/Next/…), which compiles on the fly.
 *
 * A self-contained page (inline scripts, or `src="app.js"` pointing at a built
 * bundle) does NOT match, so plain HTML still previews instantly with no server.
 */
export const BUNDLER_ENTRY_RE =
  /<script\b[^>]*\bsrc=["'][^"']*(?:\/src\/[^"']*|\.(?:tsx?|jsx))(?:[?#][^"']*)?["']/i

/** True when `html` is a bundler entry point that needs a dev server to render. */
export function isBundlerEntryHtml(html: string): boolean {
  return BUNDLER_ENTRY_RE.test(html)
}
