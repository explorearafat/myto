/**
 * What a live web page is *doing* — its console, its requests, one element's real
 * computed style.
 *
 * `perception.ts` answers "what does this page show"; this module answers "what is
 * it doing", which is the difference between driving a site and debugging one. It
 * is the browse-side sibling of `preview/inspect.ts` (the same three reads the
 * engine already has for the user's own localhost preview), so the model reuses
 * one vocabulary — `console`, `network`, `inspect` — for both surfaces.
 *
 * Everything here runs as in-page JS through a {@link BrowserTarget}, so it works
 * against the in-app page view and the user's real Chrome alike, and a test drives
 * it with a fake target and no browser at all.
 *
 * Console messages and requests can only be reported if something was watching
 * when they happened, so {@link installRecorder} plants a small, idempotent
 * recorder in the page: it wraps `console.*`, `fetch` and `XMLHttpRequest` into a
 * bounded ring buffer. A fresh document wipes it (the runner re-installs after
 * every navigation), and when it is missing entirely the network read still falls
 * back to the browser's own `performance` resource timings — fewer details, but
 * never a blank answer.
 */
import type { BrowserTarget } from './target'

/** Cap on buffered console messages / requests held in the page. */
const RING = 200

/** Cap on entries reported back to the model in one read. */
const MAX_REPORTED = 60

/** Cap on a single console message / url in the report (chars). */
const MAX_ENTRY = 400

/** The property the recorder lives on. Renaming it orphans buffers in open pages. */
const STORE = '__sylorDebug'

/** One captured console message. */
export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  text: string
  /** ms since the recorder was installed, so ordering survives the trip. */
  at: number
}

/** One captured request. */
export interface NetworkEntry {
  method: string
  url: string
  /** 0 when the request never got a response (network error / blocked / pending). */
  status: number
  /** Round trip in ms, rounded; undefined when it came from a resource timing. */
  ms?: number
  /** True when the request failed outright rather than returning a status. */
  failed: boolean
}

/** What {@link readConsole} / {@link readNetwork} give the caller. */
export interface DebugReport {
  text: string
  truncated: boolean
  /** How many entries the page held before filtering/capping (for the summary). */
  count: number
}

/**
 * The recorder, as a self-installing in-page expression.
 *
 * Written as ES5-only, single-statement-per-line source because it is injected as
 * a string into an arbitrary page: no optional chaining, no arrow functions, no
 * template literals (a page's CSP can forbid nothing here, but old JS engines and
 * exotic sandboxes are real). It never throws — a page that has frozen `console`
 * or removed `fetch` must not break the browse step that installs it.
 */
const RECORDER_JS = `(function () {
  try {
    if (window.${STORE} && window.${STORE}.v === 1) return 'present';
    var store = { v: 1, t0: Date.now(), logs: [], net: [] };
    window.${STORE} = store;
    function push(list, item) {
      list.push(item);
      if (list.length > ${RING}) list.shift();
    }
    function render(arg) {
      try {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return String(arg.stack || arg.message || arg);
        if (arg && typeof arg === 'object') return JSON.stringify(arg);
        return String(arg);
      } catch (e) {
        return Object.prototype.toString.call(arg);
      }
    }
    var levels = ['log', 'info', 'warn', 'error', 'debug'];
    for (var i = 0; i < levels.length; i++) {
      (function (level) {
        var original = console[level];
        if (typeof original !== 'function') return;
        console[level] = function () {
          try {
            var parts = [];
            for (var j = 0; j < arguments.length; j++) parts.push(render(arguments[j]));
            push(store.logs, { level: level, text: parts.join(' '), at: Date.now() - store.t0 });
          } catch (e) {}
          return original.apply(console, arguments);
        };
      })(levels[i]);
    }
    window.addEventListener('error', function (e) {
      push(store.logs, {
        level: 'error',
        text: 'Uncaught ' + render(e.error || e.message),
        at: Date.now() - store.t0
      });
    });
    window.addEventListener('unhandledrejection', function (e) {
      push(store.logs, {
        level: 'error',
        text: 'Unhandled rejection: ' + render(e.reason),
        at: Date.now() - store.t0
      });
    });
    if (typeof window.fetch === 'function') {
      var nativeFetch = window.fetch;
      window.fetch = function (input, init) {
        var started = Date.now();
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = (init && init.method) || (input && input.method) || 'GET';
        var record = { method: String(method).toUpperCase(), url: String(url), status: 0, ms: 0, failed: true };
        push(store.net, record);
        return nativeFetch.apply(window, arguments).then(
          function (res) {
            record.status = res.status;
            record.ms = Date.now() - started;
            record.failed = !res.ok;
            return res;
          },
          function (err) {
            record.ms = Date.now() - started;
            record.failed = true;
            throw err;
          }
        );
      };
    }
    if (window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
      var proto = window.XMLHttpRequest.prototype;
      var open = proto.open;
      var send = proto.send;
      proto.open = function (method, url) {
        try {
          this.${STORE}rec = { method: String(method || 'GET').toUpperCase(), url: String(url || ''), status: 0, ms: 0, failed: true };
        } catch (e) {}
        return open.apply(this, arguments);
      };
      proto.send = function () {
        var rec = this.${STORE}rec;
        if (rec) {
          var started = Date.now();
          push(store.net, rec);
          this.addEventListener('loadend', function () {
            rec.status = this.status || 0;
            rec.ms = Date.now() - started;
            rec.failed = !rec.status || rec.status >= 400;
          });
        }
        return send.apply(this, arguments);
      };
    }
    return 'installed';
  } catch (e) {
    return 'failed';
  }
})()`

/**
 * Plant the recorder in the current document if it is not already there.
 *
 * Cheap and idempotent (the guard returns immediately on a second call), and never
 * rejects: a page that refuses the injection just means a later `console` read has
 * nothing buffered, which is reported honestly rather than as an error.
 */
export async function installRecorder(target: BrowserTarget): Promise<boolean> {
  try {
    const state = await target.executeJavaScript(RECORDER_JS)
    return state === 'installed' || state === 'present'
  } catch {
    return false
  }
}

/** Clip one long line so a single 50KB log entry can't eat the whole budget. */
function clip(text: string): string {
  const value = (text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > MAX_ENTRY ? `${value.slice(0, MAX_ENTRY)}…` : value
}

/** Coerce whatever came back from the page into console entries. */
function asConsoleEntries(raw: unknown): ConsoleEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ConsoleEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const level = ['log', 'info', 'warn', 'error', 'debug'].includes(String(r.level))
      ? (r.level as ConsoleEntry['level'])
      : 'log'
    out.push({ level, text: clip(String(r.text ?? '')), at: Number(r.at) || 0 })
  }
  return out
}

/** Coerce whatever came back from the page into network entries. */
function asNetworkEntries(raw: unknown): NetworkEntry[] {
  if (!Array.isArray(raw)) return []
  const out: NetworkEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const status = Number(r.status) || 0
    const ms = Number(r.ms)
    out.push({
      method: String(r.method ?? 'GET').toUpperCase(),
      url: clip(String(r.url ?? '')),
      status,
      ...(Number.isFinite(ms) && ms > 0 ? { ms: Math.round(ms) } : {}),
      failed: r.failed === true || !status || status >= 400
    })
  }
  return out
}

/**
 * Read the page's console.
 *
 * `level` narrows the same way the preview's console read does: `error` keeps only
 * errors, `warn` keeps warnings *and* errors (a warning-only view hides the thing
 * that usually caused it), `all` keeps everything.
 */
export async function readConsole(
  target: BrowserTarget,
  level: 'all' | 'error' | 'warn' = 'all'
): Promise<DebugReport> {
  await installRecorder(target)
  let raw: unknown
  try {
    raw = await target.executeJavaScript(
      `(function () { var s = window.${STORE}; return s ? s.logs.slice() : null; })()`
    )
  } catch (err) {
    return { text: `Could not read the console: ${String(err)}`, truncated: false, count: 0 }
  }
  if (raw === null || raw === undefined) {
    return {
      text:
        'No console recorder is active on this page yet — nothing was watching when the page ran.\n' +
        'It is installed now, so reload or interact with the page and read the console again.',
      truncated: false,
      count: 0
    }
  }
  const all = asConsoleEntries(raw)
  const kept =
    level === 'error'
      ? all.filter((e) => e.level === 'error')
      : level === 'warn'
        ? all.filter((e) => e.level === 'warn' || e.level === 'error')
        : all
  if (kept.length === 0) {
    const scope = level === 'all' ? 'messages' : `${level}s`
    return { text: `CONSOLE (${level}): no ${scope} recorded.`, truncated: false, count: 0 }
  }
  const shown = kept.slice(-MAX_REPORTED)
  const lines = shown.map((e) => `[${e.level}] ${e.text}`)
  return {
    text: `CONSOLE (${level}, ${kept.length} recorded):\n${lines.join('\n')}`,
    truncated: shown.length < kept.length,
    count: kept.length
  }
}

/**
 * Read the requests the page made.
 *
 * Prefers the recorder's own entries (they carry the response status, which is what
 * a failing call is diagnosed by). When nothing was recorded — a page that loaded
 * before the recorder existed — it falls back to the browser's `performance`
 * resource timings so the answer is still a list of real URLs instead of nothing.
 */
export async function readNetwork(
  target: BrowserTarget,
  filter: 'all' | 'failed' = 'all'
): Promise<DebugReport> {
  await installRecorder(target)
  let raw: unknown
  try {
    raw = await target.executeJavaScript(
      `(function () {
        var s = window.${STORE};
        if (s && s.net.length) return { source: 'recorder', items: s.net.slice() };
        try {
          var entries = performance.getEntriesByType('resource').slice(-${RING});
          return {
            source: 'timings',
            items: entries.map(function (e) {
              return { method: 'GET', url: e.name, status: 0, ms: Math.round(e.duration), failed: false };
            })
          };
        } catch (e) {
          return { source: 'none', items: [] };
        }
      })()`
    )
  } catch (err) {
    return { text: `Could not read the network: ${String(err)}`, truncated: false, count: 0 }
  }
  const box = (raw ?? {}) as { source?: unknown; items?: unknown }
  const fromTimings = box.source === 'timings'
  const all = asNetworkEntries(box.items)
  // A resource timing cannot say whether a request failed, so `failed` is never
  // claimed off one — filtering for failures there would invent findings.
  const kept = filter === 'failed' && !fromTimings ? all.filter((e) => e.failed) : all
  if (kept.length === 0) {
    return {
      text:
        filter === 'failed'
          ? 'NETWORK (failed): no failed requests recorded.'
          : 'NETWORK: no requests recorded. The recorder is active now — reload or interact with the page and read again.',
      truncated: false,
      count: 0
    }
  }
  const shown = kept.slice(-MAX_REPORTED)
  const lines = shown.map((e) => {
    const status = e.status ? String(e.status) : fromTimings ? '—' : 'failed'
    return `${e.method} ${status}${e.ms ? ` ${e.ms}ms` : ''} ${e.url}`
  })
  const note = fromTimings
    ? '\n(from the browser’s resource timings — statuses are unavailable for requests made before this read)'
    : ''
  // Don't let the header imply these *are* the failures when the fallback can't
  // tell: say so in the label rather than quietly answering a different question.
  const label = filter === 'failed' && fromTimings ? 'failures unknown, showing all' : filter
  return {
    text: `NETWORK (${label}, ${kept.length} recorded):\n${lines.join('\n')}${note}`,
    truncated: shown.length < kept.length,
    count: kept.length
  }
}

/** Computed properties always worth reporting, before the caller's extras. */
const DEFAULT_STYLES = [
  'display',
  'position',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'margin',
  'padding'
]

/**
 * Report one element as it actually renders: its tag/id/classes, its text, its box,
 * and its *computed* styles — the values the browser resolved, not what a stylesheet
 * asked for. That distinction is the whole point of this read, so a claim about a
 * colour or a size can be checked instead of assumed.
 */
export async function inspectElement(
  target: BrowserTarget,
  selector: string,
  styles: string[] = []
): Promise<DebugReport> {
  const wanted = [...DEFAULT_STYLES, ...styles.filter((s) => typeof s === 'string' && s.trim())]
  let raw: unknown
  try {
    raw = await target.executeJavaScript(
      `(function () {
        var el;
        try { el = document.querySelector(${JSON.stringify(selector)}); } catch (e) { return { bad: true }; }
        if (!el) return null;
        var cs = getComputedStyle(el);
        var box = el.getBoundingClientRect();
        var out = {};
        var want = ${JSON.stringify(wanted)};
        for (var i = 0; i < want.length; i++) out[want[i]] = cs.getPropertyValue(want[i]);
        return {
          tag: el.tagName.toLowerCase(),
          id: el.id || '',
          className: typeof el.className === 'string' ? el.className : '',
          text: String(el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 600),
          box: {
            x: Math.round(box.x), y: Math.round(box.y),
            w: Math.round(box.width), h: Math.round(box.height)
          },
          visible: box.width > 0 && box.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none',
          count: document.querySelectorAll(${JSON.stringify(selector)}).length,
          styles: out
        };
      })()`
    )
  } catch (err) {
    return { text: `Could not inspect "${selector}": ${String(err)}`, truncated: false, count: 0 }
  }
  if (raw && typeof raw === 'object' && (raw as { bad?: unknown }).bad === true) {
    return { text: `"${selector}" is not a valid CSS selector.`, truncated: false, count: 0 }
  }
  if (!raw || typeof raw !== 'object') {
    return { text: `No element matches "${selector}" on this page.`, truncated: false, count: 0 }
  }
  const el = raw as {
    tag: string
    id: string
    className: string
    text: string
    box: { x: number; y: number; w: number; h: number }
    visible: boolean
    count: number
    styles: Record<string, string>
  }
  const head = `ELEMENT ${selector} → <${el.tag}${el.id ? ` id="${el.id}"` : ''}${
    el.className ? ` class="${clip(el.className)}"` : ''
  }>`
  const matches = el.count > 1 ? ` (${el.count} match, showing the first)` : ''
  const styleLines = Object.entries(el.styles ?? {})
    .filter(([, v]) => typeof v === 'string' && v.trim())
    .map(([k, v]) => `  ${k}: ${v.trim()}`)
  return {
    text:
      `${head}${matches}\n` +
      `box: ${el.box.w}×${el.box.h} at (${el.box.x}, ${el.box.y})${el.visible ? '' : ' — NOT visible'}\n` +
      `text: ${el.text ? `"${el.text}"` : '(none)'}\n` +
      `computed styles:\n${styleLines.join('\n') || '  (none)'}`,
    truncated: false,
    count: el.count
  }
}
