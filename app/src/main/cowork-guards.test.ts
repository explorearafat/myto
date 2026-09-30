import { describe, expect, it } from 'vitest'
import {
  looksLikeUnsavedCode,
  MIN_UNSAVED_CODE_LINES,
  MAX_CODE_PROSE_NUDGES,
  extractNarratedFiles,
  isSafeRelPath,
  detectOscillation,
  looksLikeContinuationRequest,
  looksLikeAnnouncedAction,
  looksLikeFalseLimitDeferral,
  looksLikeContentFreeReply,
  planHasPending,
  pendingPlanTitles,
  planFileTarget,
  isVerifyStep,
  OSCILLATION_WINDOW,
  OSCILLATION_MAX
} from './cowork-guards'

/**
 * Build a fenced code block whose *captured body* is exactly `segments` lines long
 * (the capture is everything between the opening fence's newline and the closing
 * fence). `looksLikeUnsavedCode` counts that body's `split('\n').length`, so this lets
 * a test sit exactly on the {@link MIN_UNSAVED_CODE_LINES} threshold.
 */
const fence = (segments: number, lang = ''): string => {
  const body = Array.from({ length: segments }, (_, i) => `line${i}`).join('\n')
  return '```' + lang + '\n' + body + '```'
}

describe('looksLikeUnsavedCode', () => {
  it('is true for a fenced block at the line threshold', () => {
    expect(looksLikeUnsavedCode(fence(MIN_UNSAVED_CODE_LINES))).toBe(true)
  })

  it('is true for a fenced block well over the threshold', () => {
    expect(looksLikeUnsavedCode(fence(MIN_UNSAVED_CODE_LINES + 20))).toBe(true)
  })

  it('is false for a fenced block one line under the threshold', () => {
    expect(looksLikeUnsavedCode(fence(MIN_UNSAVED_CODE_LINES - 1))).toBe(false)
  })

  it('is false for prose with no code fence', () => {
    expect(looksLikeUnsavedCode('Here is how I would approach it, step by step.')).toBe(false)
  })

  it('is false for the empty string', () => {
    expect(looksLikeUnsavedCode('')).toBe(false)
  })

  it('detects a block regardless of the language tag', () => {
    expect(looksLikeUnsavedCode(fence(MIN_UNSAVED_CODE_LINES, 'python'))).toBe(true)
    expect(looksLikeUnsavedCode(fence(MIN_UNSAVED_CODE_LINES, 'ts'))).toBe(true)
  })

  it('ignores several short blocks but catches one long block among them', () => {
    const short = `${fence(3)}\nsome prose in between\n${fence(4)}`
    expect(looksLikeUnsavedCode(short)).toBe(false)
    expect(looksLikeUnsavedCode(`${fence(3)}\n${fence(MIN_UNSAVED_CODE_LINES + 5)}`)).toBe(true)
  })

  it('does not leak regex state between calls (fresh matcher each time)', () => {
    const big = fence(MIN_UNSAVED_CODE_LINES + 5)
    expect(looksLikeUnsavedCode(big)).toBe(true)
    expect(looksLikeUnsavedCode(big)).toBe(true)
  })

  // Regression (mid-build stall found by the Step-5 e2e): the model wrote index.html
  // with a real write_file call, then narrated styles.css and app.js as fenced prose.
  // The guard must flag that narrated file so the loop nudges the model to save it —
  // its firing no longer depends on the run having built nothing (buildsMade === 0);
  // the loop caps it with MAX_CODE_PROSE_NUDGES and resets on each real tool call.
  it('flags a narrated file even after earlier files were written', () => {
    const narratedCss =
      'Great, index.html is done. Now here is styles.css:\n\n' +
      '```css\n' +
      ':root { --bg: #fff; --fg: #111; }\n' +
      '[data-theme="dark"] { --bg: #111; --fg: #eee; }\n' +
      'body { background: var(--bg); color: var(--fg); }\n' +
      '.app-header { display: flex; justify-content: space-between; }\n' +
      '.card { border-radius: 12px; padding: 16px; }\n' +
      '.table { width: 100%; border-collapse: collapse; }\n' +
      '.table th { text-align: left; }\n' +
      '.chart { height: 240px; }\n' +
      '.theme-toggle { cursor: pointer; }\n' +
      '.muted { opacity: 0.7; }\n' +
      '```\n'
    expect(looksLikeUnsavedCode(narratedCss)).toBe(true)
  })

  it('MAX_CODE_PROSE_NUDGES is a small positive bound', () => {
    expect(Number.isInteger(MAX_CODE_PROSE_NUDGES)).toBe(true)
    expect(MAX_CODE_PROSE_NUDGES).toBeGreaterThan(0)
    expect(MAX_CODE_PROSE_NUDGES).toBeLessThanOrEqual(8)
  })
})

describe('isSafeRelPath', () => {
  it('accepts plain relative paths ending in a code extension', () => {
    expect(isSafeRelPath('index.html')).toBe(true)
    expect(isSafeRelPath('styles.css')).toBe(true)
    expect(isSafeRelPath('app.js')).toBe(true)
    expect(isSafeRelPath('src/components/Chart.tsx')).toBe(true)
    expect(isSafeRelPath('data/seed.json')).toBe(true)
  })

  it('rejects absolute paths, drive letters, and UNC/backslash paths', () => {
    expect(isSafeRelPath('/etc/passwd')).toBe(false)
    expect(isSafeRelPath('C:/Windows/system32/x.js')).toBe(false)
    expect(isSafeRelPath('C:\\Users\\me\\x.js')).toBe(false)
    expect(isSafeRelPath('src\\app.js')).toBe(false)
  })

  it('rejects traversal — any .. or . segment', () => {
    expect(isSafeRelPath('../secret.js')).toBe(false)
    expect(isSafeRelPath('src/../../etc/x.css')).toBe(false)
    expect(isSafeRelPath('./app.js')).toBe(false)
    expect(isSafeRelPath('a/./b.js')).toBe(false)
  })

  it('rejects a path with no extension, the empty string, and an over-long path', () => {
    expect(isSafeRelPath('README')).toBe(false)
    expect(isSafeRelPath('src/utils')).toBe(false)
    expect(isSafeRelPath('')).toBe(false)
    expect(isSafeRelPath('   ')).toBe(false)
    expect(isSafeRelPath('a/'.repeat(120) + 'x.js')).toBe(false)
  })
})

describe('extractNarratedFiles', () => {
  const bigBody = (lines: number): string =>
    Array.from({ length: lines }, (_, i) => `  line ${i};`).join('\n')

  it('pulls the filename from the fence info string', () => {
    const text = 'Here it is:\n\n```js app.js\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```\n'
    const files = extractNarratedFiles(text)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('app.js')
    expect(files[0].content).toContain('line 0;')
  })

  it('pulls the filename from a leading comment on the first body line', () => {
    const html = '```html\n<!-- index.html -->\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```'
    const css = '```\n/* styles.css */\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```'
    const js = '```\n// app.js\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```'
    const py = '```\n# seed.py\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```'
    expect(extractNarratedFiles(html)[0].path).toBe('index.html')
    expect(extractNarratedFiles(css)[0].path).toBe('styles.css')
    expect(extractNarratedFiles(js)[0].path).toBe('app.js')
    expect(extractNarratedFiles(py)[0].path).toBe('seed.py')
  })

  it('falls back to the last filename in the ~200 chars of prose before the fence', () => {
    const text = 'Now here is the stylesheet, styles.css:\n\n```\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```'
    const files = extractNarratedFiles(text)
    expect(files).toHaveLength(1)
    expect(files[0].path).toBe('styles.css')
  })

  it('extracts multiple distinct narrated files in one reply', () => {
    const text =
      '```css styles.css\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```\n\n' +
      'and the script:\n\n```js app.js\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```'
    const files = extractNarratedFiles(text)
    expect(files.map((f) => f.path).sort()).toEqual(['app.js', 'styles.css'])
  })

  it('dedupes a repeated path, keeping the last (more complete) body', () => {
    const text =
      '```js app.js\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```\n' +
      '```js app.js\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\nline EXTRA;\n```'
    const files = extractNarratedFiles(text)
    expect(files).toHaveLength(1)
    expect(files[0].content).toContain('line EXTRA;')
  })

  it('ignores blocks under the line threshold and blocks with no derivable name', () => {
    const short = '```js app.js\nconst a = 1;\n```'
    const unnamed = '```\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```'
    expect(extractNarratedFiles(short)).toHaveLength(0)
    expect(extractNarratedFiles(unnamed)).toHaveLength(0)
  })

  it('never returns an unsafe path (traversal / absolute in the fence info is dropped)', () => {
    const traversal = '```js ../../evil.js\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```'
    const absolute = '```js /etc/evil.js\n' + bigBody(MIN_UNSAVED_CODE_LINES) + '\n```'
    expect(extractNarratedFiles(traversal)).toHaveLength(0)
    expect(extractNarratedFiles(absolute)).toHaveLength(0)
  })

  it('is empty for prose with no fenced code and for the empty string', () => {
    expect(extractNarratedFiles('Just a plain explanation, no code here.')).toHaveLength(0)
    expect(extractNarratedFiles('')).toHaveLength(0)
  })
})

describe('detectOscillation', () => {
  const opts = { window: OSCILLATION_WINDOW, maxRepeatsInWindow: OSCILLATION_MAX }

  it('returns null for an empty or too-short history', () => {
    expect(detectOscillation([], opts)).toBeNull()
    expect(detectOscillation(['a', 'a'], opts)).toBeNull() // below the max of 3
  })

  it('returns null when every call is distinct', () => {
    expect(detectOscillation(['a', 'b', 'c', 'd', 'e'], opts)).toBeNull()
  })

  it('detects three consecutive identical calls', () => {
    expect(detectOscillation(['a', 'a', 'a'], opts)).toEqual({ sig: 'a', count: 3 })
  })

  it('detects a NON-consecutive ping-pong the consecutive guard misses (A,B,A,B,A)', () => {
    expect(detectOscillation(['a', 'b', 'a', 'b', 'a'], opts)).toEqual({ sig: 'a', count: 3 })
  })

  it('never collides distinct targets — read_file a vs read_file b stays under the limit', () => {
    const sigs = ['read_file:{"path":"a"}', 'read_file:{"path":"b"}', 'read_file:{"path":"a"}', 'read_file:{"path":"b"}']
    expect(detectOscillation(sigs, opts)).toBeNull()
  })

  it('only counts within the window — old repeats scroll out of view', () => {
    // Two "a"s then a long run of distinct calls: "a" is no longer within the last 8.
    const sigs = ['a', 'a', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']
    expect(detectOscillation(sigs, opts)).toBeNull()
    // But a third "a" inside the window trips it.
    expect(detectOscillation(['a', 'a', 'c', 'd', 'e', 'f', 'g', 'a'], opts)).toEqual({ sig: 'a', count: 3 })
  })

  it('reports the worst offender when more than one signature qualifies', () => {
    expect(detectOscillation(['a', 'a', 'a', 'b', 'b', 'b', 'b'], opts)).toEqual({ sig: 'b', count: 4 })
  })
})

describe('looksLikeContinuationRequest', () => {
  it('is true for interrogative permission-to-continue asks', () => {
    expect(looksLikeContinuationRequest('Should I continue?')).toBe(true)
    expect(looksLikeContinuationRequest('Shall I proceed?')).toBe(true)
    expect(looksLikeContinuationRequest('Do you want me to continue?')).toBe(true)
    expect(looksLikeContinuationRequest('Would you like me to proceed with the next step?')).toBe(true)
    expect(looksLikeContinuationRequest('Want me to keep going?')).toBe(true)
    expect(looksLikeContinuationRequest("Let me know if you'd like me to continue.")).toBe(true)
  })

  it('is true when the ask closes a longer reply', () => {
    expect(
      looksLikeContinuationRequest('I set up the routes and the models.\n\nShould I continue with the tests?')
    ).toBe(true)
  })

  it('is false for first-person narration (verb after the subject, not a question)', () => {
    expect(looksLikeContinuationRequest('I should continue to the next file.')).toBe(false)
    expect(looksLikeContinuationRequest('I want to continue building the UI.')).toBe(false)
  })

  it('is false for a genuine either/or choice with no continue verb', () => {
    expect(looksLikeContinuationRequest('Should I use Postgres or MySQL?')).toBe(false)
  })

  it('is false for a normal sign-off and a delivered answer', () => {
    expect(looksLikeContinuationRequest('Let me know if you need any changes.')).toBe(false)
    expect(looksLikeContinuationRequest('The app is done. You can run it with npm start.')).toBe(false)
  })

  it('is false for the empty string', () => {
    expect(looksLikeContinuationRequest('')).toBe(false)
    expect(looksLikeContinuationRequest('   ')).toBe(false)
  })
})

describe('looksLikeAnnouncedAction', () => {
  it('is true for the exact half-finished-run stall — a trailing "Now I\'m building…" with no tool call', () => {
    // The verbatim message that ended the user's clone run after only package.json was written.
    expect(
      looksLikeAnnouncedAction(
        'Now I\'m building the complete responsive storefront in `index.html`, including the editorial hero, collection, product grid, atelier section, and accessible bag drawer.'
      )
    ).toBe(true)
  })

  it('is true for common immediate-future build announcements at the tail', () => {
    expect(looksLikeAnnouncedAction("I'll create the index.html file now.")).toBe(true)
    expect(looksLikeAnnouncedAction('Let me write the main stylesheet.')).toBe(true)
    expect(looksLikeAnnouncedAction('Next, I\'ll add the product grid component.')).toBe(true)
    expect(looksLikeAnnouncedAction('I am going to scaffold the project structure.')).toBe(true)
    expect(looksLikeAnnouncedAction('I will now implement the checkout flow.')).toBe(true)
  })

  it('is true for research / browser next-step announcements — the Research-mode stall', () => {
    // A browser/research agent that narrates the next inspection step and then stops with
    // no tool call (the observed Instagram/Research halt). These must trip the guard too.
    expect(looksLikeAnnouncedAction('Let me grab a fresh snapshot to see your conversations.')).toBe(true)
    expect(looksLikeAnnouncedAction("I'll check your latest messages now.")).toBe(true)
    expect(looksLikeAnnouncedAction("Now I'm reading the page to find the reply box.")).toBe(true)
    expect(looksLikeAnnouncedAction('Let me pull up your inbox.')).toBe(true)
    expect(looksLikeAnnouncedAction("I'm going to search for the latest headlines.")).toBe(true)
    expect(looksLikeAnnouncedAction('Let me take a snapshot of the current page.')).toBe(true)
    expect(looksLikeAnnouncedAction("Next, I'll navigate to the settings page.")).toBe(true)
  })

  it('is false for a past-tense research wrap-up — a genuinely finished research reply', () => {
    // Past tense = already done; must NOT be mistaken for an abandoned step.
    expect(looksLikeAnnouncedAction('I checked your messages — you have three new DMs from Alex.')).toBe(
      false
    )
    expect(looksLikeAnnouncedAction('I read the page and pulled the five latest posts for you.')).toBe(
      false
    )
  })

  it('fires off the reply TAIL, so an announcement that closes a longer reply still trips it', () => {
    expect(
      looksLikeAnnouncedAction(
        'I created package.json with the project metadata and scripts.\n\nNow I\'m creating index.html with the full layout.'
      )
    ).toBe(true)
  })

  it('is false for a past-tense wrap-up — a genuinely finished reply', () => {
    expect(looksLikeAnnouncedAction("I've built the full storefront in index.html. You can open it now.")).toBe(
      false
    )
    expect(looksLikeAnnouncedAction('Created all the files. The site is ready to run.')).toBe(false)
    expect(looksLikeAnnouncedAction('Done — the project is complete.')).toBe(false)
  })

  it('is false when an "I\'ll …" appears early but the reply then concludes', () => {
    // The announcement is buried; the reply's tail is a finished statement, so no nudge.
    expect(
      looksLikeAnnouncedAction(
        "First I'll create the files. All three files are written and the build passes cleanly."
      )
    ).toBe(false)
  })

  it('is false for the empty string and plain prose', () => {
    expect(looksLikeAnnouncedAction('')).toBe(false)
    expect(looksLikeAnnouncedAction('   ')).toBe(false)
    expect(looksLikeAnnouncedAction('The endpoint returns a paginated list of users.')).toBe(false)
  })

  it('is false for the "looking forward" sign-off (a courtesy, not an announced action)', () => {
    expect(looksLikeAnnouncedAction("All done — I'm looking forward to your feedback.")).toBe(false)
  })
})

describe('looksLikeFalseLimitDeferral', () => {
  it('is true for the exact give-up message — invented tool limit + deferral to a later turn', () => {
    // The verbatim reply that ended the user's Lumen run with zero files written.
    expect(
      looksLikeFalseLimitDeferral(
        "I couldn't build or verify the app because the tool-use limit was reached immediately after the plan request. No project files were created or changed. The implementation remains pending for the next available tool-enabled turn."
      )
    ).toBe(true)
  })

  it('is true for a bare invented-limit excuse (either word order)', () => {
    expect(looksLikeFalseLimitDeferral('The tool-use limit was reached, so I stopped.')).toBe(true)
    expect(looksLikeFalseLimitDeferral("I've reached the tool call limit for this reply.")).toBe(true)
    expect(looksLikeFalseLimitDeferral('I ran out of my token budget before finishing.')).toBe(true)
    expect(looksLikeFalseLimitDeferral('The step limit was exceeded.')).toBe(true)
  })

  it('is true for deferring the work to a later turn/session', () => {
    expect(looksLikeFalseLimitDeferral("I'll finish the implementation in the next turn.")).toBe(true)
    expect(looksLikeFalseLimitDeferral('The rest is deferred to a following reply.')).toBe(true)
    expect(looksLikeFalseLimitDeferral('This work remains pending for the next session.')).toBe(true)
  })

  it('is false for a genuinely finished reply', () => {
    expect(
      looksLikeFalseLimitDeferral("I've built the full app in index.html, styles.css, and app.js. You can open it now.")
    ).toBe(false)
    expect(looksLikeFalseLimitDeferral('Done — every file is written and the build passes.')).toBe(false)
  })

  it('does not fire on benign prose that merely mentions later work without an invented limit', () => {
    // "future iteration" is not deferral to a next TURN/REPLY, and no limit is claimed.
    expect(
      looksLikeFalseLimitDeferral('The app is complete. Further optimizations can be done in a future iteration.')
    ).toBe(false)
    // A bare "tool" / "turn" in prose must not trip it — a limit word must follow directly.
    expect(looksLikeFalseLimitDeferral('I used the write_file tool to create each turn of the layout.')).toBe(false)
  })

  it('is false for the empty string and whitespace', () => {
    expect(looksLikeFalseLimitDeferral('')).toBe(false)
    expect(looksLikeFalseLimitDeferral('   ')).toBe(false)
  })
})

describe('looksLikeContentFreeReply', () => {
  it('is true for an empty or whitespace-only reply — the blank final turn that ended the Lumen run', () => {
    expect(looksLikeContentFreeReply('')).toBe(true)
    expect(looksLikeContentFreeReply('   ')).toBe(true)
    expect(looksLikeContentFreeReply('\n\n\t  \n')).toBe(true)
  })

  it('is true for a reply made only of punctuation or a stray mark (no word characters)', () => {
    expect(looksLikeContentFreeReply('...')).toBe(true)
    expect(looksLikeContentFreeReply('—')).toBe(true)
    expect(looksLikeContentFreeReply('✻')).toBe(true)
    expect(looksLikeContentFreeReply('  …  ')).toBe(true)
  })

  it('is false as soon as the reply carries any real word or digit', () => {
    // A one-line answer, a lone acknowledgement, or a restated intention all have letters.
    expect(looksLikeContentFreeReply('Done.')).toBe(false)
    expect(looksLikeContentFreeReply('It uses PostgreSQL.')).toBe(false)
    expect(looksLikeContentFreeReply("I'll start by drafting a plan, then build every file out.")).toBe(false)
    expect(looksLikeContentFreeReply('42')).toBe(false)
  })
})

describe('planHasPending', () => {
  it('is false for an empty plan — nothing to finish, do not gate the finish', () => {
    // The model never called update_plan; there is no plan to be incomplete against.
    expect(planHasPending([])).toBe(false)
  })

  it('is true when any item is not done — the "stuck at 0/4" stall the finish must catch', () => {
    expect(
      planHasPending([
        { title: 'index.html', status: 'pending' },
        { title: 'styles.css', status: 'pending' },
        { title: 'app.js', status: 'pending' },
        { title: 'chart', status: 'pending' }
      ])
    ).toBe(true)
  })

  it('is true when the plan is partway done (in_progress or a mix)', () => {
    expect(
      planHasPending([
        { title: 'a', status: 'done' },
        { title: 'b', status: 'in_progress' },
        { title: 'c', status: 'done' }
      ])
    ).toBe(true)
  })

  it('is false only when every item is done — the run may finish', () => {
    expect(
      planHasPending([
        { title: 'a', status: 'done' },
        { title: 'b', status: 'done' }
      ])
    ).toBe(false)
  })

  it('treats a missing/unknown status as pending (not accidentally "done")', () => {
    expect(planHasPending([{ title: 'a' }])).toBe(true)
    expect(planHasPending([{ title: 'a', status: 'cancelled' }])).toBe(true)
  })
})

describe('pendingPlanTitles', () => {
  it('lists only the not-done items, by title', () => {
    expect(
      pendingPlanTitles([
        { title: 'index.html', status: 'done' },
        { title: 'styles.css', status: 'pending' },
        { title: 'app.js', status: 'in_progress' }
      ])
    ).toEqual(['styles.css', 'app.js'])
  })

  it('falls back to a positional label when an item has no usable title', () => {
    expect(
      pendingPlanTitles([{ title: '   ', status: 'pending' }, { status: 'pending' }])
    ).toEqual(['Step 1', 'Step 2'])
  })

  it('is empty when the plan is empty or fully done', () => {
    expect(pendingPlanTitles([])).toEqual([])
    expect(pendingPlanTitles([{ title: 'a', status: 'done' }])).toEqual([])
  })
})

describe('planFileTarget', () => {
  it('extracts the file a build step is about', () => {
    expect(planFileTarget('Create app.js with the chart logic')).toBe('app.js')
    expect(planFileTarget('Write styles.css (dark/light theme)')).toBe('styles.css')
    expect(planFileTarget('index.html')).toBe('index.html')
    expect(planFileTarget('Build src/components/Chart.tsx')).toBe('src/components/Chart.tsx')
  })

  it('returns null for a title that names no file', () => {
    expect(planFileTarget('Verify in the preview pane')).toBeNull()
    expect(planFileTarget('Set up the project structure')).toBeNull()
    expect(planFileTarget('')).toBeNull()
    expect(planFileTarget(undefined)).toBeNull()
  })

  it('rejects an unsafe path rather than returning it', () => {
    expect(planFileTarget('Overwrite ../../etc/passwd.txt')).toBeNull()
    expect(planFileTarget('Write C:/Windows/system.ini')).toBeNull()
  })
})

describe('isVerifyStep', () => {
  it('is true for a check-the-result step with no file', () => {
    expect(isVerifyStep('Verify in the preview pane')).toBe(true)
    expect(isVerifyStep('Test the theme toggle')).toBe(true)
    expect(isVerifyStep('Open the app and confirm the chart renders')).toBe(true)
    expect(isVerifyStep('Review the final result')).toBe(true)
  })

  it('is false for a build step, even one whose title uses a verify verb', () => {
    // A step that names a file is a build step no matter the verb — it must not be
    // auto-completed just because disk-agnostic verify verbs matched.
    expect(isVerifyStep('Create and test app.js')).toBe(false)
    expect(isVerifyStep('index.html')).toBe(false)
    expect(isVerifyStep('Write styles.css')).toBe(false)
  })

  it('is false for a non-verify title and for an empty one', () => {
    expect(isVerifyStep('Set up the project')).toBe(false)
    expect(isVerifyStep('')).toBe(false)
    expect(isVerifyStep(undefined)).toBe(false)
  })
})
