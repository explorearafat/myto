# Myto Agent Architecture — Design Proposal (Phase 1)

**Status:** design only. No working code is touched by this document. This is the Phase 1
deliverable and the gate for Phase 2 (incremental migration). Approval of *this* document
is the "approve" the earlier instruction referred to: *"Do not touch working code until I
approve this document."*

**Companion:** [architecture-audit.md](architecture-audit.md) (Phase 0). Every "Current"
line below is a one-line pointer back to a confirmed audit finding; the evidence lives
there.

**What this is:** a subsystem-by-subsystem redesign of Myto's core agent, built to the
seven principles you set, using Claude Code's and Codex's actual production design as the
reference standard. For each principle: the **goal**, the **reference** (how CC/Codex do
it), the **current** behaviour, the **design** (concrete modules, data shapes, seams — with
*illustrative* signatures marked as such, not final code), the **invariants preserved**,
and **how we'll know it works** (the observable signal, which becomes a Phase 3 metric).

**What this is not:** final code. Signatures below are illustrative; exact shapes are
decided in Phase 2, one subsystem at a time, each verified before the next.

**Design tenets (the CC/Codex commitments we are adopting):**

1. Plans are *data sized to the task*, and they obey explicit user scope.
2. The plan/task-state is *always in context* and re-grounded across seams — never
   summarised away.
3. Discovery done once is *owned*: subagents receive context, they don't rediscover it.
4. "Done" requires a *positive green signal*, within bounded rework — absence of red is
   not success.
5. Reasoning budget is a *per-step dial*, not a per-turn constant.
6. Backoff is *exponential with jitter and honours `Retry-After`*; rate is *shaped*, not
   hammered.
7. Permissions are a *real matrix over a real OS-enforced sandbox* — a raw shell call
   cannot escape it.

---

## Principle 1 — Dynamic, task-scoped planning that honours explicit constraints

**Goal.** Plan length and shape follow the actual decomposition and obey explicit user
scope like "in at most 5 steps" / "keep it minimal" / "only touch file X".

**Reference.** Claude Code's `TodoWrite` and Codex's `update_plan` produce a list whose
length *is* the decomposition — no fixed ladder, and directly responsive to the user's
stated scope.

**Current.** Fixed 3/5/9 phase roadmaps with canned phase names; a 29-section template
rendered 15/24/29 by complexity; nothing parses an explicit step-count. (Audit §A.)

**Design.**

1. **Extract explicit constraints (new `orchestrator/constraints.ts`).** A deterministic
   pass over the request (regex for the common numeric/keyword forms), with the already
   model-first complexity router returning an optional structured constraint as a second
   source. Illustrative:
   ```ts
   interface PlanConstraints {
     maxSteps?: number      // "in at most 5 steps"
     maxPhases?: number     // "no more than 2 phases"
     minimal?: boolean      // "keep it minimal", "don't over-engineer", "just do X"
     filesScope?: string[]  // "only touch src/foo.ts"
     verbatim: string       // the phrase we matched, quoted back in the plan
   }
   ```

2. **The roadmap becomes a budget, not a template.** Complexity still proposes a *default*
   phase count (3/5/9 as an *upper* default), but `maxPhases` / `maxSteps` / `minimal`
   hard-clamp it. `resolvePhase` (staging.ts) gains the ability to shrink to an *explicit*
   cap at any point — not only "before phase 1", which is the current anti-poison rule for
   *inferred* complexity.

3. **Phase names are authored for this project, not canned.** The plan-authoring call
   proposes phase names/objectives specific to the request; the `SMALL/MEDIUM/LARGE_PHASES`
   literals demote to an offline/thin-model fallback. Kills "the same nine names for every
   complex build."

4. **A lean section set for `minimal`.** `sectionsFor` gains a `minimal` path that renders
   only the actionable sections (why, requirements, files to create/modify/protect, tasks,
   checklist) regardless of complexity — so "keep it minimal" yields a lean plan even when
   the work is objectively large.

5. **The planner clamps to the budget.** `buildPlan`'s `MAX_TASKS` becomes
   `min(8, maxSteps ?? 8)`, and the planner prompt is told the hard ceiling. "Max 5 steps"
   literally yields ≤5 task nodes and the fewest phases that fit.

**Invariants preserved.** The shrink-only anti-poison rule for *inferred* complexity in
STATE.md stays (a bad route can't grow a project mid-run). Explicit user constraints are a
*separate, stronger* signal that lives in the request, re-applied every turn. `SIMPLE` →
single-node, no-LLM path stays.

**How we'll know it works.** "Build X in at most 5 steps" → plan has ≤5 tasks, the fitting
phase count, and quotes the constraint. Phase 3 metric: *phase count generated* respects an
added "max N" instruction on the TaskFlow benchmark.

**Implemented (Phase 2 · 2026-09-12).** Landed #1, #2, #4, #5 as designed, with #3 deferred
and two deliberate deltas that make the change *more conservative* than the proposal:

- **#1 constraints extractor — landed (`orchestrator/constraints.ts`, new).** Deterministic,
  conservative regex pass → `PlanConstraints { maxSteps?, maxPhases?, minimal?, filesScope?,
  verbatim? }`. Reads digits *and* spelled-out numbers ("in at most five steps"), treats
  "tasks" ≡ "steps" as one budget, rejects implausible counts (0, >50, four-digit years), and
  only fires `minimal` on curated phrases — *not* on prose that merely says "simple" or
  "minimal viable product". `filesScope` keeps only real path-looking tokens. A false positive
  wrongly shrinks a plan, so every matcher is pinned by a "does NOT fire" test too.
- **#2 roadmap → budget — landed, but shrink-only *and* anti-renumber-preserving (delta).**
  The proposal said `resolvePhase` should "shrink to an explicit cap **at any point**." On
  implementation that would let a mid-build "keep it minimal" *relabel* phases 4→2, which
  collides with Principle 2's just-landed anti-renumber invariant (a build past its first phase
  keeps its labels). Resolution: the explicit ceiling is composed *into* the routed complexity
  **before** the existing recorded-wins / first-phase-resizable logic (`effectiveRouted`), so
  it is honoured on a fresh build yet never renumbers one already in flight. The task cap and
  the quoted scope still tighten a mid-build; only the phase *labels* are protected. Net: a
  fresh `complex` request with explicit scope resolves to the 5-phase `medium` roadmap; a build
  at phase 4 is left labelled as it was.
- **#3 authored phase names — DEFERRED (same reason as Principle 2's #4).** Project-specific
  phase names need names *persisted across turns* in STATE.md, or every turn re-authors a
  different ladder and the roadmap stops being stable — exactly the drift Principle 2 just
  fixed. Kept the deterministic `SMALL/MEDIUM/LARGE_PHASES` names for now; this is a clean,
  separable follow-up, not a silent drop.
- **`phaseCeilingComplexity` floors at `'medium'`, never `'simple'` (delta).** Collapsing to
  the single-node no-LLM `SIMPLE` path erases staged planning entirely — that is a
  *complexity-router* decision about the work's true size, not something a scope phrase should
  trigger. So even the tightest scope ("keep it minimal, 1 step") only demotes a `complex`
  roadmap to `medium` (9→5 phases); the precise step count is then enforced *separately* by the
  planner cap. This keeps "explicit scope shrinks ceremony" from becoming "explicit scope
  disables planning."
- **#4 lean section set — landed.** `sectionsFor(complexity, minimal)` renders only the 12
  actionable sections (→ 9 *authored*, the rest task-derived) when `minimal`, regardless of
  tier; the ceremonial sections (architecture/UX strategy, risks, rollback, next-phase
  prediction) drop, the spine that drives and *verifies* the work (files-to-protect, tasks,
  checklist, completion) always stays.
- **#5 planner clamp — landed.** `buildPlan` gained `maxTasks` → `clampCap` = `min(8,
  maxSteps)` (can only *lower* the runaway guard, never raise it), the planner prompt is told
  "at most N", and the extracted scope is restated to the model as a labelled **HARD
  CONSTRAINTS** block ("…no more than N tasks in total").

Measured, deterministic before/after (probe over the real modules; a `complex` TaskFlow build
vs. the same request + "in at most 5 steps, keep it minimal"):

| Signal | Before (complex) | After (scoped) |
|--------|------------------|----------------|
| Phase count | **9** | **5** |
| Task ceiling (`MAX_TASKS`) | 8 | **5** (`maxSteps`) |
| Authored plan sections | **26** | **9** (lean) |
| `plan.md` size (6 tasks) | **3 795** chars | **1 849** chars (−51%) |
| Scope quoted back in plan | — | ✓ (`verbatim`) |

The scope phrase is extracted (`{ maxSteps: 5, minimal: true }`), the ceiling resolves to
`medium`, and *no* false positive fires on the plain request (`{}`). Verified:
`typecheck:node` ✓, `eslint` ✓ (9 changed files), full suite **1923/1923** ✓ (+33 new tests
across `constraints.test.ts` (new), `planner.test.ts`, `phasePlan.test.ts`, `staging.test.ts`),
incl. the anti-renumber guard ("does not renumber a build already past its first phase") and
the "minimal never reaches simple" floor. Live TaskFlow wall-clock is a Phase 3 measurement;
this subsystem's effect is deterministic and fully captured above.

---

## Principle 2 — Live task-state that survives compaction and is re-read at seams

**Goal.** A persistent plan/task-state that is always in the lead's context and re-grounded
after a fold and at subagent handoff — the model never drifts from what it committed to.

**Reference.** Claude Code keeps the todo list in context across compaction; the plan is
never the thing summarised away.

**Current.** Three artifacts with three lifecycles (authored `plan.md`, derived `TASKS.md`,
authoritative in-memory graph); the continue-nudge reads the *stalest* one (live `plan.md`
boxes, ticked only in the archived copy at phase close); `plan.md` is **not** in the lead's
system prompt and **not** re-read at the compaction seam. (Audit §B, §C.)

**Design.**

1. **One canonical, derived-authoritative task state.** Treat the in-memory graph as the
   single source of truth and render the live checklist from it (reuse `renderTasksDoc`,
   already state-derived). **Move the continue-nudge signal onto this derived doc**, not the
   authored `plan.md` boxes. `plan.md` remains the human-readable *narrative*; the machine
   *progress* signal comes from real state. This removes "checkbox never ticks" and the
   stale-signal exit at once.

2. **Pin task-state into the lead's context.** `buildMessages` gains an always-present,
   bounded **`## Current plan & progress`** block (≤~2k chars) rendered from the canonical
   state + current phase objective. Because it is part of the pinned head (`baseLen`), it
   survives every fold *by construction*.

3. **Re-anchor at the compaction seam.** In `planCompaction` / `compactHistoryWithModel`,
   after folding, re-read the task state from disk/graph and re-inject the pinned block.
   The model-written fold note keeps doing its job (summarising *conversation history*); the
   plan anchor is *re-read*, not summarised — two different jobs, both kept.

4. **Re-anchor at handoff.** `summarizeForAgent` already injects `### Plan`; guarantee it
   reads the *current* `SharedContext.plan` at each dispatch (updated whenever the plan is
   re-authored), so a subagent spawned late in a run gets the current plan, not the opening
   one.

**Invariants preserved.** Context stays bounded — the pinned block is capped and *replaces*
its prior copy rather than accumulating. The model-written fold note stays (right tool for
history). Memory-doc re-read at phase boundaries (an existing strength) is unchanged; we're
adding grounding at the *fold*, where it was missing.

**How we'll know it works.** On a run that triggers ≥1 compaction, a task introduced late is
still executed correctly (probe test). Phase 3 metric: redundant re-derivation after a fold
→ 0; plan fidelity holds on long runs.

**Implemented (Phase 2 · 2026-09-12).** Landed the core — the lead's in-loop persistence —
with two deliberate deltas from the design above:

- **#2 pin + #3 survive-the-fold, via one mechanism.** The lead's `runAgentLoop` captures its
  pristine system message once (`leadSystem`), then every step re-derives
  `outbound[0] = ${leadSystem}\n\n${renderPlanAnchor()}` *before* the fold. Because
  `outbound[0]` is inside the pinned `baseLen` head, the anchor survives every compaction **by
  construction** — so `planCompaction`/`compactHistoryWithModel` were left untouched (lower
  risk than editing the fold path, as the design's #3 had proposed). `renderPlanAnchor` reuses
  `readPlanMd` (same 8 000-char clamp). Gated `agentId == null && intentKind === 'edit'`, so
  it is inert for subagents and non-edit turns.
- **#1 revised — nudge signal left on `readPlanMd`.** The design proposed moving the
  continue-nudge onto derived `TASKS.md`. On inspection the nudge already reads `readPlanMd()`
  — now the *same* source as the anchor and the subagents — so all three agree by
  construction, and the model ticks `plan.md` boxes as it works (the nudge instructs exactly
  that). `TASKS.md` is orchestrator-derived and only rewritten at phase close, so switching to
  it would make the mid-phase signal **staler**, not fresher. Kept as-is.
- **#4 deferred** to the Principle 3 subsystem (subagent handoff), where `summarizeForAgent`
  belongs — not folded into this step.

Verified: `typecheck:node` ✓, `eslint` ✓, full suite **1890/1890** ✓, incl. two new tests —
`engine.test.ts` "pins the live plan … and re-reads it each step" (pin + refresh + non-
accumulation on a live 2-step edit turn) and "keeps the lead plan anchor in the head across a
fold" (divergence #3's exact failure). Live TaskFlow before/after (time, phase count, tool
calls) is a Phase 3 measurement — this change alters neither phase count nor tool routing,
only fidelity-under-compaction, which the two deterministic tests capture.

---

## Principle 3 — Context-efficient subagent handoff (no rediscovery)

**Goal.** A subagent receives the concrete context a prior agent gathered and builds on it;
it does not re-run the prior agent's discovery.

**Reference.** A subagent gets a brief plus the concrete artifacts it needs, returns a
report the parent owns; discovery done once is owned thereafter.

**Current.** The handoff carries *prose* findings (`Finding.detail`, capped 150–600 chars)
and file *paths* (`f.files`) — never file *contents* or line ranges. The editor is *told* to
"prefer the explorer's snippets" but receives only prose, so it re-reads. The read cache
softens disk cost but not the wasted model step, and a worktree-isolated subagent can miss
the cache key. (Audit §D.)

**Design.**

1. **Pass concrete evidence, not just prose.** Extend the blackboard so a reader/explorer
   attaches bounded excerpts keyed by path + line-range + content hash. Illustrative:
   ```ts
   interface Evidence {
     path: string
     range?: [number, number] // 1-based inclusive
     sha: string              // content hash at read time
     excerpt: string          // bounded, e.g. ≤1200 chars
   }
   ```
   `summarizeForAgent` for a `scoped` editor includes the *upstream* nodes' `Evidence`
   verbatim (bounded by `MAX_DIGEST`), so the editor starts with the actual snippet.

2. **Share the read cache by content, across worktrees.** Re-key `readCache` on
   *repo-relative path + sha* (not agent/root), populated by any agent and readable by all.
   An editor in a worktree that needs a file the explorer already read gets a sha-verified
   cache hit instead of a disk+model round-trip. Extend bounded dedup to `list_files` /
   `search_files`.

3. **Structure replaces exhortation.** Replace the roles.ts editor directive's *hope*
   ("prefer the snippets") with *delivery*: the dispatch pre-loads the explorer's `Evidence`
   for the files the editor's task hint names.

**Invariants preserved.** Per-finding detail caps and `MAX_DIGEST` stay (evidence is bounded
and only the relevant upstream set is included for scoped roles). Worktree isolation for
parallel writers stays; sha-keyed sharing is read-only content reuse, safe across worktrees
(stale content can't be served — the sha won't match).

**How we'll know it works.** Phase 3 metric: `read_file` calls the editor issues for files
the explorer already read → ≈0. This is the direct "redundant tool calls" number.

**Implemented (Phase 2 · 2026-09-13).** Landed the two points that make evidence *delivered*,
and deferred the one that would have served a lie:

- **#1 concrete evidence, not just prose.** A new `Evidence` record (`path` + 1-based
  `range` + short content `sha` + ≤1 200-char `excerpt`, `EVIDENCE_EXCERPT_MAX`) is captured
  in `readCache.readEvidence` from every *usable text* read (a listing, a media read, a
  failure, or an empty file yields `null`), de-duplicated per node by path+range
  (`recordEvidence`, newest-wins, capped at 16). The engine threads an `evidence[]` collector
  the same way it threads `filesWritten` — through `AgentLoopArgs` → `executeTool` ctx →
  `runSubagent` → `executeNode` — and the orchestrator hangs it on that node's `Finding`.
  `summarizeForAgent` now renders an **`### Evidence — exact excerpts already read`** block for
  `full` and `scoped` roles (never `minimal` — the reviewer verifies against files itself),
  deduped across findings by path+range and bounded by a `MAX_EVIDENCE_DIGEST` (3 500) sub-cap
  under the existing `MAX_DIGEST` (6 000). The `range` reflects the full span the reader *saw*
  even when the excerpt itself is clipped, so a consumer can still cite exact lines.
- **#3 structure replaces exhortation.** The `roles.ts` editor directive changed from *hope*
  ("prefer the snippets the explorer gave you") to *delivery*: "the explorer's exact excerpts
  … are in your context under 'Evidence' — hash-verified and current; do NOT re-read a file
  whose relevant lines are already there. read_file only for a range the Evidence does not
  cover." The editor is scoped, so it already receives exactly its upstream deps' evidence.
- **#2 deferred (documented).** Re-keying `readCache` on repo-relative path + sha *across*
  worktrees is **not** implemented. The blocker is correctness, not effort: `servedFromReadCache`
  returns a note that says *"its full text is still above in this conversation — scroll up"*.
  That is true only for the agent that actually read the file; subagents already share the
  lead's one cache `Map` (keyed by worktree root), so broadening the key to serve a *different*
  agent that never read the file would hand it a note pointing at a conversation that does not
  contain the text — a lie the model would act on. The token-cost win #2 chased is delivered a
  safer way by #1 (the excerpt travels *as data* in the digest, not as a "look upstairs"
  pointer). Extending dedup to `list_files`/`search_files` is folded into that same deferral.

**Invariants held.** Per-finding detail caps and `MAX_DIGEST` unchanged; evidence rides its own
sub-budget beneath them. Worktree isolation untouched. The `sha` is captured but, given #2's
deferral, currently anchors trust in the excerpt rather than gating a cross-agent cache hit.

Verified: `typecheck:node` ✓, `eslint` ✓ (8 changed files), full suite **1935/1935** ✓ (+12
new tests — 7 in `readCache.test.ts` for `readEvidence`/`recordEvidence` incl. range anchoring,
sha stability, excerpt clamp, the five `null` cases, dedupe and the 16-cap; 5 in
`sharedContext.test.ts` for scoped-gets-excerpts, minimal-does-not, no-evidence-no-section,
cross-finding dedupe, and the bound). The editor-re-read count is a Phase 3 live measurement;
this change alters neither phase count nor plan routing, only what the editor is *handed*.

---

## Principle 4 — Bounded but adaptive verification (keep the caps, catch the "faltu" class)

**Goal.** Keep the existing rework/attempt caps, but stop the failure class where work is
reported "done" without actually meeting its own acceptance criteria.

**Reference.** Bounded rework, plus a real definition-of-done that cannot be satisfied by the
mere *absence* of a red signal.

**Current.** `closePhase.done` passes when `verify.ran === false` (nothing to check);
`review()` fails *open* on provider error/unparseable. Combined with the stale-checkbox exit
(§B), a turn can reach "done" on the absence of red, not the presence of green. (Audit §F.)

**Design — you were explicit: keep `MAX_REWORK = 2` and `MAX_ATTEMPTS = 2`. The caps do not
change. What changes is what "done" is allowed to *claim*.**

1. **A positive green signal is required to claim success.** When `verify.ran === false` and
   files changed, the phase closes as **`built, not verified`** — surfaced honestly to the
   user, never worded as "works" / "verified" / "done". (finalAudit already reports
   unverified builds; push that honesty into the per-phase close and the user-facing
   summary.)

2. **A deterministic acceptance gate independent of the reviewer.** Keep review fail-open for
   the *subjective* verdict (a flaky reviewer must not block genuinely-good work), but add a
   gate that does not depend on the reviewer: if the phase produced files but no verify
   command ran *and* the plan's own `completion`/`checklist` criteria weren't checked, the
   phase is **`needs-verification`**, not `done`. Caps unchanged; "done" now requires
   evidence, and lack of evidence is *surfaced*, not swallowed.

3. **Turn the plan's own criteria into the checklist.** The plan already authors
   `completion` and `checklist` sections. At phase close (edit turns), those become a short
   pass/fail list confirmed by deterministic checks where possible (build / typecheck / test
   / `previewHealth()` for UI) and by the reviewer otherwise — *within the existing review
   budget*, no new unbounded loop.

4. **Use the preview-health signal that already exists.** `previewHealth()` is injected;
   make "the preview reflects current code, not a stale build" a real green signal for UI
   turns (§23).

**Invariants preserved.** `MAX_REWORK = 2`, `MAX_ATTEMPTS = 2` unchanged. Never invent a FAIL
from a provider error (fail-open kept for the subjective verdict). "Not run ≠ passed" kept
and made louder.

**How we'll know it works.** A turn that writes files but runs no check reports "built, not
verified" — never "done". A turn whose output fails its own stated criteria is caught within
the 2 rework rounds or reported as failing. Phase 3: *"whether output passes its own
acceptance criteria"* becomes a measured, reported field.

---

## Principle 5 — Adaptive reasoning effort (per step, not per turn)

**Goal.** Cheap steps run at low effort; hard steps run high — within one turn.

**Reference.** Codex exposes `model_reasoning_effort`; Claude Code varies thinking budget by
step difficulty.

**Current.** `effectiveEffort` is computed once per turn (`complex → max`, else requested)
at engine.ts:1429 and reused for every step and every subagent. (Audit §E.)

**Design.**

1. **Effort becomes a per-call function around the turn's base tier.** The turn still sets a
   base (and its ceiling/floor); each *step/node* resolves its own tier:
   - **Role band** — add `defaultEffort?: ReasoningEffort` to `AgentRoleDef`
     (reviewer/test-runner low; architect/analyst high; builder = base).
   - **Step kind** — a step that only reads/lists/ticks/runs-a-known-command → `low`; a step
     proposing new architecture or a large write → base/raise.
   - **Turn complexity** — sets ceiling and floor: a `complex` turn still *allows* `max` for
     its hard steps (the "don't starve project creation" guarantee is kept), but stops paying
     `max` on trivial steps.
   Illustrative:
   ```ts
   function effortForNode(base: ReasoningEffort, role: AgentRole, hint: StepHint): ReasoningEffort
   // reviewer → min(base,'low'); architect → max(base,'high'); trivial step → 'low'; else base
   ```

2. **Wire at the two call sites:** the per-node dispatch (its loop's `completionOptions`) and
   the lead loop's per-step completion. `spawnContext.effort` becomes a *base*; each subagent
   resolves its own tier from its role band.

**Invariants preserved.** A `complex` turn can still reach `max` for its hard steps (we cap
*trivial* steps, not the whole turn). The gateway rule "never send effort + temperature
together" is unchanged (`completionOptions` already handles it). Effort stays one value *per
call* — just computed per call.

**How we'll know it works.** Measurable token/latency drop on trivial steps within complex
turns, no quality regression on hard steps; reviewer/test-runner observably run low. Phase 3
metric: total time.

**Implemented (Phase 2 · 2026-09-13).** Landed the two bands that are *knowable before a call*
and the flagged effort/roadmap disagreement; deferred the one band that isn't:

- **Role band.** `AgentRoleDef` gains `defaultEffort?: ReasoningEffort`, assigned conservatively:
  `reviewer` and `test-runner` → `low` (static read-and-judge / run-and-report is mechanical),
  `project-analyst` → `high` (studying the whole tree and surfacing risks is deep). Every other
  role — the builder, the lead, the domain specialists — carries **no** band and runs at the
  turn's base. A pure `effortForRole(base, role)` (in `roles.ts`, no engine imports) resolves it:
  a band **below** `medium` is a *ceiling* (`min(base, band)`), a band **above** `medium` is a
  *floor* (`max(base, band)`), no band → `base`. So a review inside a `max` turn runs `low`, the
  analyst on an everyday turn runs `high`, and an un-banded hard step keeps the turn's tier.
- **Wired at both call sites.** The per-step streaming call in `runAgentLoop`
  (`completionOptions(effortForRole(args.spawnContext.effort, args.role))`) now sizes every
  node's steps by the *acting* role — `spawnContext.effort` is the base, exactly as the design
  said. The review verdict does **not** run through a node (it is the orchestrator's `judge`
  callback → the engine's internal `complete()`), so `complete` took an optional effort override
  and `judge` passes `effortForRole(effectiveEffort, 'reviewer')` — the reviewer band reaches the
  non-node path too, not just node dispatch.
- **The flagged interaction, fixed.** `effectiveEffort` used the *raw* `complex → max` rule, so
  "build the login page — keep it minimal" (sized `complex`, but constraint-clamped to a `medium`
  roadmap by the orchestrator) still paid `max` thinking. A pure `effectiveTurnEffort(complexity,
  requested, request)` in `constraints.ts` now sizes the tier from the **same** inputs as the
  roadmap: `complex → max` **unless** `phaseCeilingComplexity(extractConstraints(request))` clamps
  to `medium`, in which case it falls back to the requested tier. Shrink-only — it strips the
  automatic bump, never caps a tier the user dialled by hand (an explicit `high`/`max` survives).
- **Step-kind band deferred (documented).** The design's middle band — "a step that only
  reads/lists/ticks → `low`" — is **not** implemented, and the blocker is structural, not effort:
  the model chooses its next action *during* the streaming call, so the step's kind is unknown at
  the moment `completionOptions` is fixed. Sizing it would need a pre-classification round-trip per
  step (doubling calls to save on some of them) or post-hoc re-runs. The role band already delivers
  the bulk of the win — the two provably-cheap roles (reviewer, test-runner) are exactly the
  "reads/ticks/known-command" steps, now capped `low` — so intra-node step-kind waits for a design
  that doesn't cost a call to save one.

**Invariants held.** A `complex` turn still reaches `max` for its hard, un-banded steps (only the
mechanical roles are pulled down); the gateway's "never send effort + temperature together" rule is
untouched (`completionOptions` still owns it); effort stays one value *per call*, now computed per
call. The "a turn is sized once" contract is **strengthened**: the effort tier and the roadmap are
both derived from `(complexity, constraints)`, so they can no longer disagree.

Verified: `typecheck:node` ✓, `eslint` ✓ (5 changed files), full suite **1945/1945** ✓ (+10 new
tests — 6 in `roles.test.ts` for the bands + `effortForRole` ceiling/floor/base/invariant/unknown,
4 in `constraints.test.ts` for `effectiveTurnEffort`: forces max unconstrained, does-not under a
medium clamp, honours a hand-dialled tier, passes non-complex through). The per-step token/latency
drop is a Phase 3 live measurement; this change alters neither phase count nor plan routing, only
the effort tier each call is issued at.

---

## Principle 6 — Resilient rate-limit handling (exponential backoff + jitter + shaping)

**Goal.** Survive sustained rate limits gracefully: exponential backoff with jitter, honour
the server's `Retry-After`, and shape request rate proactively instead of hammering.

**Reference.** Exponential backoff with jitter; honour `Retry-After`; quota-aware scheduling
so a fleet doesn't retry in lockstep.

**Current.** Flat `RETRY_DELAY_MS = 60_000` × up to 10 (worst case 10 min, lockstep, no
jitter); `Retry-After` never parsed; only a 1.2s global serial `pace()` for shaping.
(Audit §H.)

**Design (resilience.ts).**

1. **Exponential backoff with full jitter.** Replace the flat delay with
   `min(cap, base * 2^attempt)` then full jitter `random(0, computed)` (e.g. base 1s → 2 → 4
   → 8 … cap 60s). Breaks lockstep and makes early attempts fast.

2. **Honour `Retry-After`.** Surface the header at the provider/gateway boundary as
   `retryAfterMs` on the error; when present, `withRetry` waits exactly that (capped) instead
   of the computed backoff.

3. **Token-bucket pacing instead of a flat gate.** Upgrade `pace()` to a token-bucket
   limiter parameterised by an approximate requests-per-minute budget (configurable;
   conservative default), so bursts are shaped *before* a 429 happens. Keep the serialisation
   guarantee behind the streamed-content replay veto.

4. **Independent-jitter herd-breaking for the 3 parallel lanes.** `MAX_PARALLEL = 3`
   specialists that hit a limit back off with *independent* jitter and re-enter through the
   bucket, rather than sleeping in lockstep.

**Invariants preserved.** `MAX_TIMEOUT_RETRY_ATTEMPTS = 2` semantics kept (timeouts ≠ 429s).
The "don't retry after streamed content" veto (`canRetry`) kept. `permanent` (4xx auth)
stays non-retryable. Total attempt budget can stay ~10, but now fast-then-backing-off with a
broken herd.

**How we'll know it works.** Simulated 429 storm: retries jittered (not lockstep),
`Retry-After` honoured, sustained limit shaped by the bucket. Phase 3 metric: total time
under induced rate-limit.

### Implemented (Phase 2 · 2026-09-13)

**What shipped:**

1. **Exponential backoff with full jitter.** `withRetry` now uses `min(cap, base * 2^attempt)` then `random(0, computed)` instead of the flat 60s delay. Base 1s, cap 60s. Early attempts are fast (~500ms avg for attempt 1, ~1s for 2, ~2s for 3, etc.), breaking lockstep across the 3 parallel lanes. The jitter is independent per call (structurally: `Math.random()` is per-invocation, verified in the herd-breaking test).

2. **Honour `Retry-After`.** Providers (gateway.ts, ollama.ts) now read the `Retry-After` header and attach `retryAfterMs` to the thrown error. `withRetry` extracts it via `extractRetryAfter` and waits exactly that duration (capped at 60s) instead of the computed backoff, with no jitter. Handles both delta-seconds (integer) and HTTP-date formats.

3. **Token-bucket pacing.** Replaced the flat 1.2s serial gate with a token-bucket rate limiter. Refills at `DEFAULT_REQUESTS_PER_MINUTE = 30` (one token per 2s); capacity = 30 so a cold start can fire 30 requests immediately, then the refill rate takes over. Bursts are allowed up to capacity, sustained load is shaped proactively. The bucket is disabled under vitest (`requestsPerMinute = Infinity`); `__setRequestsPerMinute` lets tests opt back in.

4. **Independent-jitter herd-breaking.** The 3 parallel lanes (`MAX_PARALLEL = 3` in orchestrator.ts) back off with independent jitter per call and re-enter through the shared token bucket, which serves them fairly in arrival order. No lockstep.

**Changes:**
- `resilience.ts`: replaced `RETRY_DELAY_MS` with `RETRY_DELAY_BASE_MS` and `RETRY_DELAY_CAP_MS`; `withRetry` now computes exponential backoff with full jitter, honours `Retry-After`, and the `RetryOptions` interface gained `delayBaseMs`/`delayCapMs` (replacing `delayMs`). `pace()` is now a token-bucket limiter (replacing the flat `requestGapMs` gate); added `DEFAULT_REQUESTS_PER_MINUTE`, `__setRequestsPerMinute`, and refactored the internal state (`bucketTokens`, `lastRefillAt`). Added `extractRetryAfter` helper.
- `gateway.ts` and `ollama.ts`: added `parseRetryAfter` helper (reads both delta-seconds and HTTP-date) and attach `retryAfterMs` to errors thrown from `!res.ok` paths.
- `resilience.test.ts`: updated tests for the new backoff API (`delayBaseMs`/`delayCapMs`); added 3 new tests: exponential backoff with full jitter, `Retry-After` honour + cap, and independent-jitter herd-breaking. Renamed and updated the `pace` suite for token-bucket semantics.

**Invariants held:** `MAX_TIMEOUT_RETRY_ATTEMPTS = 2` unchanged (timeouts ≠ 429s). `canRetry` veto kept (streaming). `permanent` (4xx auth) non-retryable. Total attempt budget still ~10, now fast-then-backing-off with a broken herd.

**Verification:** `typecheck:node` ✓, `eslint` ✓ (4 changed files), full suite **1948/1948** ✓ (+3 new tests in resilience.test.ts).

---

## Principle 7 — Claude-Code-grade permissions over a real OS-level sandbox

**Goal.** Four permission modes, command classification (read-only / mutating / destructive),
and a **real OS-enforced sandbox** so a raw shell call physically cannot escape the
workspace — "not just tool-level checks that a raw shell call can bypass." **Migrated last
(highest risk).**

**Reference.** Claude Code: four modes (`default` / `acceptEdits` / `plan` /
`bypassPermissions`), per-command allow/deny with prefix analysis, OS sandbox for bash
(`sandbox-exec` on macOS, bubblewrap on Linux). Codex: an approval policy × a sandbox mode
(`read-only` / `workspace-write` / `danger-full-access`) enforced by the OS (Seatbelt on
macOS, Landlock + seccomp on Linux).

**Current.** Three modes (`ask` / `auto-edit` / `autonomous`) + `fullAccess` prompt-waiver;
`run_command` is a single unclassified `kind`; the only "sandbox" is `resolveSafe` path
confinement on *filesystem tools* — `run_command` spawns a real shell (`powershell -Command`
/ `$SHELL -c`, cwd = root, full env) with **no OS confinement**. A raw shell call bypasses
the path sandbox entirely. `permission.ts`'s own comment overstates the guarantee for
commands. (Audit §G.)

**Design.**

1. **Four modes, mapping cleanly onto today's three + the plan checkpoint.**
   - `plan` — read-only exploration; mutation *not permitted* (generalises the current
     one-shot "Plan first" halt into a standing mode).
   - `default` — asks for mutations/commands (≈ `ask`).
   - `acceptEdits` — auto file edits, still asks for commands (≈ `auto-edit`).
   - `bypassPermissions` — auto everything (≈ `autonomous` + the `fullAccess` prompt-waiver),
     **but still inside the sandbox and still behind the browse gates.**

2. **Command classification (read-only / mutating / destructive).** A classifier
   (prefix/lightweight parse, in the spirit of CC's) maps a command line to a class:
   - *read-only*: `ls`, `cat`, `grep`, `git status/diff/log`, `npm ls`, test/typecheck/lint…
   - *mutating*: `mv`, `npm install`, `git commit`, redirects into workspace files…
   - *destructive*: `rm -rf`, `git reset --hard`, `git clean -fdx`, `dd`, disk/format,
     `sudo`, writes outside root…
   Gate by class × mode — read-only auto in more modes; **destructive always asks (even under
   `bypassPermissions`), mirroring the existing browse `delete`-always-asks rule.**

3. **A real OS-level sandbox for `run_command` — the core gap.** Wrap `spawnCommandPty`
   (new `terminal/sandbox.ts`) so the child runs confined, per-OS, with the sandbox mode
   tracking the permission mode:
   - **Windows (primary platform):** a Job Object with limits + a restricted token /
     AppContainer and an ACL scoped to the project root; network denied by default. *(Windows
     has no seccomp/Landlock; Job Objects + restricted tokens + AppContainer are the realistic
     mechanisms, with a WSL/container fallback if native confinement proves insufficient. This
     is the highest-uncertainty item and gets a spike first — see Risks.)*
   - **macOS:** `sandbox-exec` (Seatbelt) confining writes to the workspace + network policy —
     what Codex/CC do.
   - **Linux:** Landlock (fs) + seccomp (syscalls), optionally a namespace — matching Codex.
   - Mode → sandbox: `plan` → read-only FS + no network; `default`/`acceptEdits` →
     workspace-write; `bypassPermissions` → workspace-write (**not** full-disk) unless the
     user explicitly opts into a `danger-full-access` equivalent.
   This makes the audit's finding false *by construction*: even a wrongly-approved `rm -rf ~`
   cannot escape the workspace.

4. **Preserve every existing outside-world gate unchanged.** payment always blocked; delete
   always asks; send asks unless `autoSend`. The OS sandbox is an *added* layer beneath the
   approval layer, never a replacement.

**Invariants preserved (must not regress).**
- Browse: `payment` blocked, `delete` asks, `send` asks unless `autoSend` — unchanged.
- The sandbox is **added, never removed.** `bypassPermissions` waives *prompts*, not
  *confinement*. (This is a deliberate change from today, where `fullAccess` waives the FS
  path gate entirely — see Open Question 1.)
- `read` stays auto.
- If robust OS confinement is unavailable on a platform, the fallback is **fail-safe**:
  commands force-ask + strong classification + deny-list, and the limitation is stated
  honestly — never a claimed sandbox we don't have.

**How we'll know it works.** A destructive command is classified and gated; a command that
tries to write outside root is *blocked by the OS*, demonstrated on Windows with a real
escape attempt that fails. Command classification unit-tested against a corpus.

### Implemented (Phase 2 · 2026-09-14)

**What shipped:**

1. **Four permission modes.** `PermissionMode = 'plan' | 'ask' | 'auto-edit' | 'autonomous'`, and `PermissionOutcome` gained a third value `'block'` (alongside `'auto'`/`'ask'`) so Plan mode can *refuse* a mutation rather than merely ask. Plan mode is read-only exploration: `write_file`/`mcp_call`/`web_fetch`/`web_search` and any mutating/destructive command are blocked; reads and read-only commands are allowed. `fullAccess` does **not** override Plan — confinement to read-only is the whole point of the mode the user chose (a deliberate departure from `fullAccess`'s waive-everything behaviour, and it's tested: *"Plan mode blocks every mutation even with full access on"*).

2. **Command classification (`commandClassifier.ts`, new).** `classifyCommand(line, root)` → `read-only` | `mutating` | `destructive`, prefix-list + destructive-regex, case-insensitive, conservative (anything unrecognised → `mutating`). Destructive corpus covers POSIX (`rm -rf`, `git reset --hard`, `git clean -f`, `dd`, `sudo`, `kill -9`) **and** Windows slash-switch deletes (`rmdir /s`, `rd /s`, `del /s`) since Windows is the primary platform. Redirects are path-checked: inside root → mutating, outside root / up-and-out → destructive. 40+ unit cases across the three classes + edge cases (substring guard, case-insensitivity, redirect boundary).

3. **Classification wired into the matrix (`permission.ts`).** `decideAuto` now takes `commandLine` + `workspaceRoot` and, for `run_command`/`diagnostics`, gates by **class × mode**: destructive **always asks** (blocked in Plan) even under `autonomous`/`fullAccess` — mirroring the browse `delete`-always-asks rule; read-only rides the read path (auto while planning / hands-free / full-access, else ask-once since it still spawns a process); mutating follows the mode. **Classification runs *before* the Plan-mode gate on purpose**, so read-only observation (`ls`, `git log`, `grep`) is allowed while planning — exploration is exactly what Plan mode is for — faithful to Claude Code, whose plan mode permits read-only bash.

4. **A real OS-level sandbox (`terminal/sandbox.ts`, new).** `spawnSandboxedCommand` wraps `spawnCommandPty` and confines the child per-OS, with the sandbox mode tracking the permission mode (`sandboxModeFor`: `plan` → `read-only`, every other mode → `workspace-write`). **macOS:** `sandbox-exec` (Seatbelt) with a generated profile — reads open, writes denied-by-default and re-allowed only under the workspace (+ temp, `/dev/null`). **Linux:** `bwrap` (bubblewrap) — whole FS bound read-only, workspace re-bound read-write. Both builders (`buildSeatbeltProfile`, `buildBwrapArgv`) are pure and unit-tested. Wired at the agent's own `run_command` path (`engine.ts` → `runCommand({ sandbox: { workspaceRoot, mode } })` → `runner.ts`). The sandbox is **added, never removed**: `autonomous`/`fullAccess` waive *prompts*, not *confinement*.

**Two deviations, documented honestly (not silently):**

- **Network is allowed in `workspace-write`, denied only in `read-only`/Plan.** Codex's default `workspace-write` blocks outbound network; Myto's allows it. Rationale: `npm install`, `git push`, `curl` are core to the build loop and breaking them would make the sandbox something users route around. The core protection here is the **write boundary** (side effects can't escape the workspace), not an egress block — and outbound-network *risk* is already gated at the tool layer by the `browse` and `web_fetch` permissions. This is a conscious trade, not an oversight.
- **Windows (the primary platform) has no OS-level confinement yet.** Robust Windows confinement needs a Job Object + restricted token / AppContainer, which requires a **native addon** — deferred to a Phase-2 spike (see Risks). Until it lands, Windows uses the design's documented **fail-safe fallback**: the command still runs, but confinement rests on the classifier + approval prompts (destructive always asks, even hands-free), **not** on the OS. `sandboxAvailable()` returns `false` on Windows and the spawn path emits a one-time honest warning — we never claim a sandbox we don't have. macOS/Linux get real confinement today; Windows is honestly a prompt-gated fallback until the spike.

**Changes:**
- `shared/types.ts`: `PermissionMode` gained `'plan'`; the run carries the selected mode through to the executor.
- `permission.ts`: `PermissionOutcome` gained `'block'`; `decideAuto` reordered (classify → then Plan gate) and given `commandLine`/`workspaceRoot`; Plan-mode block for every non-read op; `decideBrowse` **unchanged**.
- `commandClassifier.ts` **(new)** + `commandClassifier.test.ts` **(new)**.
- `terminal/sandbox.ts` **(new)** + `terminal/sandbox.test.ts` **(new)**; `terminal/runner.ts`: `RunCommandOptions.sandbox` → `spawnSandboxedCommand`.
- `engine.ts`: the agent's `run_command` executor passes `{ sandbox: { workspaceRoot: root, mode } }`. (Hooks and the preview dev-server install intentionally stay unconfined — they are not the agent's arbitrary shell.)
- `permission.test.ts`: added the `plan` rows (read→auto, all mutations→block), a `describe('decideAuto (command classification)')` suite, and the full-access-can't-unblock-Plan test.
- `cli/args.ts`, `ModelSelector.tsx`, `CommandPalette.tsx`: expose `plan` as a selectable mode.

**Invariants held:** browse gates unchanged (`payment` blocked, `delete` asks, `send` asks unless `autoSend`); `read` stays auto in every mode; destructive always asks even hands-free; the sandbox is added beneath the prompt, never a replacement for it; the orchestrator's acyclic engine→orchestrator design is untouched (sandbox lives under `terminal/`, the classifier under `workflow/`).

**Verification:** `typecheck:node` ✓, `typecheck:web` ✓, `eslint` ✓ (changed files clean), full suite **2036/2036** ✓ (+88 tests: `sandbox.test.ts` 12, `commandClassifier.test.ts` 40+, plus the new Plan-mode + classification rows in `permission.test.ts`). *Not yet covered by an automated test:* a real OS escape attempt actually failing (needs macOS/Linux or the Windows native-confinement spike) — that stays a manual/integration check, called out above.

### Windows confinement spike (2026-09-14) — closing deviation #2's uncertainty

The one open item above was deviation #2: Windows, the primary platform, had **no** OS-level confinement, only a documented fail-safe. This spike settles *how* it will get one and lands the **tested integration seam** for it now, without shipping a confinement we can't yet stand behind.

**Findings.**
- **There is no vanilla-Node path to real Windows confinement.** Unlike macOS (`sandbox-exec`) and Linux (`bwrap`), Windows has no ship-with-the-OS launcher that a Node `spawn` can wrap. The realistic mechanisms — **AppContainer** (capability-based, the gold standard since Win8), a **restricted/lowbox token**, Job Objects (resource limits only — *no* filesystem confinement on their own), Low Integrity Level — all require native Win32 calls (`CreateProcessAsUser` / `CreateAppContainerProfile` / `UpdateProcThreadAttribute`). So confinement needs a small **native helper binary** bundled with the app.
- **The helper fits the existing external-launcher architecture exactly.** `sandbox.ts` already wraps the command with an out-of-process confiner on every platform (macOS→`sandbox-exec`, Linux→`bwrap`). Windows is symmetric: wrap with **`myto-confine.exe`**. No architectural change — just a third branch.
- **The native-toolchain cost is already paid.** `@lydell/node-pty` is a native N-API addon already built and bundled by electron-builder (its prebuilds ship in `win-unpacked/resources/…`), so adding one more small native binary to `extraResources` is a known, low-risk pipeline step — not new ground.
- **A container/WSL fallback is *not* needed as the primary answer** (it was floated in Risks). AppContainer gives per-process filesystem confinement natively, at far lower UX cost than requiring WSL; WSL/container stays a distant backstop only if AppContainer proves insufficient for some command class.

**What landed now (the seam, tested — not the confinement):**
- `buildWindowsConfineArgv(helperPath, workspaceRoot, mode, command)` — a **pure, unit-tested** argv builder. The inner command is passed **base64** (`--command-b64`) so no PowerShell/`cmd` quoting of it is ever needed (the win32 pty runs `powershell.exe -Command <command>`); round-trip through quotes/newlines is tested.
- A `win32` branch in `spawnSandboxedCommand` that invokes the helper via a PowerShell call line **iff** the helper binary is present, and otherwise takes the **unchanged** honest fail-safe (classifier + prompts + one-time warning).
- `sandboxAvailable()` on win32 returns whether the helper is bundled, via an injectable, memoized probe (`windowsConfineHelperPath`, mirroring the `bwrap` probe). **The helper does not exist yet, so this stays `false` today** and Windows behaviour is byte-for-byte what it was — *zero regression*, and no false claim of a sandbox.

**Helper CLI contract (for the native implementation):**
```
myto-confine.exe --workspace <dir> --mode <read-only|workspace-write> --command-b64 <base64>
```
It creates/opens a per-app AppContainer profile, grants read broadly + write only under `<dir>` (+ temp) in `workspace-write` (read-only denies write and network), base64-decodes the command, and runs it inside the container — the same read-open / write-confined shape as the Seatbelt profile and the bwrap bind set.

**Still owed before Windows confinement is real (the implementation phase, not this spike):** build `myto-confine.exe` (a ~single-file native helper) and add it to electron-builder `extraResources`; then the one manual/integration check that stays outstanding on *every* platform — a real `rm`/`del` outside-root escape attempt that the OS actually blocks — becomes runnable on Windows too. Until that binary ships, `sandboxAvailable()` is honest that Windows confinement is prompt-gated, not OS-enforced.

**Seam verification:** `typecheck:node` ✓, `typecheck:web` ✓, `eslint .` ✓ (0 errors), full suite **2041/2041** ✓ (+5: three `buildWindowsConfineArgv` cases + Windows helper-present / memoization availability cases in `sandbox.test.ts`, now 17). No production behaviour changes on any platform today — the seam is dormant until the helper binary exists.

---

## Cross-cutting: modules touched (map for Phase 2)

| Principle | New / changed | Nature of change |
|-----------|---------------|------------------|
| 1 | `orchestrator/constraints.ts` **(new)** | Parse `PlanConstraints` |
| 1 | `orchestrator/phasePlan.ts` | Roadmap → budget; authored phase names; `minimal` lean section set |
| 1 | `orchestrator/planner.ts` | `MAX_TASKS = min(8, maxSteps)` |
| 1,4 | `orchestrator/staging.ts` | `resolvePhase` honours explicit cap; `closePhase` → `built,not verified` / `needs-verification`; done requires green |
| 2 | `engine.ts` | Pin `## Current plan & progress`; re-anchor at compaction; nudge reads derived state |
| 2 | `engine.ts` (`planCompaction`) | Re-read + re-inject plan block post-fold |
| 3 | `orchestrator/sharedContext.ts` | `Evidence` records; include upstream evidence for scoped roles |
| 3 | `readCache.ts` | Key by (repo-relative path, sha); shared across worktrees; dedup list/search |
| 3 | `orchestrator/roles.ts` | Editor pre-loaded with upstream evidence (replaces exhortation) |
| 5 | `orchestrator/roles.ts` | `defaultEffort` band per role |
| 5 | `engine.ts` | `effortForNode` at the two call sites (base becomes ceiling/floor) |
| 6 | `resilience.ts` | Exponential + full jitter; `Retry-After`; token-bucket `pace()` |
| 6 | provider/gateway boundary | Surface `retryAfterMs` on 429 |
| 7 | `permission.ts` | Four modes; command classifier gating |
| 7 | `terminal/sandbox.ts` **(new)** + `terminal/pty.ts` | OS-level confinement wrapping `spawnCommandPty` |

The orchestrator's dependency-injected, acyclic design (engine → orchestrator only) is
preserved throughout — new behaviour arrives as new callbacks / deps, not new imports.

---

## Migration plan (Phase 2) — your order, each verified before the next

Exactly the sequence you specified, lowest-risk first, each landed and verified against the
TaskFlow benchmark before the next begins:

1. **Task-state / plan persistence (Principle 2).** Foundational and low-risk; makes every
   later change observable (a stable, in-context plan to measure against). — **done ✓**
2. **Dynamic planning + constraints (Principle 1).** — **done ✓**
3. **Subagent context handoff (Principle 3).** — **done ✓**
4. **Adaptive reasoning effort (Principle 5).** — **done ✓**
5. **Rate-limit handling (Principle 6).** — **done ✓**
6. **Permission / sandbox layer (Principle 7)** — last, highest risk. Landed: four modes,
   command classification, and OS-level confinement (Seatbelt/bwrap on macOS/Linux; honest
   classifier+prompt fail-safe on Windows pending the native-confinement spike). — **done ✓**

Per your Phase 3 discipline, **every** migrated subsystem is regression-checked against the
TaskFlow app-spec benchmark, reporting before/after: **total time, phase count generated,
redundant tool calls, and whether the output passes its own acceptance criteria** — reported
*at every step, not just at the end*, and I stop for your go-ahead between subsystems.

---

## Risk register & rollback

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Windows OS sandbox (no seccomp/Landlock) is hard to do robustly | High → **resolved (approach)** | **Spike done 2026-09-14:** AppContainer via a bundled native `myto-confine.exe` helper is the answer (symmetric with the mac/linux launchers; native toolchain already paid by node-pty). Tested integration seam landed; `sandboxAvailable()` stays honest `false` on Windows until the helper binary ships. WSL/container demoted to a distant backstop, not the plan. |
| Pinning the plan block grows every request | Low | Bounded (~2k), *replaces* prior copy; measured against the context meter |
| Cross-worktree cache serves stale content | Low | sha-verified: a mismatch simply misses the cache |
| Backoff/token-bucket interacts with the streaming replay veto | Medium | Keep `canRetry` veto intact; bucket sits *before* the call, veto *after* stream start |
| "needs-verification" state ripples into UI/report copy | Medium | Land Principle 2 first (stable state), thread the new state through the existing honest-completion path |

**Rollback posture.** Each subsystem is independent and lands behind its own seam; reverting
one migration does not touch the others. No migration removes an existing safety gate.

---

## Safety invariants — carried untouched through all seven

- **Myto never spends the user's money.** `payment` stays hard-blocked in every mode.
- **`delete` always asks; `send` asks unless `autoSend`.** Unchanged; and the new command
  classifier applies the same philosophy to destructive shell commands (always ask).
- **Verification caps stay:** `MAX_REWORK = 2`, `MAX_ATTEMPTS = 2`. We add a *green-signal
  requirement*, not more loops.
- **The sandbox is only ever *added*.** No mode, including `bypassPermissions`, waives
  *confinement* — only prompts. (Open Question 1 decides fullAccess's fate.)

---

## Open questions for your review

These are genuine forks I want your call on before Phase 2 (they change the security model):

1. **fullAccess vs bypassPermissions.** Fold today's `fullAccess` into `bypassPermissions`
   (prompts waived, confinement kept), or keep `fullAccess` as an orthogonal super-flag that
   *also* waives the FS path gate? *My recommendation: fold it in and keep confinement even
   under bypass — a waived prompt should not mean a waived sandbox.*
2. **Destructive commands under `bypassPermissions`.** Still ask (mirroring
   delete-always-asks), or run? *My recommendation: still ask.*
3. **Sandbox network policy.** Deny by default and gate egress (matches offline-first + the
   existing `web_fetch` gating), or allow in workspace-write modes? *My recommendation: deny
   by default, gated.*
4. **Windows sandbox depth.** Is a WSL/container fallback acceptable if native
   Job-Object/AppContainer confinement proves insufficient in the Phase 2 spike?
   *(Spike done 2026-09-14: AppContainer via a bundled `myto-confine.exe` helper is the
   plan; WSL/container is only a distant backstop. The seam is wired + tested; building the
   native helper binary is the remaining implementation step.)*

---

*End of Phase 1 design proposal. Awaiting your approval — and your answers to the four open
questions — before Phase 2 (incremental migration, task-state/plan persistence first). No
working code will be touched until this document is approved.*
