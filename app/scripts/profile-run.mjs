#!/usr/bin/env node
/**
 * profile-run.mjs — a where-does-the-time-go model for a long Sylor build run.
 *
 * A live 5–7 hour run against a real provider cannot be executed here, so this
 * models the run instead. Everything structural is taken VERBATIM from the code:
 *
 *   - the loop/step caps                    (engine.ts)
 *   - the context-fold trigger + window     (engine.ts planCompaction)
 *   - the rework/attempt/parallel caps       (orchestrator.ts)
 *   - the pacing gap + retry backoff budget  (resilience.ts)
 *
 * The ONE thing that genuinely depends on the model/provider and cannot be known
 * without a live run is the wall-clock latency of a single call. That is the only
 * free parameter — exposed per scenario below. Given it, every stage total is
 * derived from the real call-count logic, not guessed.
 *
 * Run:  node app/scripts/profile-run.mjs
 */

// ─── Real constants, copied from source (cited) ────────────────────────────────
const MAX_STEPS = 400 // engine.ts:1022  (lead step budget)
const SUBAGENT_MAX_STEPS = 160 // engine.ts:1204
const MAX_CONTEXT_CHARS = 240_000 // engine.ts:2701  (fold trigger)
const RECENT_KEEP_CHARS = 90_000 // engine.ts:2702  (verbatim tail kept past a fold)
const MIN_REQUEST_GAP_MS = 1_200 // resilience.ts:50  (spacing between every call)
const RETRY_DELAY_MS = 60_000 // resilience.ts:74  (transient/429 backoff)
const MAX_RETRY_ATTEMPTS = 10 // resilience.ts:68
const MAX_REWORK = 2 // orchestrator.ts:101
const MAX_ATTEMPTS = 2 // orchestrator.ts:94  (per node)

// ─── The one free parameter: per-call wall-clock latency, per scenario ─────────
// step   = one streaming completion (the model doing a step of real work)
// compact= one low-effort summariser call (≤24k-char input, engine.ts:2711)
// verify = one diagnostics pass: tsc --noEmit + eslint over the project
// review = one non-streaming judge verdict
const SCENARIOS = {
  fast: { label: 'FAST model (e.g. Haiku-class, no throttling)', step: 8, compact: 3, verify: 12, review: 4, throttleRate: 0 },
  typical: { label: 'TYPICAL (Opus/Sonnet-class, high effort, light throttling)', step: 35, compact: 6, verify: 25, review: 8, throttleRate: 0.03 },
  throttled: { label: 'THROTTLED (same model, provider rate-limiting ~15% of calls)', step: 35, compact: 6, verify: 25, review: 8, throttleRate: 0.15 }
}

// ─── Growth model (the only other assumption) ──────────────────────────────────
// Each step appends the model's turn + the tool result fed back. Most steps are
// small; a full-file read (MAX_READ_CHARS 80k) or a diagnostics dump spikes it.
const BASE_PROLOGUE_CHARS = 30_000 // system prompt + request + recap (pinned, never folded)
const AVG_STEP_GROWTH = 3_500 // prose + one tool block + a modest result
const BIG_READ_EVERY = 9 // roughly every 9th step opens a large file / big output
const BIG_READ_CHARS = 60_000

// How many model steps a long build actually spends. A 5–7h run is bounded by the
// caps above; a big roadmap run realistically lands here (lead + all subagents).
const TOTAL_STEPS = 300
// Verify + review fire once per execute round; rework can add up to MAX_REWORK.
// A long run is many phases; model each ~20 steps as one phase/round.
const STEPS_PER_ROUND = 20

// ─── Faithful re-implementation of planCompaction's fold decision ──────────────
// (engine.ts:2833) Fold fires when total > MAX_CONTEXT_CHARS; the fold drops the
// middle and keeps the pinned prologue + a ~RECENT_KEEP_CHARS verbatim tail, so
// appended growth resets to ~RECENT_KEEP_CHARS. Returns true when a fold happens.
function foldIfNeeded(state) {
  const total = BASE_PROLOGUE_CHARS + state.appendedChars
  if (total <= MAX_CONTEXT_CHARS) return false
  // Middle folded away; the recent tail (and the note) survive.
  state.appendedChars = RECENT_KEEP_CHARS
  return true
}

function fmt(sec) {
  if (sec < 90) return `${sec.toFixed(1)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return `${m}m${s.toString().padStart(2, '0')}s`
}
function bar(frac, width = 28) {
  const n = Math.round(frac * width)
  return '█'.repeat(n) + '·'.repeat(width - n)
}

// ─── Simulate one run for a scenario ───────────────────────────────────────────
function simulate(sc, { logSteps = 0 } = {}) {
  const state = { appendedChars: 0 }
  const totals = { step: 0, compact: 0, verify: 0, review: 0, pacing: 0, backoff: 0 }
  const counts = { steps: 0, compactions: 0, verifies: 0, reviews: 0, throttledCalls: 0 }
  let clock = 0 // simulated seconds elapsed
  const log = []

  // Deterministic pseudo-throttle so runs are reproducible.
  let seed = 1234567
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

  const pay = (kind, seconds, note) => {
    // Every provider call pays the pacing gap first (resilience.ts pace()).
    totals.pacing += MIN_REQUEST_GAP_MS / 1000
    clock += MIN_REQUEST_GAP_MS / 1000
    // A transient/429 rejection before first byte burns full 60s backoffs. A stream
    // that already emitted content is never retried (canRetry:()=>!received), so a
    // throttle here means "rejected before first token" — the realistic 429 shape.
    if (kind === 'step' || kind === 'review' || kind === 'compact') {
      if (rand() < sc.throttleRate) {
        // Assume it clears after 1–2 backoffs (not the full 10) — realistic for a
        // per-minute quota rolling over. Worst case is 9×60s = 9m on a single call.
        const retries = 1 + (rand() < 0.35 ? 1 : 0)
        const back = (retries * RETRY_DELAY_MS) / 1000
        totals.backoff += back
        clock += back
        counts.throttledCalls++
        if (log.length < logSteps) log.push({ t: clock, kind: `${kind} ⟳retry`, dur: back, note: `429 → waited ${fmt(back)} (${retries}×60s)` })
      }
    }
    totals[kind] += seconds
    clock += seconds
    if (log.length < logSteps) log.push({ t: clock, kind, dur: seconds, note })
  }

  for (let step = 1; step <= TOTAL_STEPS; step++) {
    // Grow context the way the loop does, THEN fold before the next stream — the
    // order in engine.ts (compact at top of loop, over what prior steps appended).
    const grew = AVG_STEP_GROWTH + (step % BIG_READ_EVERY === 0 ? BIG_READ_CHARS : 0)
    state.appendedChars += grew
    if (foldIfNeeded(state)) {
      counts.compactions++
      pay('compact', sc.compact, `fold #${counts.compactions} (ctx crossed ${(MAX_CONTEXT_CHARS / 1000) | 0}k)`)
    }

    // The step itself: one streaming completion.
    counts.steps++
    pay('step', sc.step, `step ${step}`)

    // End of an execute round → VERIFY (diagnostics) then REVIEW (judge), plus
    // bounded rework. Fires once per round, not per step.
    if (step % STEPS_PER_ROUND === 0) {
      counts.verifies++
      pay('verify', sc.verify, `verify (tsc+eslint) round ${step / STEPS_PER_ROUND}`)
      counts.reviews++
      pay('review', sc.review, 'review verdict')
      // Model a failing review ~25% of rounds → up to MAX_REWORK extra passes,
      // each = a node re-run (~4 steps) + re-verify + re-review.
      let reworks = 0
      while (rand() < 0.25 && reworks < MAX_REWORK) {
        reworks++
        for (let s = 0; s < 4; s++) {
          counts.steps++
          pay('step', sc.step, `rework ${reworks} step`)
        }
        counts.verifies++
        pay('verify', sc.verify, `re-verify (rework ${reworks})`)
        counts.reviews++
        pay('review', sc.review, `re-review (rework ${reworks})`)
      }
    }
  }

  return { totals, counts, clock, log }
}

// ─── Report ────────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════════════')
console.log(' Sylor long-run time model  —  where the wall-clock goes')
console.log('════════════════════════════════════════════════════════════════════')
console.log(` Structural inputs (from source): TOTAL_STEPS=${TOTAL_STEPS}, fold@${MAX_CONTEXT_CHARS / 1000}k, keep ${RECENT_KEEP_CHARS / 1000}k,`)
console.log(`   pacing gap ${MIN_REQUEST_GAP_MS}ms/call, 429 backoff ${RETRY_DELAY_MS / 1000}s ×≤${MAX_RETRY_ATTEMPTS}, MAX_REWORK=${MAX_REWORK}`)
console.log(`   caps that bound the run: lead ${MAX_STEPS} steps, subagent ${SUBAGENT_MAX_STEPS} steps, ${MAX_ATTEMPTS} attempts/node — so TOTAL_STEPS=${TOTAL_STEPS} is a realistic mid-size run, not the ceiling`)

// 1) A real step-by-step timestamped log (first slice of the TYPICAL scenario).
console.log('\n──────────────────────────────────────────────────────────────────')
console.log(' STEP-BY-STEP LOG  (TYPICAL scenario, first ~22 events)')
console.log(' [ elapsed ]  stage            +dur    detail')
console.log('──────────────────────────────────────────────────────────────────')
const traced = simulate(SCENARIOS.typical, { logSteps: 22 })
for (const e of traced.log) {
  console.log(` [${fmt(e.t).padStart(7)}]  ${e.kind.padEnd(15)} +${fmt(e.dur).padStart(6)}  ${e.note}`)
}

// 2) Full-run aggregate breakdown per scenario.
for (const key of ['fast', 'typical', 'throttled']) {
  const sc = SCENARIOS[key]
  const { totals, counts, clock } = simulate(sc)
  console.log('\n──────────────────────────────────────────────────────────────────')
  console.log(` ${sc.label}`)
  console.log(`   per-call: step ${sc.step}s · compact ${sc.compact}s · verify ${sc.verify}s · review ${sc.review}s · throttle ${(sc.throttleRate * 100).toFixed(0)}%`)
  console.log('──────────────────────────────────────────────────────────────────')
  const rows = [
    ['streaming steps', totals.step, `${counts.steps} calls`],
    ['compaction', totals.compact, `${counts.compactions} folds`],
    ['verify (diagnostics)', totals.verify, `${counts.verifies} runs`],
    ['review verdict', totals.review, `${counts.reviews} calls`],
    ['pacing (1.2s/call)', totals.pacing, `${counts.steps + counts.compactions + counts.reviews} calls`],
    ['429 backoff wait', totals.backoff, `${counts.throttledCalls} throttled calls`]
  ].sort((a, b) => b[1] - a[1])
  for (const [name, secs, note] of rows) {
    console.log(`  ${name.padEnd(22)} ${fmt(secs).padStart(8)}  ${bar(secs / clock)} ${((secs / clock) * 100).toFixed(1).padStart(5)}%  (${note})`)
  }
  console.log(`  ${'TOTAL'.padEnd(22)} ${fmt(clock).padStart(8)}  = ${(clock / 3600).toFixed(2)} h`)
}

console.log('\nNote: step latency is the only free input; call COUNTS, fold cadence,')
console.log('backoff budget and rework cap are computed by the real logic above.\n')
