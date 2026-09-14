# Sylor Agent Architecture — Audit (Phase 0)

**Status:** read-only audit. No code has been changed. This document is the Phase 0
deliverable and the gate for Phase 1.

**Scope:** the core agent loop and orchestration in `app/src/main/workflow/` —
planning, todo/task tracking, compaction, subagent spawning, verification,
permissions/sandbox, and retry/backoff.

**Method:** every claim below is grounded in the source as it stands today. Files read
in full or in the relevant part: `engine.ts` (5172 lines), `orchestrator/orchestrator.ts`,
`orchestrator/complexity.ts`, `orchestrator/planner.ts`, `orchestrator/phasePlan.ts`,
`orchestrator/staging.ts`, `orchestrator/roles.ts`, `orchestrator/sharedContext.ts`,
`orchestrator/capabilities.ts` (via grep), `permission.ts`, `resilience.ts`,
`reasoning.ts`, `fs/operations.ts`, `terminal/runner.ts`, `terminal/pty.ts`.

**How to read this:** each subsystem has three parts — **What it does today** (grounded
in code), **The reference behaviour** (how Claude Code / Codex actually work), and **Where
Sylor diverges** (with a severity and the practical consequence). This document does *not*
propose fixes — that is Phase 1 (`design-proposal.md`). Where one of your five pre-named
divergences is confirmed, softened, or partially corrected, I say so plainly rather than
rubber-stamping it; an audit that only agrees is not an audit.

---

## 0. The reference model, in one paragraph

Claude Code and Codex share a small set of design commitments that Sylor's core was
built before fully absorbing:

- **Plans are data, sized to the task.** A live, model-owned list of concrete steps
  (`TodoWrite` in Claude Code, `update_plan` in Codex), rewritten as work proceeds,
  as long or short as the actual decomposition — and directly responsive to a user
  instruction like "keep it to 5 steps." There is no fixed phase ladder or fixed
  section template.
- **The plan is always in context.** It is not summarised away by compaction; it is
  re-grounded so the model never drifts from what it committed to.
- **Effort scales with the step.** Reasoning budget is a dial (Codex's
  `model_reasoning_effort`; Claude Code's thinking budget) that can differ between a
  trivial step and a hard one.
- **Subagents receive context, they don't rediscover it.** A spawned agent is handed a
  brief and returns a report; the parent keeps the report and does not re-run the
  child's discovery.
- **Permissions are a real matrix over a real sandbox.** Four modes
  (`default` / `acceptEdits` / `plan` / `bypassPermissions` in Claude Code; Codex's
  approval policy × sandbox mode), command classification, and an **OS-enforced**
  sandbox (Seatbelt/`sandbox-exec` on macOS, Landlock+seccomp on Linux) so a shell
  command physically cannot escape the workspace even if a check is wrong.
- **Backoff is exponential with jitter and honours `Retry-After`.**

Sylor already has a great deal of machinery — a model-first complexity router, a
capability-based role registry, a shared-context blackboard, worktree isolation,
project-memory documents, hooks, checkpoints. The divergences below are about *how
specific subsystems behave*, not about missing features.

### Divergence summary

| # | Subsystem | Your pre-named claim | Verdict | Severity |
|---|-----------|----------------------|---------|----------|
| 1 | Planning | Hardcoded ~9-phase template regardless of complexity / ignores "max 5 steps" | **Confirmed on the template + explicit-constraint half; corrected on "regardless of complexity"** (it *is* complexity-scaled 3/5/9) | High |
| 2 | Subagent handoff | Subagents redo discovery a prior agent did | **Confirmed, with nuance** (a handoff exists, but it carries lossy prose, not the concrete artifacts) | Medium-High |
| 3 | Compaction | plan.md not re-read after a fold; lead trusts its own recap | **Confirmed** for intra-loop compaction (memory docs *are* re-read at phase seams) | High |
| 4 | Reasoning effort | Fixed rather than scaled to step complexity | **Confirmed** (computed once per turn, reused every step) | Medium |
| 5 | Rate-limit backoff | Up to 10×60s sequential, no batching | **Confirmed** (flat 60s × 10, no exponential, no jitter, ignores `Retry-After`) | Medium-High |
| — | Permissions/sandbox | (Phase 1 principle) | **Confirmed gap**: 3 modes not 4, no command classification, **no OS-level sandbox** | High (security) |
| — | Verification | (Phase 1 principle: keep caps, catch the failure class) | Characterised below — the "fail-open" review gate is the likely locus | Medium |

---

## A. Complexity routing & planning

### What it does today

Two artifacts are produced from one complexity classification:

1. **Complexity routing** — `orchestrator/complexity.ts`. `classifyComplexity` is
   **model-first**: it asks the model to bucket the request as `simple` / `medium` /
   `complex` (`ROUTER_SYSTEM` even spells out the *costs* of "complex": a 20-section
   spec, a 9-phase roadmap, a 29-section plan). `classifyComplexityHeuristic` / `route()`
   is a keyword fallback only, keyed on signals like domains / breadth / deliverables /
   surfaces / products.

2. **Roadmap** — `orchestrator/phasePlan.ts`. Three **hardcoded literal arrays**:
   `SMALL_PHASES` (3), `MEDIUM_PHASES` (5), `LARGE_PHASES` (9). `phaseRoadmap(complexity)`
   picks one. Phase names and objectives are fixed strings ("Discovery and foundation",
   "Design system and shell", …).

3. **Plan document** — same file. `PLAN_SECTIONS` is a fixed registry of **29 section
   specs**, each with a `min` complexity; `sectionsFor` renders **15 / 24 / 29** sections
   by complexity. The judgement sections are authored by one model call
   (`authorPhasePlan` in `staging.ts`); the rest are derived or rendered as explicit
   "to be determined" placeholders.

4. **Task graph** — `orchestrator/planner.ts`. `SIMPLE` collapses to a single generalist
   node with **no LLM call**. `MEDIUM`/`COMPLEX` spend **one** completion → `normalizeTasks`
   → validated `TaskGraph`, capped at `MAX_TASKS = 8`, malformed output → single node.

The recorded complexity is persisted in `STATE.md` and, per `resolvePhase`
(`staging.ts:111`), can only **shrink** and only before phase 2 — a deliberate fix for a
past bug where one bad "login page = 2 domains = 9 phases" route poisoned a project for
its whole life.

### The reference behaviour

Claude Code's `TodoWrite` and Codex's `update_plan` produce a list whose **length and
content are the task decomposition itself** — three items for a three-item job, and
directly shaped by explicit user scope instructions. There is no fixed 3/5/9 ladder and
no 29-section document template. Plan ceremony is proportional to the *actual* work, not
to a bucket the work was sorted into.

### Where Sylor diverges

- **The roadmap is a template, not a plan (High).** Even though it is complexity-*scaled*,
  within a bucket the phases are fixed strings. A `complex` build always gets the same 9
  phase names in the same order whether it is a SaaS dashboard or a CLI tool. The plan
  describes a *shape of project*, not *this* project's decomposition.
- **No path honours an explicit user constraint (High).** This is the sharpest point of
  your claim, and it is confirmed. Nothing in `complexity.ts`, `phasePlan.ts`, or
  `planner.ts` parses or respects "in at most 5 steps", "keep it minimal", "don't
  over-engineer", or "one file only". The router only emits `simple|medium|complex`; the
  roadmap and section count follow mechanically. A request that says "max 5 steps" can
  still be routed `complex` → 9 phases, 29 plan sections, up to 8 tasks — none of it
  bound to "5". The user's own words never reach the sizing decision.
- **Correction to the claim's wording.** It is *not* accurate that planning is "a
  hardcoded ~9-phase template regardless of task complexity." The 9-phase roadmap is used
  only for `complex`; `simple`→3 and `medium`→5, and `simple` skips the plan document and
  the LLM entirely. The real defect is (a) fixed *templates within each bucket* and (b)
  *no explicit-constraint override* — not indifference to complexity.

**Consequence:** the plan reads as ceremony rather than a task list, and a user asking for
restraint cannot get it — the exact "9 phases for a login page" class of complaint the
codebase has already fought once (see `resolvePhase`'s own comment).

---

## B. Todo / task-state tracking & plan persistence

### What it does today

There are **two** tracking artifacts with **different lifecycles**, plus in-memory graph
state:

1. **`plan.md`** — written once per phase. The `MEDIUM/COMPLEX` renderer
   (`phasePlan.ts renderTasks`) and the `SIMPLE` renderer (`planner.ts
   renderPlanMarkdown`) both emit `- [ ]` checkboxes. These live boxes are **flipped to
   `- [x]` only in the *archived copy*** at phase close (`MemoryPort.archivePlan`, called
   from `closePhase` in `staging.ts`). During execution the live `plan.md` boxes stay
   unchecked unless a `builder`/`editor` subagent happens to tick them (their role
   directives in `roles.ts` tell them to, but nothing enforces it).

2. **`TASKS.md`** — re-rendered deterministically from the **real** task-node states each
   close (`renderTasksDoc` in `staging.ts`: `[x]` done, `[~]` running, `[!]` blocked/failed,
   `[ ]` pending). This is the honest, drift-free checklist.

3. **In-memory `TaskGraph`** — the actual source of truth during a run; node `state`
   drives scheduling and the roll-ups.

The engine's **continue-nudge** keys on an unchecked box in the *live* `plan.md`
(`readPlanMd()` + a `/- \[ \]/` test): an unchecked box means "work remains, keep going."

### The reference behaviour

Claude Code keeps **one** live todo list, model-owned, rewritten in place as items move
`pending → in_progress → completed`, and always visible. There is one source of truth and
the model is responsible for keeping it current.

### Where Sylor diverges

- **The signal the engine trusts is the least accurate one (Medium-High).** The
  continue-nudge reads live `plan.md` boxes — but those boxes are the ones that are *not*
  reliably updated during execution (they flip in the archived copy at close, or only if
  a subagent volunteers). `TASKS.md`, which *is* derived from real state, is not what the
  nudge reads. So "are we done?" is answered from the stalest of the three artifacts.
- **Three artifacts, three lifecycles, no single owner (Medium).** `plan.md` (authored),
  `TASKS.md` (derived), and the in-memory graph (authoritative) can legitimately disagree
  at any instant. This is the opposite of the single-list model, and it is why "checkbox
  never ticks" and "plan says pending but it's done" are both possible.

**Consequence:** progress tracking is duplicated and can drift; the loop-termination
heuristic reads a field that is often stale.

---

## C. Context compaction

### What it does today

`engine.ts` — `measureContext` / `planCompaction` / `compactHistory` /
`compactHistoryWithModel`. `planCompaction` is the single shared boundary. It preserves a
**pinned head** (`messages.slice(0, baseLen)` = system prompt + prologue + original
request, never folded) and a **recent tail** (`RECENT_KEEP_CHARS`), and folds the OLD
middle into a **model-written note** (`summarizeFoldedWithModel`, which itself runs at
`completionOptions('low')`), with a deterministic note as the offline fallback.

Crucially: **`plan.md` is not part of the pinned head.** `buildMessages` assembles the
lead's system prompt from `SYSTEM_PROMPT` + directives + user profile + `projectPreamble`
(DB instructions/knowledge/memory) + `overview` (the read-only *file* overview). It does
**not** inject `plan.md`. `readPlanMd()` is called only to (a) seed a subagent's prompt
and (b) power the continue-nudge regex — **never to re-inject fresh plan text into the
lead after a fold.**

At **phase boundaries**, by contrast, project memory *is* re-read from disk: `memoryDigest`
and `planningBrief` (`staging.ts`) rebuild the next plan from `STATE.md` / `PROJECT.md` /
`ARCHITECTURE.md` / `FILEMAP.md`. So there is a real anti-drift mechanism — but it fires
between phases, not at the compaction seam inside a phase.

### The reference behaviour

Claude Code's compaction preserves the todo list and key working state across a summary;
the plan is never the thing that gets summarised away.

### Where Sylor diverges

- **plan.md / task-state is not re-anchored at the fold (High).** Confirmed. Inside a
  long agent loop, when compaction fires, the lead's memory of the plan is whatever
  survives in the pinned head (which does not contain plan.md) plus the model's own prose
  fold-note plus the recent tail. On a long run the executable plan can drift from
  `plan.md` on disk, because nothing re-reads it at the seam.
- **Nuance worth keeping.** Your claim is precisely true for *intra-phase* compaction.
  It is *not* the whole story: at phase transitions Sylor re-grounds from disk-backed
  memory docs, which is a genuine strength and the right instinct — it just isn't applied
  at the point where the model's context is actually being lossily rewritten.
- **The fold note is authored at `low` effort.** The summary that the lead will trust for
  the rest of the run is produced by the cheapest reasoning tier — reasonable for cost,
  but it means the one artifact standing in for a large slice of history is also the least
  deliberated.

**Consequence:** plan fidelity degrades on long runs exactly as you described; the
re-grounding that exists is scoped to phase boundaries, not to compaction events.

---

## D. Subagent spawning & context handoff

### What it does today

`runSubagent` (`engine.ts`) spawns a fresh `agentId`, builds a scoped system prompt via
`buildSubagentSystem`, runs a bounded loop (`SUBAGENT_MAX_STEPS`, `allowSpawn:false` so
nesting depth is 1), scopes tools by the role's `capabilities`, optionally isolates it in
a git worktree, and truncates its report to `reportWordBudget(role)` words.

Context **is** handed down. `buildSubagentSystem` injects: base prompt + shell/mcp/skills
directives + `effortDirective` + role directive + user profile + project preamble +
overview + a conversation recap + **`## Current plan.md`** + **`## What the team has
established so far`** (the shared-context digest) with the explicit instruction *"Build on
this instead of rediscovering it. Do not redo work already reported here."*

The digest comes from `SharedContext.summarizeForAgent(node)` (`sharedContext.ts`), scoped
by the role's `contextScope`:
- `full` (lead/analyst/integration/explorer) → plan + all findings,
- `scoped` (most specialists) → plan + only transitive-upstream deps' findings,
- `minimal` (reviewer/test-runner) → plan + a compact execution roll-up.

`MAX_DETAIL = 600` chars per finding (`explorer` raises its own to `detailChars: 1800`);
`MAX_DIGEST = 6000`. Roles carry word budgets (`explorer` 350, `editor` 150, reviewer 200,
test-runner 120…). There is also a **run-wide read cache** (`servedFromReadCache`) that
short-circuits a repeat `read_file` of an unchanged path with the cached text and no disk
hit.

### The reference behaviour

A subagent is handed a brief and the concrete context it needs, does its slice, and
returns a report the parent keeps. The parent (and siblings) do not re-derive the
subagent's findings; discovery done once is *owned* thereafter.

### Where Sylor diverges

- **The handoff carries lossy prose, not the concrete artifacts (Medium-High).**
  Confirmed with nuance. The mechanism exists and is thoughtful — but what flows between
  specialists is a role's **report / findings** (prose, capped at 150–600 chars), not the
  file *contents*, line ranges, or read results the prior agent actually gathered. An
  `explorer` that reads five files hands the `editor` a ≤350-word map; the editor, needing
  the real code, re-issues `read_file`. The `editor` directive even says "prefer the
  snippets the explorer gave you over re-reading whole files" — an instruction that only
  exists *because* re-reading is the default temptation.
- **The read cache softens the cost but doesn't remove the round-trip (Medium).** A
  re-read is served from cache (no disk hit), so this is cheaper than it looks — but it
  still costs a model step and tokens to decide to re-read, and a **worktree-isolated**
  subagent runs under a different root, so its reads may not hit the same cache keys at
  all. Discovery tools (`list_files` / `search_files`) are not deduped the way `read_file`
  is.

**Consequence:** the "don't rediscover" instruction is doing work that structure should
do. Specialist→specialist handoff loses the very artifacts (contents, line numbers) that
would let a downstream agent skip re-derivation, so it re-derives them.

---

## E. Adaptive reasoning effort

### What it does today

Effort is computed **once per turn** and reused for every step. `effectiveEffort`
(`engine.ts` ~1429): `turnComplexity === 'complex' ? 'max' : requestedEffort`. Every loop
iteration then calls `completionOptions(spawnContext.effort)`, which maps effort → API
params: `temperature` (low 0.3 / medium 0.5 / high|max 0.7), `reasoningEffort`, and
`maxTokens` (only raised to `MAX_OUTPUT_TOKENS` 32k at `max`). Subagents inherit the
parent's effort via `effortDirective(ctx.effort)`.

So effort *is* wired to the real API (this is genuine, not cosmetic), and it *is* a
function of turn complexity — but it is a single per-turn constant.

### The reference behaviour

Reasoning budget is a per-step dial. A cheap step (read a file, tick a box, run a known
command) should not burn max reasoning; a hard step (architecting a module, diagnosing a
subtle bug) should. Codex exposes `model_reasoning_effort`; Claude Code varies thinking
budget.

### Where Sylor diverges

- **Fixed per turn, not scaled per step (Medium).** Confirmed. A `complex` turn runs
  *every* step at `max` — including the trivial ones — and a `simple`/`medium` turn runs
  every step at the requested tier, including the genuinely hard one buried in it. There
  is no per-node or per-step effort selection, and subagents cannot be dialled
  independently of the turn.

**Consequence:** effort is spent by the *turn's* size, not the *step's* difficulty —
overspending on trivial steps in big turns, underspending on the hard step in small ones.

---

## F. Verification

### What it does today

Two layers:

1. **Post-write static check** — after a `write_file`, `verifyWrittenFile`
   (`fs/verify.ts`) runs and its issues are folded into the tool result;
   `summarizeResults` (`engine.ts`) sets a `broken` flag and injects a hard instruction:
   *"One or more files you just wrote are broken as written. Fix them now… Do not give
   your final answer while a detected problem remains."*
2. **Project verification** — `verifyProject` runs the `diagnostics` tool
   (typecheck/lint via the project's own checkers) then npm scripts
   (`VERIFY_SCRIPTS = ['typecheck','lint','build','test']`), fails fast, and is careful to
   distinguish "not run" from "failed" (a project where nothing could be checked is
   `ok:false`, never reported as clean).

3. **Review gate** — `orchestrator.review()` runs a `reviewer` subagent. Critically it
   **fails open**: on a provider error or unparseable review it does **not** invent a
   `FAIL`; it trusts the deterministic hard-failure signals (a failed build/verify) and
   lets the work through. `MAX_REWORK = 2`, `MAX_ATTEMPTS = 2`.

### The reference behaviour (and your Phase 1 principle)

Bounded but adaptive: **keep the caps** (you were explicit — "don't remove the caps"),
but catch the specific failure class that has produced "faltu results" — work reported as
done that isn't.

### Where Sylor diverges / what to examine

- **The fail-open review is the likely locus of "faltu results" (Medium).** It is the
  *right* default in spirit (a flaky reviewer shouldn't block a genuinely-good change),
  but combined with (a) the stale-checkbox termination signal from §B and (b) a
  `verifyProject` that can legitimately report "nothing to check" on a project without
  scripts, there is a path where a turn ends "successful" with **no positive proof** —
  the reviewer errored (open), the checklist box was never ticked (so the nudge sees
  "work remains" but the loop has other exit conditions), and no build/test actually ran.
  The caps are not the problem; the problem is that "done" can be reached without a
  green signal, only the *absence* of a red one.

**Consequence:** verification is well-instrumented but its *composition* allows a
"no news is good news" exit. Phase 1's job (per your brief) is to catch that class while
keeping the 2× rework / 2× attempt caps intact.

---

## G. Permissions & sandbox  *(security-critical)*

### What it does today

**Permission decision** — `permission.ts`. `decideAuto(mode, kind, fullAccess)` has
**three** modes: `ask` (everything asks except read), `auto-edit` (writes auto, commands
ask), `autonomous` (everything auto). `read` and `preview_inspect` are always auto.
`fullAccess` (opt-in "Full-PC access") auto-approves *all* side effects regardless of
mode. `diagnostics` is deliberately gated as a command (it executes repo JS). Browse has
its own gate `decideBrowse`: **`payment` always blocked, `delete` always asks, `send` asks
unless `autoSend`** — these three survive every mode and full access, and must be
preserved.

**Filesystem confinement** — `fs/operations.ts`. `resolveSafe` enforces a two-gate
sandbox (lexical `..`/absolute check + physical `realpath` symlink check) so every
`write_file`/`read_file`/`list_files` stays under the project root — **unless
`fullAccessEnabled()`, which returns the path unchecked** (any location on disk).

**Command execution** — `terminal/runner.ts` → `terminal/pty.ts`. `spawnCommandPty`
spawns the **real system shell**: on Windows `powershell.exe -NoLogo -NoProfile -Command
<command>`, elsewhere `$SHELL -c <command>`, with `cwd = contextManager.getRoot()` and
`env = process.env` (the user's full environment).

### The reference behaviour

- Claude Code: **four** modes (`default`, `acceptEdits`, `plan`, `bypassPermissions`),
  per-command allow/deny rules with prefix analysis, and an **OS-level sandbox** for bash
  (`sandbox-exec` on macOS, bubblewrap on Linux) plus filesystem/network restrictions.
- Codex: an **approval policy** (`untrusted` / `on-failure` / `on-request` / `never`)
  *crossed with* a **sandbox mode** (`read-only` / `workspace-write` /
  `danger-full-access`) enforced by the OS (Seatbelt/`sandbox-exec` on macOS,
  Landlock + seccomp on Linux). The sandbox is the backstop: even a wrongly-approved
  command physically cannot write outside the workspace or reach the network.

### Where Sylor diverges

- **No OS-level sandbox for commands — this is the core of your stated concern, and it is
  confirmed (High).** `run_command` is **approval-gated but not confined**. The
  `resolveSafe` sandbox is a *tool-level* check that operates on the *arguments* of the
  filesystem tools; a raw shell command never passes through it. `cd /`, absolute paths,
  `..`, `curl … | sh`, `cat ~/.ssh/id_rsa`, `rm -rf ~` all run with the user's full
  privileges and full environment, bounded only by (1) the approval prompt and (2) any
  optional PreToolUse hook. The `cwd = project root` is a convenience, not a boundary.
  This is precisely "tool-level checks that a raw shell call can bypass."
- **A doc/behaviour mismatch to flag honestly.** `permission.ts`'s own comment states
  *"every write/command stays sandbox-scoped — silent or unsandboxed side effects are
  never allowed."* That is true for **writes** (`resolveSafe`) but **not** for
  **commands** — a command is approval-gated, not sandbox-scoped. The comment overstates
  the guarantee.
- **Three modes, not four; no `plan` permission mode (High).** Sylor has a "Plan first"
  *approval checkpoint* in the orchestrator (`PlanProposal`/`approvePlan`), which is a
  one-shot halt, not a standing mode that permits exploration while forbidding all
  mutation. There is no `acceptEdits`-vs-`bypassPermissions` distinction beyond
  `auto-edit`/`autonomous` + the separate `fullAccess` flag.
- **No command classification (High).** `run_command` is a single `kind`. There is no
  read-only (`ls`/`cat`/`grep`) vs mutating (`mv`/`npm install`) vs destructive
  (`rm -rf`/`git reset --hard`) distinction. In `autonomous`/`fullAccess`, a destructive
  command auto-runs with only a hook as optional defence; in `ask`/`auto-edit`, a harmless
  `ls` prompts exactly as loudly as `rm -rf`.

**Consequence:** this is the highest-risk gap. The safety that exists is real for the
filesystem tools and for browse (payment/delete/send), but the shell — the most powerful
tool — has *approval* as its only gate and *no* enforced blast radius. Your Phase 1
requirement of "a real OS-level sandbox" is therefore not a refinement; it is a missing
layer.

---

## H. Rate-limit / retry / backoff

### What it does today

`resilience.ts`. Two concerns:

- **Pacing** — `pace()` serializes all outbound model calls through a promise chain with a
  `MIN_REQUEST_GAP_MS = 1200` minimum gap, so parallel specialists (`MAX_PARALLEL = 3`)
  trickle rather than burst. (Zeroed under Vitest.)
- **Retry** — `withRetry` classifies the failure (`classifyFailure` → `permanent` /
  `timeout` / `transient`, by regex over the error message text) and picks a budget:
  - `transient` (429 / 5xx / conn reset): `MAX_RETRY_ATTEMPTS = 10`, `RETRY_DELAY_MS =
    60_000` — **flat 60s, up to 10 times = 10 minutes**.
  - `timeout` (408 / 504 / 524): `MAX_TIMEOUT_RETRY_ATTEMPTS = 2`, `TIMEOUT_RETRY_DELAY_MS
    = 2000`.
  - `permanent` (401/403/404/400, aborts): not retried.
  A streamed-content guard (`canRetry`) vetoes replay after the first token.

### The reference behaviour

Exponential backoff with jitter, and honouring the server's `Retry-After` header — so a
fleet of clients doesn't retry in lockstep, and the wait matches what the server actually
asked for.

### Where Sylor diverges

- **Flat, not exponential; no jitter (Medium-High).** Confirmed. Transient failures wait a
  fixed 60s each, up to 10 times. With `MAX_PARALLEL` lanes that hit a quota together,
  they retry **in lockstep** (no jitter) — a thundering herd against the same endpoint,
  60s apart, for up to 10 minutes.
- **`Retry-After` is ignored (Medium).** `classifyFailure` only regexes the message text
  for status codes and keywords; the response's `Retry-After` header is never parsed. The
  wait is always 60s regardless of what the server signalled.
- **No queueing/batching beyond the 1.2s serial gate (Medium).** `pace()` is a crude
  global spacer, not a token-bucket or quota-aware scheduler; it cannot proactively shape
  request rate to a known per-minute budget.

**Consequence:** exactly the "10×60s stacked, no smarter batching" you named. It survives
a blip, but under a real sustained rate limit it is both slow (up to 10 min) and rude
(lockstep, ignores the server's own guidance).

---

## Cross-reference: your five pre-named divergences

1. **Hardcoded ~9-phase template / ignores "max 5 steps"** → **§A.** Confirmed on
   *fixed templates* and *no explicit-constraint honouring*; corrected on "regardless of
   complexity" (it is 3/5/9-scaled). This is the highest-value planning fix.
2. **Subagents redo discovery** → **§D.** Confirmed with nuance: a scoped handoff exists,
   but it carries prose findings, not the file contents/line ranges that would prevent
   re-reading; the read cache softens but doesn't remove the cost, and worktrees can miss
   it.
3. **plan.md not re-read after compaction** → **§C.** Confirmed for intra-phase
   compaction. Memory docs *are* re-read at phase boundaries (a strength), but plan/task
   state is not re-anchored at the fold itself.
4. **Reasoning effort fixed** → **§E.** Confirmed: one value per turn (complex→max, else
   requested), reused every step, inherited by subagents. It is genuinely wired to the API
   — it just isn't per-step.
5. **10×60s backoff, no batching** → **§H.** Confirmed: flat 60s × 10, no exponential, no
   jitter, ignores `Retry-After`, only a 1.2s serial pacer for shaping.

Plus the Phase 1 permission principle → **§G**: 3 modes not 4, no command classification,
and — the security crux — **no OS-level sandbox**; the shell is gated by approval only.

---

## Appendix: evidence index (file → what it establishes)

| Concern | File(s) | Key symbols |
|--------|---------|-------------|
| Complexity routing | `orchestrator/complexity.ts` | `classifyComplexity` (model-first), `ROUTER_SYSTEM`, `route()` |
| Roadmap + plan template | `orchestrator/phasePlan.ts` | `SMALL/MEDIUM/LARGE_PHASES`, `PLAN_SECTIONS` (29), `sectionsFor` (15/24/29), `RANK` |
| Phase/complexity persistence | `orchestrator/staging.ts` | `resolvePhase` (shrink-only, phase≤1), `authorPhasePlan`, `closePhase`, `memoryDigest`, `planningBrief` |
| Task graph | `orchestrator/planner.ts` | `buildPlan`, `singleNode`, `MAX_TASKS=8`, `normalizeTasks` |
| Todo/task rendering | `orchestrator/phasePlan.ts`, `staging.ts` | `renderTasks` (`- [ ]`), `renderTasksDoc` (state-derived), `archivePlan` |
| Compaction | `engine.ts` | `planCompaction`, `compactHistoryWithModel`, `summarizeFoldedWithModel('low')`, `buildMessages`, `readPlanMd` |
| Subagent spawn + handoff | `engine.ts`, `orchestrator/sharedContext.ts`, `orchestrator/roles.ts` | `runSubagent`, `buildSubagentSystem`, `summarizeForAgent` (full/scoped/minimal), `reportWordBudget`, `servedFromReadCache` |
| Roles / capabilities | `orchestrator/roles.ts`, `orchestrator/capabilities.ts` | `define(...)`, `contextScope`, `capabilities` |
| Reasoning effort | `engine.ts` | `effectiveEffort` (~1429), `completionOptions`, `effortDirective` |
| Verification | `engine.ts`, `orchestrator/orchestrator.ts`, `fs/verify.ts` | `verifyProject`, `VERIFY_SCRIPTS`, `verifyWrittenFile`, `review()` (fail-open), `MAX_REWORK=2` |
| Permissions | `workflow/permission.ts` | `decideAuto` (3 modes), `decideBrowse` (payment/delete/send), `fullAccess`, `autoSend` |
| FS sandbox | `fs/operations.ts` | `resolveSafe` (2 gates), `PathEscapeError`, `fullAccessEnabled()` bypass |
| Command exec (no OS sandbox) | `terminal/runner.ts`, `terminal/pty.ts` | `runCommand`, `spawnCommandPty` (`powershell -Command` / `$SHELL -c`, `cwd=root`, `env=process.env`) |
| Retry/backoff | `workflow/resilience.ts` | `pace` (1.2s serial), `withRetry`, `MAX_RETRY_ATTEMPTS=10`, `RETRY_DELAY_MS=60000` (flat), no `Retry-After` |

---

*End of Phase 0 audit. Awaiting your review before Phase 1 (`design-proposal.md`). No
working code will be touched until this document is approved.*
