import type {
  AgentRole,
  ChatMessage,
  IntentKind,
  McpCategory,
  McpToolInfo,
  PermissionMode,
  ReasoningEffort,
  SkillInfo,
  TaskNode,
  ToolDecision,
  ToolProposal,
  ToolResult,
  WorkflowEvent,
  WorkflowRunRequest,
  WorkflowStage
} from '../../shared/types'
import { providerFromSettings, type Provider } from '../providers'
import { toErrorMessage } from '../providers/http'
import { getSettings, isSkillEnabled } from '../settings'
import { contextManager } from '../context/manager'
import {
  applyEdit,
  listDirectory,
  proposeWrite,
  readFileSlice,
  readProjectFile,
  searchProject,
  writeProjectFile
} from '../fs/operations'
import { describeIssues, recheckWrittenFile, verifyWrittenFile } from '../fs/verify'
import { appendProjectMemory, getProject, listProjectKnowledge } from '../db/projects'
import { runCommand } from '../terminal/runner'
import { looksLikeDevServer, startDev } from '../preview/server'
import { mcpManager } from '../mcp/manager'
import { skillsRegistry } from '../skills/registry'
import { mergeSkillCatalog } from '../skills/catalog'
import { classifyIntent } from './intent'
import { decideAuto } from './permission'
import { ToolStreamParser, type ParsedTool } from './toolStream'
import { ReasoningStripper, stripReasoningTags } from './reasoning'
import { isAbort, withRetry, type RetryNotice } from './resilience'
import { resolveRole, roleDirective, roleIds, reportWordBudget } from './orchestrator/roles'
import {
  allowsTool,
  scopeMcpTools,
  scopeSkills,
  serverCategoryMap,
  type Capability
} from './orchestrator/capabilities'
import {
  runOrchestrator,
  type NodeRunOptions,
  type NodeRunResult,
  type VerifyOutcome
} from './orchestrator/orchestrator'

/** Sink the engine emits events to (wired to IPC in workflow-ipc.ts). */
export type EventSink = (event: WorkflowEvent) => void

/** Sink for live command output (wired to the terminal pane in workflow-ipc.ts). */
export type TerminalSink = (data: string) => void

/**
 * The Sylor system prompt. Phase 4 lifts the read-only boundary: the engine can
 * now edit files and run commands, but only by *proposing* structured tool ops
 * that the user (or the permission mode) approves. The prompt teaches the model
 * the `sylor-tool` block protocol.
 */
const SYSTEM_PROMPT = `You are Sylor, a premium AI coding assistant embedded in a desktop IDE.
You can READ the user's project for context, reason step by step, edit files, and run
terminal commands — but only by PROPOSING actions the user approves.

To edit a file or run a command, emit a fenced block in this exact format:

\`\`\`sylor-tool
{ "tool": "write_file", "path": "relative/path.ts", "content": "<full new file contents>" }
\`\`\`

or

\`\`\`sylor-tool
{ "tool": "run_command", "command": "npm test" }
\`\`\`

YOU CAN LOOK AT THE PROJECT — DO IT BEFORE YOU CHANGE ANYTHING:

\`\`\`sylor-tool
{ "tool": "read_file", "path": "src/App.tsx" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "list_files", "path": "src/components" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "search_files", "query": "useAuth", "path": "src", "glob": "*.ts" }
\`\`\`

These three only LOOK — they change nothing, so they run immediately without asking the
user, and (unlike an action) you may emit several in one message to gather what you need
before deciding. read_file takes optional "offset" (1-based first line) and "limit" for a
big file. search_files takes a regular expression; "path" and "glob" are optional filters.

To change part of an existing file, replace an exact piece of it — do NOT rewrite the
whole file:

\`\`\`sylor-tool
{ "tool": "edit_file", "path": "src/App.tsx", "old_string": "<exact text to replace>", "new_string": "<replacement>" }
\`\`\`

Rules that matter more than any others when working on code that already exists:
- NEVER edit a file you have not read this turn. Guessing at contents you haven't seen
  destroys the user's work. read_file first, then edit.
- Prefer edit_file over write_file for any file that already exists. write_file replaces
  the ENTIRE file, so using it on a real file silently deletes everything you forgot to
  reproduce. Use write_file for NEW files (and for a rewrite the user actually asked for).
- "old_string" must match the file byte for byte, including indentation, and must be unique.
  Include a few surrounding lines if the snippet appears more than once, or set
  "replace_all": true to change every occurrence.
- read_file prints line numbers for reference ONLY. They are not in the file — never
  include them in "old_string".
- When something doesn't work, investigate before rewriting: read the file, search for the
  symbol, run the failing command and read its output. A fix grounded in what you actually
  saw beats a rewrite based on a guess.

You also have a long-term MEMORY for the current project. When you learn a durable
fact worth recalling in future chats — a convention the project follows, a decision the
user made, how something is wired, a preference they stated — record it with:

\`\`\`sylor-tool
{ "tool": "remember", "note": "<one concise fact to remember>" }
\`\`\`

Rules for tool blocks:
- ONE ACTION PER MESSAGE. A write_file, edit_file, run_command, or mcp_call block ENDS your
  message: say one short line, emit that single block, and stop. The app runs it and reports
  back, and only THEN do you continue. Anything you write after an action block is discarded
  unseen — so never stack a second file, a summary, or "next I'll…" behind it. (Read-only
  blocks are the sole exception: several read_file / list_files / search_files in one message
  is fine, since they only gather context before you act.)
- To create or change several files, emit them one per message across several steps — file,
  result, next file — never many at once.
- One JSON object per block.
- Use ONLY project-relative paths (never absolute, never "..").
- For write_file, "content" MUST be the complete new file, not a diff or a fragment.
- For remember, "note" is a single short fact (not a whole conversation). Only remember
  things that stay true across chats; never secrets, keys, or one-off details.
- Explain what you're about to do in one line of prose first, then emit the tool block. Prose
  outside blocks is shown to the user; the JSON inside blocks is not.
- Do not claim an edit or command succeeded — the app executes approved blocks and reports
  the result back. Propose, don't pretend.

CRITICAL — how to deliver code (this is the rule models most often break):
- NEVER paste file contents as an ordinary Markdown code fence (\`\`\`ts, \`\`\`tsx, \`\`\`js,
  \`\`\`python, …). Code shown that way does NOTHING — no file is created and the user cannot
  use it. The ONLY way to create or change a file is a write_file sylor-tool block.
- If you intend for a file to exist, emit a write_file block for it — one block per file.
  Whenever you catch yourself about to open a plain code fence to "show" a file, stop and
  emit a write_file block instead.
- For a multi-file project, build it ONE FILE AT A TIME: say briefly what this file is, emit
  the single write_file block for it, and after the app reports it applied, move to the next
  file. Do not dump the whole project in one message — that is the opposite of what's wanted.
  This think → act → think rhythm, one file per step, is expected and required.
- Reserve plain Markdown fences for tiny inline illustration only (a shell one-liner or a
  1–2 line snippet) that is NOT meant to become a file.

LIVE PREVIEW (how the user actually SEES what you build):
- A self-contained page (a single .html with inline/CDN CSS & JS, or a built bundle it
  references) previews automatically the moment you write it — no server needed.
- A build-step app (React, Vue, Svelte, Solid, Preact — anything scaffolded with Vite,
  Next, Astro, Nuxt, Remix, or CRA) CANNOT be previewed as raw files: its index.html points
  at unbuilt source like /src/main.tsx, which a browser can't run. It MUST be served by its
  dev server. So after you've written the project files, START THE DEV SERVER with a
  run_command block — e.g. \`npm run dev\` (or the script in package.json). Dependencies
  install automatically first, and the live preview opens on the server's URL.
- Do this as the final step once the files exist. One dev-server command is enough — it
  keeps running and hot-reloads on further edits; do not re-run it every change.

HOW YOU COMMUNICATE — narrate the WORK, never the THINKING:
- Every message you send must contain at least one short line of prose. A reply that is
  nothing but tool blocks looks frozen from the outside: the user sees a spinner, has no
  idea what you're doing, and gives up on you. Going quiet is the fastest way to lose them.
- One short line each time you act. Before the block, what you're about to do: "Reading
  Header.tsx to see how the nav is built." After the app reports results back, what landed
  and what's next: "Config's in — wiring the router now." One or two sentences, present
  tense, name the file. Then the block. The user is watching a progress feed, not reading
  an essay.
- Narrate FACTS: what you are about to do, what you just found, what changed. Never
  narrate DELIBERATION: how you are deciding, options you are weighing, a mind you just
  changed. The same step, done right and done wrong:
    good — "Adding the dark-mode toggle to Header.tsx."
    bad  — "Hmm, where does the toggle go? Header, maybe… actually the layout is better."
    good — "The port is hardcoded at server.ts line 12 — fixing it there."
    bad  — "Wait, that's not it either. Let me look again. Ugh, still wrong."
- So no "Wait…", "Actually…", "Hmm…", "Let me reconsider…", "No — better to…". Think as
  much as you need to internally; on screen show the decision, never the debate. If you
  change your mind, just do the better thing — never show a wrong attempt and walk it back.
- Calm, terse and final, the way Claude Code does it: short lines that say what is
  happening, one per step, and no filler between them.

Be concise, correct, and grounded in the provided project context.`

/**
 * The Cowork-mode system prompt. Cowork is a ChatGPT-like conversational
 * assistant: Sylor answers, explains, and writes code directly in its reply,
 * but has NO access to the user's files or terminal and proposes no tools. It is
 * deliberately silent about the `sylor-tool` protocol so the model never tries
 * to act on a folder here — that's what Code mode is for.
 */
const COWORK_SYSTEM_PROMPT = `You are Sylor, a friendly, sharp AI assistant. Right now you are in "Cowork" mode — you work like a chat assistant (think ChatGPT), not an agent.

In Cowork mode you:
- Answer questions, explain ideas, brainstorm, review snippets the user pastes, and hold a normal conversation.
- Write any code directly in your reply inside fenced Markdown code blocks (e.g. \`\`\`ts). The user can read and copy it.
- Do NOT have access to the user's files, folders, or terminal. You cannot edit files, run commands, or start servers here — so never say you did.

If the user wants you to actually read their project, edit files, run commands, or build and preview something in a folder, tell them to switch to "Code" mode using the Cowork/Code toggle by the message box — that's where you act on a project.

Be warm, concise, and genuinely helpful. Use Markdown for structure and keep every code block correct and runnable.

Think before you write, but keep that thinking to yourself: reply with the clean, final answer only. Do not narrate your private reasoning or self-corrections ("Wait…", "Actually, let me redo that…", "Hmm, no…") — just give the polished result, the way a sharp senior colleague would.`

/**
 * A directive appended to the system prompt reflecting the composer's reasoning
 * effort. `medium` is the baseline and adds nothing. Higher tiers ask the model
 * to deliberate step by step before answering; `low` asks it to answer directly.
 */
function effortDirective(effort: ReasoningEffort): string {
  switch (effort) {
    case 'low':
      return '\n\nReasoning effort: LOW. Answer directly and briefly. Do not over-explain.'
    case 'high':
      return (
        '\n\nReasoning effort: HIGH. Think carefully before you answer — understand what the ' +
        'user actually wants first — but keep that reasoning to yourself. The reply is the clean, ' +
        'final result, not a play-by-play of your thinking.'
      )
    case 'max':
      return (
        '\n\nReasoning effort: MAXIMUM. Deliberate thoroughly and PRIVATELY: consider edge cases ' +
        'and verify your approach before you commit to it. On screen, keep it brief: the short ' +
        'line for each step you take, and the result — never your scratchpad, dead ends, or ' +
        'self-corrections. More effort means more careful thinking, not more words on screen.'
      )
    default:
      return ''
  }
}

/**
 * A directive appended to the system prompt reflecting the *intent* of the turn,
 * so the model's behavior matches what the user actually wants:
 * - `chat` → converse; never scan the project or propose tools for small talk.
 * - `question` → answer directly with the conclusion, thinking privately; only act if explicitly asked.
 * - `edit` → act like Claude Code: one short sentence, then IMMEDIATELY emit the
 *   write_file block(s) — never end on a promise with no tool. Keeps builds moving
 *   instead of stalling on an "I'll create…" intro.
 */
function intentDirective(kind: IntentKind): string {
  switch (kind) {
    case 'chat':
      return (
        '\n\nThis message is conversational — a greeting or small talk, not a coding task. ' +
        'Reply naturally and warmly as Sylor, in a sentence or two. Do NOT propose file edits, ' +
        'do NOT run commands, and do NOT dump a project analysis. Only move to real work once the ' +
        'user clearly asks you to build, change, or investigate something.'
      )
    case 'question':
      return (
        '\n\nThe user is asking a question. Work it out privately, then answer directly and ' +
        'clearly with the conclusion — do not narrate your reasoning or think out loud. If you ' +
        'need to look at the project first, say in one short line what you are checking ' +
        '("Checking how auth is wired in src/auth.") so the user is not left watching silence, ' +
        'read what you need, then answer. Propose a ' +
        'file edit or command ONLY if the user is explicitly asking you to change something.'
      )
    case 'edit':
      return (
        '\n\nThe user wants you to build or change something — act like a hands-on engineer, the ' +
        'way Claude Code does. Open with ONE short sentence on what you are about to do (do not ' +
        'restate their request back to them, and do not write a long plan), then IMMEDIATELY emit ' +
        'the write_file block that makes it real in this SAME turn. Never end a turn on a promise ' +
        'like "I\'ll create…" or "let me build…" with no tool block — that builds nothing. Do ONE ' +
        'action per message: emit a single write_file / edit_file / run_command block, then STOP ' +
        'and wait — the app runs it and reports back before you continue. Never stack two files, ' +
        'or a "next I\'ll…" note, behind an action block; anything after it is thrown away unseen. ' +
        'Build a multi-file project ONE FILE AT A TIME across many small steps, and each time the ' +
        'app reports back, open with one short line on what just landed and what you are doing ' +
        'next, then the next block. One line per step, never a paragraph: the user should be able ' +
        'to follow the build as it happens, file by file, instead of staring at a spinner.'
      )
    default:
      return ''
  }
}

/**
 * A directive appended to the system prompt when the composer's "Plan first"
 * toggle is on and the turn is an edit. Sylor writes a `plan.md` capturing the
 * whole plan and stops, so the user can review before any code is written.
 */
function planDirective(planFirst: boolean, kind: IntentKind): string {
  if (!planFirst || kind !== 'edit') return ''
  return (
    '\n\nPLAN-FIRST MODE is on. Before making ANY other change, write a file named `plan.md` ' +
    'at the project root containing: the goal in one line, the files you will create or modify, ' +
    'and the work as a numbered, ordered checklist. Emit ONLY the write_file tool block for ' +
    '`plan.md` this turn — do not edit any other file or run any command yet. End by telling the ' +
    'user to review plan.md and reply to proceed.'
  )
}

/**
 * A directive telling the model which shell `run_command` blocks execute in, so
 * the commands it proposes are valid for the host. On Windows the runner spawns
 * Windows PowerShell 5.1, which rejects `&&`/`||`; elsewhere it's a POSIX shell.
 */
function shellDirective(): string {
  if (process.platform === 'win32') {
    return (
      '\n\nShell: run_command blocks run in Windows PowerShell. Do NOT use `&&` or `||` — they ' +
      'are invalid there. Chain commands with `;` (e.g. `git add -A; git commit -m "msg"`) or emit ' +
      'separate run_command blocks. Use PowerShell-compatible syntax only.'
    )
  }
  return '\n\nShell: run_command blocks run in a POSIX shell (bash/sh); `&&`, `||`, and pipes are fine.'
}

/**
 * A directive listing the tools exposed by connected MCP servers and teaching the
 * `mcp_call` block that invokes them. Appended to the Code-mode system prompt only
 * when at least one tool is available, so the model never hallucinates a call
 * against a server that isn't there. Each call is permission-gated like a command.
 */
function mcpDirective(tools: McpToolInfo[]): string {
  if (tools.length === 0) return ''
  const list = tools
    .map((t) => `- ${t.server}/${t.name}${t.description ? ` — ${t.description}` : ''}`)
    .join('\n')
  return (
    '\n\n## MCP tools\nExternal tools are available through connected MCP servers. ' +
    'To call one, emit a tool block:\n\n' +
    '```sylor-tool\n{ "tool": "mcp_call", "server": "<server>", "name": "<tool>", "arguments": { } }\n```\n\n' +
    'Use the exact server and tool names from this list, and pass "arguments" as a JSON object ' +
    'matching what the tool expects (use {} when it takes none). Like commands, every MCP call is ' +
    "shown to the user for approval and its result is reported back to you — propose, don't pretend.\n\n" +
    'Available tools:\n' +
    list
  )
}

/**
 * A directive listing the enabled skills and teaching the `use_skill` block that
 * activates one. Appended to the Code-mode system prompt only when at least one
 * skill is enabled, so the model never invokes a skill that isn't there. Invoking
 * a skill injects its full SKILL.md instructions into the conversation for the
 * next step (mirroring the CLI's Skill tool); it needs no approval, but anything
 * the skill then does still flows through the gated tool pipeline.
 */
function skillsDirective(skills: SkillInfo[]): string {
  if (skills.length === 0) return ''
  const list = skills
    .map((s) => {
      const desc = s.description ? ` — ${s.description}` : ''
      const when = s.whenToUse ? ` (use when: ${s.whenToUse})` : ''
      return `- ${s.name}${desc}${when}`
    })
    .join('\n')
  return (
    '\n\n## Available skills\nSkills are pre-written playbooks you can load on demand. ' +
    'When a task matches one, activate it with a tool block BEFORE doing that work:\n\n' +
    '```sylor-tool\n{ "tool": "use_skill", "name": "<skill>" }\n```\n\n' +
    "The skill's detailed instructions are then added to the conversation for you to follow. " +
    'Use the exact skill name from this list, and activate a skill only when it genuinely fits ' +
    'the task — for anything not covered by a skill, just proceed normally.\n\n' +
    'Available skills:\n' +
    list
  )
}

/**
 * The lead-only directive teaching the `spawn_agent` block (requirement B). The
 * lead is a full agent — for a small change it just acts — but for a substantial
 * build it can decompose the work and delegate a slice to a specialist subagent
 * (planner / builder / reviewer), read the report it hands back, keep `plan.md`
 * current (requirement E), and iterate. Subagents run the SAME gated loop in the
 * SAME folder but cannot themselves spawn (nesting depth 1), so this directive is
 * added only to the lead's prompt — never a subagent's.
 */
function spawnDirective(): string {
  return (
    '\n\n## Delegating to subagents (you are the lead engineer)\n' +
    'For a real multi-step build, act as the LEAD: decompose the task and delegate a slice to a ' +
    'specialist subagent instead of doing everything in one turn. Spawn one with:\n\n' +
    '```sylor-tool\n{ "tool": "spawn_agent", "role": "builder", "task": "<one clear, self-contained task>" }\n```\n\n' +
    'Roles you can delegate to:\n' +
    '- planner — creates or refines `plan.md` (the living checklist) and reports the plan.\n' +
    '- builder — implements one specific slice (creates/edits files, runs commands).\n' +
    '- reviewer — runs typecheck/tests/lint and inspects the result, reporting PASS/FAIL + issues.\n' +
    `- specialists, when the slice is clearly domain-specific: ${roleIds()
      .filter((id) => !['lead', 'planner', 'builder', 'reviewer'].includes(id))
      .join(', ')}.\n\n` +
    'Each subagent works in the same folder under the same approval rules and reports back to you ' +
    'when done; you then read the report and decide the next step (delegate again, fix, or finish). ' +
    'Keep `plan.md` up to date as stages complete — writing it is the FIRST step, never the last: ' +
    'do NOT stop after planning; immediately implement the next unchecked item (delegate a builder ' +
    'or write the files), check it off (`- [x]`), and continue until the whole checklist is done. ' +
    'Delegate for genuine multi-step work — for a ' +
    'one-file tweak, just do it yourself. Subagents cannot spawn further subagents. As the lead, ' +
    'narrate your decisions in prose but never paste file contents into chat — always use write_file.'
  )
}

/**
 * The role-specific operating instruction seeding a subagent's system prompt
 * (requirement B). Each subagent is a focused specialist: it has the gated tool
 * protocol (write_file / run_command / mcp_call / use_skill) — narrowed to the
 * capabilities its role holds — a narrow remit, and always ends with a short
 * report the lead reads.
 *
 * The directives themselves live in the extensible `roles.ts` registry, so
 * adding a specialist is a registry entry, not an edit to this file.
 */
function roleDirectiveFor(role: Exclude<AgentRole, 'lead'>): string {
  return roleDirective(role)
}

/** A pending tool decision the engine is blocked on, keyed by toolId. */
interface PendingDecision {
  resolve: (decision: ToolDecision) => void
}

/** Tracks a running workflow so it can be cancelled and answered. */
interface RunHandle {
  controller: AbortController
  /** Tool requests awaiting a renderer decision, keyed by toolId. */
  pending: Map<string, PendingDecision>
}

const activeRuns = new Map<string, RunHandle>()

/**
 * Upper bound on agent-loop iterations in a single turn. Each iteration is one
 * model completion plus the tools it proposes; the loop normally ends earlier —
 * as soon as the model stops proposing side-effecting tools (its final answer).
 * The cap is a safety net against a model that keeps proposing work without ever
 * converging, so one turn can't spin forever or exhaust the context.
 *
 * Sized generously so a large request genuinely decomposes across several
 * think → act → think rounds (scaffold a file, run it, read the result, fix,
 * verify …) instead of being squeezed into one over-stuffed answer. The loop
 * still stops the instant the model has nothing left to do, so simple turns pay
 * nothing for the extra headroom.
 *
 * This is a *runaway backstop*, not a work budget. It used to be 12, which real
 * multi-file builds hit — the turn stopped mid-task with items still open, which
 * reads as "Sylor did 12 steps then quit". Work is bounded by convergence (the
 * loop exits the moment the model proposes no tool) and by the stall guards
 * below (MAX_NUDGES / MAX_CONTINUES / MAX_START_NUDGES), which cap the paths
 * that could actually spin. A productive step — one that wrote a file, ran a
 * command, or delegated — is always allowed to be followed by another, so a
 * genuinely large task now runs to completion instead of being truncated.
 *
 * Raised from 250 when a step became ONE action instead of a batch: the same build
 * that used to fit in one eight-write step now costs eight steps, so the backstop
 * has to scale with it or a large project would hit the cap mid-way.
 */
const MAX_STEPS = 400

/**
 * Upper bound on corrective "you dumped raw code — re-emit as write_file blocks"
 * nudges in a single turn. A weak model may ignore the first nudge, so allow a
 * couple; but never spin on it — the raw code is at least shown to the user as
 * prose either way, and MAX_STEPS still caps the turn.
 */
const MAX_NUDGES = 2

/**
 * Upper bound on autonomous "keep building" continuations in a single turn (lead
 * only). A weaker model often writes plan.md — or finishes one slice — then stops,
 * emitting prose but no tool, even though the plan's checklist still has open
 * items; without this the build stalls right after the plan (the "created plan.md
 * then stopped" failure the user hit). Each continuation re-prompts the lead to
 * implement the next unchecked item. Bounded (alongside MAX_STEPS) so a model that
 * never converges can't spin or burn tokens — and only *stalls* spend this budget:
 * turns where the model is actively proposing tools cost nothing here.
 *
 * Raised from 4 alongside MAX_STEPS: a long checklist legitimately needs one
 * continuation per remaining item, and a *productive* continuation (the model
 * went on to build something) refunds itself — see `continues` bookkeeping in
 * the loop, which only charges continuations that produced nothing.
 */
const MAX_CONTINUES = 60

/**
 * Fed back to the model when, on an edit turn, it pasted file contents as plain
 * Markdown fences instead of proposing write_file blocks — so nothing was staged.
 * Steers it to re-emit those files through the tool protocol. This is also what
 * produces the visible think → act → think loop when a model first "answers" with
 * raw code and only then stages it.
 */
const RAW_CODE_NUDGE =
  'STOP. You wrote file contents as plain Markdown code blocks, so NOTHING was created — the ' +
  'user cannot use code pasted into chat. For EVERY file you just showed, emit a separate ' +
  'write_file sylor-tool block now:\n\n' +
  '```sylor-tool\n{ "tool": "write_file", "path": "relative/path.ext", "content": "<the full file>" }\n```\n\n' +
  'Use the complete contents you already wrote. Emit only the write_file block(s) — do not ' +
  're-explain. If there are many files, stage the first few now; you will be asked to continue.'

/**
 * Fed back to the LEAD when it stalled (prose, no tool) but `plan.md` still has
 * unchecked `- [ ]` items — so the build isn't done. Steers it to implement the
 * next item (delegate a builder or write the files) and check it off, producing
 * the continuous plan → build → build … flow instead of stopping at the plan.
 */
const CONTINUE_NUDGE =
  'plan.md still has unchecked `- [ ]` items, so the build is NOT finished — do NOT stop at the ' +
  'plan. Implement the NEXT unchecked item now: either delegate it with a spawn_agent block ' +
  '(role "builder"), or create/edit the files yourself with write_file blocks. Then mark that ' +
  'item `- [x]` in plan.md. Keep going one item per turn until every item is checked — only then ' +
  'give your final summary.'

/**
 * Upper bound on "you promised but built nothing — start now" nudges in a single
 * turn (lead only). This is the general form of the stall the user kept hitting:
 * on a build request the model opens with "I'll create…" / "let me build…" and
 * then ends the turn with NO write_file block, so nothing exists — and, unlike the
 * plan.md case, there may be no checklist to fall back on (e.g. a one-shot "build
 * me a signup page"). The nudge pushes it to emit the file(s) immediately, the way
 * Claude Code just starts writing. Bounded so a model that only ever talks can't
 * spin; after this many tries the turn ends with the prose shown either way.
 */
const MAX_START_NUDGES = 2

/**
 * Fed back to the LEAD when, on a build/edit turn, it produced only prose (a
 * promise to build) with NO tool block of any kind and nothing built yet this
 * turn — the "said it would, then stopped" stall. Steers it to emit the first
 * write_file block(s) right away instead of narrating.
 */
const START_BUILD_NUDGE =
  'You described what you would do but emitted NO write_file block, so nothing was created and the ' +
  'user is left with an empty result. Do not stop at a description or a promise like "I\'ll ' +
  'create…". Right now, emit the write_file sylor-tool block(s) that actually create the first ' +
  'file(s):\n\n' +
  '```sylor-tool\n{ "tool": "write_file", "path": "relative/path.ext", "content": "<the full file>" }\n```\n\n' +
  'Start with the most important file and keep going in small steps. Build the thing — do not just ' +
  'talk about it.'

/**
 * Upper bound on "fix the file you just broke" nudges in a single turn. The static
 * check on every write (see `fs/verify`) can find a file that is provably broken —
 * unparseable JSON, a truncated source, a dead import — and the write's result
 * says so. If the model then tries to *end the turn anyway*, this pushes it back
 * to the file instead of handing the user something that won't run. Bounded: after
 * this many tries the turn ends and the issues are stated to the user rather than
 * looping forever on something the model can't fix.
 */
const MAX_FIX_NUDGES = 2

/** Fed back when the turn is about to end with a file still known to be broken. */
function fixItNudge(entries: Array<[string, string[]]>): string {
  const detail = entries
    .map(([path, messages]) => `${path}:\n${messages.map((m) => `  - ${m}`).join('\n')}`)
    .join('\n')
  return (
    'You are about to finish, but files you wrote this turn are still broken:\n\n' +
    detail +
    '\n\nDo not end here — the user would get something that does not run. Fix each one now: ' +
    'read_file it if you need to see its current state, then correct it with a write_file or ' +
    'edit_file block. If a report is genuinely wrong, say so explicitly and explain why.'
  )
}

/**
 * Detects a Markdown code fence in the prose the model streamed. `sylor-tool`
 * blocks are demuxed out before this sees the text, so any remaining opening
 * fence is a plain code block — the "raw code dump" the nudge converts into
 * write_file blocks. Matches an opening ``` at the start of a line.
 */
const PLAIN_CODE_FENCE_RE = /(^|\n)[ \t]*```/
function hasPlainCodeFence(prose: string): boolean {
  return PLAIN_CODE_FENCE_RE.test(prose)
}

/** Monotonic counter for tool ids (unique within a process run). */
let toolCounter = 0
const nextToolId = (): string => `tool-${++toolCounter}`

/** Monotonic counter for subagent ids (unique within a process run). */
let agentCounter = 0
const nextAgentId = (): string => `agent-${++agentCounter}`

/**
 * Upper bound on a subagent's own step budget (a slice of the lead's work).
 * Raised from 8: a specialist owning a whole task node (an API surface, a UI
 * feature) needs the same think → act → think headroom the lead has. Still a
 * fraction of MAX_STEPS, since a node is a slice rather than the whole request.
 * Doubled again (80 → 160) when a step became one action rather than a batch of
 * them — the same slice, more steps to express it in.
 */
const SUBAGENT_MAX_STEPS = 160

/**
 * Runs one workflow turn: analyze intent → (optionally) scan/read project →
 * stream the grounded response → execute any proposed tools under the active
 * permission mode. Emits {@link WorkflowEvent}s throughout. Never throws;
 * failures are reported as an `error` event.
 *
 * `onTerminal` receives live command output so the integrated terminal can show
 * agent-run commands as they execute.
 */
export async function runWorkflow(
  request: WorkflowRunRequest,
  emit: EventSink,
  onTerminal: TerminalSink
): Promise<void> {
  const { runId, messages, permissionMode, projectId, effort, planFirst, mode } = request
  const controller = new AbortController()
  const handle: RunHandle = { controller, pending: new Map() }
  activeRuns.set(runId, handle)

  const settings = getSettings()
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  // Load per-project instructions + knowledge once, up front, so they frame the
  // whole run. Never throws — a bad/deleted project id degrades to no preamble.
  const projectPreamble = buildProjectPreamble(projectId ?? null)

  try {
    // 0. Guard: nothing works without a model. Rather than firing a malformed
    // request that yields a cryptic provider error (or silence), tell the user
    // exactly what to do. Model discovery + auto-select normally prevents this.
    if (!settings.modelId.trim()) {
      emit({
        type: 'error',
        runId,
        message:
          'No model selected. Open Settings (the gear), pick your provider, enter its Base URL' +
          (settings.activeProvider === 'gateway' ? ' and API key' : '') +
          ', then choose a model from the list.'
      })
      return
    }

    // Cowork mode: a pure conversational assistant — no project scan, no tools,
    // no folder access. Sylor answers and writes code directly in the reply, so
    // a casual "how do I…" never triggers a file read or a terminal command.
    // Runs a single completion and stops; the agent pipeline below is Code mode
    // (the default when `mode` is unspecified, e.g. older callers / tests).
    if ((mode ?? 'code') === 'cowork') {
      emit({ type: 'status', runId, stage: 'generating', message: 'Thinking…' })
      const provider = providerFromSettings(settings)
      const system = COWORK_SYSTEM_PROMPT + effortDirective(effort ?? 'medium')
      const outbound: ChatMessage[] = [{ role: 'system', content: system }, ...messages]

      const parser = new ToolStreamParser()
      const think = new ReasoningStripper()
      let received = false
      const retry = retryReporter(runId, emit)
      await withRetry(
        async () => {
          await provider.streamCompletion(
            settings.modelId,
            outbound,
            (chunk) => {
              if (!chunk.delta) return
              received = true
              const prose = parser.push(chunk.delta)
              if (!prose) return
              const shown = think.push(prose)
              if (shown) emit({ type: 'delta', runId, text: shown })
            },
            controller.signal
          )
        },
        {
          signal: controller.signal,
          canRetry: () => !received,
          onRetry: retry.onRetry
        }
      )
      retry.clear('Thinking…')
      if (controller.signal.aborted) return
      const tail = think.push(parser.flush()) + think.flush()
      if (tail) emit({ type: 'delta', runId, text: tail })

      // Cowork never executes tools or records memory: the parser runs only as a
      // safety net so a stray tool block can't leak as raw JSON or be executed.
      emit({ type: 'done', runId })
      return
    }

    // 1. Understand the request (lightweight intent parse).
    emit({ type: 'status', runId, stage: 'understanding', message: 'Analyzing your request…' })
    const intent = await classifyIntent(lastUser, settings)
    if (controller.signal.aborted) return
    emit({ type: 'intent', runId, intent })

    // 2. Gather project context when the intent calls for it.
    let overview = ''
    if (intent.needsContext) {
      emit({ type: 'status', runId, stage: 'scanning', message: 'Scanning the project structure…' })
      const files = contextManager.listFiles()
      if (controller.signal.aborted) return

      emit({
        type: 'status',
        runId,
        stage: 'reading',
        message: files.length > 0 ? `Reading ${describeFiles(files)}` : 'Reading files for context…'
      })
      overview = contextManager.buildOverview()
      if (controller.signal.aborted) return
    }

    // 3. Plan.
    emit({ type: 'status', runId, stage: 'planning', message: 'Planning a response…' })

    // 4. Generate + act — a bounded agent loop. Each iteration streams one
    // completion over the running `outbound` history, executes whatever tools the
    // model proposed under the permission mode, then feeds the structured results
    // back as a new turn so the model can react — fix a failed command, continue a
    // multi-step task, or conclude. The loop ends when the model proposes no
    // side-effecting tools (its final answer), when the step budget is spent, or
    // on abort. This is what makes Sylor work in steps instead of one shot. On a
    // work turn the orchestrator below drives this same loop once per task node.
    const provider = providerFromSettings(settings)

    // Connect to any configured MCP servers (idempotent; reconnects only when the
    // project root changed) and gather their tools so the model knows what's
    // callable this turn. Never throws — a server that fails to connect is simply
    // absent from the list, so this is safe even with no mcp.json on disk.
    await mcpManager.ensureConnected(contextManager.getRoot())
    if (controller.signal.aborted) return
    const mcpTools = mcpManager.getTools()

    // Merge the built-in skills catalog with disk-authored skills for this project
    // (global ~/.sylor/skills + project <root>/.sylor/skills), then drop any the
    // user disabled (or built-ins that default off). Only enabled skills reach the
    // prompt. Cached by root; never throws — a missing directory yields no skills.
    const enabledSkills = mergeSkillCatalog(
      skillsRegistry.getSkills(contextManager.getRoot())
    ).filter((s) => isSkillEnabled(s.name, s.defaultOn ?? true))

    const outbound = buildMessages(
      messages,
      overview,
      projectPreamble,
      effort ?? 'medium',
      intent.kind,
      planFirst ?? false,
      mcpTools,
      enabledSkills
    )

    // Plan-first only writes plan.md and yields to the user, so it must run a
    // single pass and never loop back for more work.
    const planFirstStop = (planFirst ?? false) && intent.kind === 'edit'
    const maxSteps = planFirstStop ? 1 : MAX_STEPS

    // Everything a delegated subagent needs to be framed exactly as the lead was
    // (requirement B): the same project overview, preamble, effort, MCP tools, and
    // skills. Threaded through every spawn so a subagent starts with the lead's
    // context, not a blank slate.
    const spawnContext: SpawnContext = {
      overview,
      projectPreamble,
      effort: effort ?? 'medium',
      mcpTools,
      enabledSkills,
      // Condensed prior-turn context (no LLM) so a fresh-context subagent can
      // resolve references like "now make it blue" without the full history.
      recap: buildConversationRecap(messages)
    }

    // The lead agent's arguments. The lead is a full agent — it can edit/run/call
    // directly — that can ALSO delegate a slice to a specialist subagent via
    // spawn_agent (allowSpawn). Each subagent runs this SAME gated loop (nesting
    // depth 1) with its activity nested under its own agentId and a report handed
    // back to the lead. The loop emits every delta/tool/status itself.
    const leadArgs: AgentLoopArgs = {
      role: 'lead',
      outbound,
      maxSteps,
      intentKind: intent.kind,
      planFirstStop,
      allowSpawn: true,
      runId,
      permissionMode,
      projectId: projectId ?? null,
      handle,
      provider,
      modelId: settings.modelId,
      enabledSkills,
      emit,
      onTerminal,
      spawnContext
    }

    // The orchestration gate (requirement A). EVERY work-producing Code turn runs
    // the full hierarchy: complexity router → planner → task graph → parallel
    // specialists → integration → verification → mandatory review → response.
    // The router only sizes the team, so a one-line fix collapses to a single node
    // — executed as the lead itself, over the real conversation history, so a small
    // turn behaves exactly as it did before orchestration existed — while a
    // multi-domain request fans out across scoped specialists.
    //
    // Deliberately NOT orchestrated: chat/question intents (nothing to build, so
    // planning and review would be pure overhead) and plan-first turns (the user
    // explicitly asked for a plan and a stop, which is its own gate).
    if (intent.kind === 'edit' && !planFirstStop) {
      await runOrchestrator({
        runId,
        request: lastUser,
        overview,
        settings,
        emit,
        signal: controller.signal,
        executeNode: (node, opts) => executeNode(node, opts, leadArgs),
        // plan.md goes through the same approval gate as any other write.
        writePlan: async (markdown) => {
          await executeTool(
            { tool: 'write_file', path: 'plan.md', content: markdown },
            { runId, permissionMode, handle, emit, onTerminal }
          )
        },
        verify: () => verifyProject({ runId, permissionMode, handle, emit, onTerminal }),
        // Non-streaming (a verdict, not prose) so it stays off the reply stream.
        // Paced + retried like every other model call; safe to replay verbatim
        // because nothing has been shown to the user yet.
        judge: async (msgs) => {
          const retry = retryReporter(runId, emit)
          const verdict = await withRetry(() => provider.getCompletion(settings.modelId, msgs), {
            signal: controller.signal,
            onRetry: retry.onRetry
          })
          retry.clear('Reviewing…')
          return verdict
        }
      })
      if (controller.signal.aborted) return
      emit({ type: 'done', runId })
      return
    }

    emit({ type: 'status', runId, stage: 'generating', message: 'Generating…' })
    await runAgentLoop(leadArgs)

    if (controller.signal.aborted) return
    emit({ type: 'done', runId })
  } catch (err) {
    if (!controller.signal.aborted) {
      emit({ type: 'error', runId, message: toErrorMessage(err) })
    }
  } finally {
    // Release any resolvers still waiting so nothing leaks on completion.
    for (const p of handle.pending.values()) p.resolve('reject')
    handle.pending.clear()
    activeRuns.delete(runId)
  }
}

/**
 * The project framing a subagent inherits from the lead so it starts with the
 * same context the lead had (requirement B), rather than a blank slate. Captured
 * once per run and threaded through every `spawn_agent`.
 */
interface SpawnContext {
  overview: string
  projectPreamble: string
  effort: ReasoningEffort
  mcpTools: McpToolInfo[]
  enabledSkills: SkillInfo[]
  /**
   * A cheap, bounded plain-text recap of the conversation BEFORE the current turn
   * (no model call). It lets a fresh-context subagent resolve back-references like
   * "now make it blue" without inheriting the whole history — the continuity that
   * used to come from running a SIMPLE turn as the lead. '' on a first turn. See
   * {@link buildConversationRecap}.
   */
  recap: string
}

/**
 * Everything {@link runAgentLoop} needs for one agent (the lead or a subagent).
 * The lead passes `role: 'lead'`, no `agentId`, the raw `emit`, and
 * `allowSpawn: true`; a subagent passes its role, a fresh `agentId`, an
 * agentId-stamped `emit`, and `allowSpawn: false` (nesting depth 1). `handle`,
 * `runId`, and `permissionMode` are shared so a subagent's tool approvals route
 * through the same pending-decision map as the lead's.
 */
interface AgentLoopArgs {
  role: AgentRole
  /** Present for subagents (nests their activity); absent for the lead. */
  agentId?: string
  /** Running message history the loop streams over and appends to in place. */
  outbound: ChatMessage[]
  maxSteps: number
  intentKind: IntentKind
  planFirstStop: boolean
  /** Whether spawn_agent blocks are honored — true for the lead only. */
  allowSpawn: boolean
  runId: string
  permissionMode: PermissionMode
  projectId: string | null
  handle: RunHandle
  provider: Provider
  modelId: string
  enabledSkills: SkillInfo[]
  emit: EventSink
  onTerminal: TerminalSink
  spawnContext: SpawnContext
  /**
   * The capabilities this agent's role holds. When present, `executeTool` refuses
   * any tool kind the role isn't granted (a reviewer can't silently rewrite
   * files). Absent for the lead, which is unrestricted.
   */
  capabilities?: readonly Capability[]
  /**
   * Collector the loop appends each successfully written project-relative path to,
   * so the orchestrator knows exactly what a task node changed.
   */
  filesWritten?: string[]
}

/**
 * Surfaces a retry attempt to the UI as a dimmed, italic status line — the
 * "low-opacity text" the user asked for. Emitted as a `status` event so it lands
 * on the single evolving activity line (not as prose in the reply, which would
 * pollute the assistant turn and get persisted). `_…_` renders italic/muted; the
 * `retrying` marker lets the renderer dim it further.
 */
function emitRetryNotice(
  notice: RetryNotice,
  runId: string,
  emit: EventSink,
  agentId?: string
): void {
  const seconds = Math.round(notice.delayMs / 1000)
  emit({
    type: 'status',
    runId,
    stage: 'generating',
    message: `Request failed (${notice.reason}) — retrying in ${seconds}s · attempt ${notice.attempt + 1}/${notice.max}`,
    ...(agentId ? { agentId } : {}),
    retrying: true
  })
}

/**
 * Pairs {@link emitRetryNotice} with a `clear` that restores a normal (undimmed)
 * status once the request finally goes through. Without it the dimmed
 * "retrying in 60s" line would linger for the rest of the phase, telling the user
 * we're stalled while work is actually streaming again. `clear` is a no-op unless a
 * notice was actually emitted, so the happy path emits nothing extra.
 */
function retryReporter(
  runId: string,
  emit: EventSink,
  agentId?: string
): { onRetry: (notice: RetryNotice) => void; clear: (message: string) => void } {
  let noticed = false
  return {
    onRetry: (notice) => {
      noticed = true
      emitRetryNotice(notice, runId, emit, agentId)
    },
    clear: (message) => {
      if (!noticed) return
      noticed = false
      emit({
        type: 'status',
        runId,
        stage: 'generating',
        message,
        ...(agentId ? { agentId } : {})
      })
    }
  }
}

/**
 * The core agent loop shared by the lead and every subagent (requirement B).
 * Each iteration streams one completion over `outbound`, demuxes prose from
 * `sylor-tool` blocks, records memory / activates skills inline, executes
 * side-effecting tools under the permission gate, optionally delegates slices to
 * subagents (lead only), then feeds the structured results back so the next
 * iteration can react — the same think → act → think rhythm, now reused at every
 * level. Returns the agent's latest non-empty prose as its report (what a
 * subagent hands back to the lead). On abort it returns the report so far, so the
 * caller can unwind. A tool failure is fed back to the model, never thrown.
 */
async function runAgentLoop(args: AgentLoopArgs): Promise<string> {
  const {
    outbound,
    maxSteps,
    intentKind,
    planFirstStop,
    allowSpawn,
    runId,
    permissionMode,
    projectId,
    handle,
    provider,
    modelId,
    enabledSkills,
    emit,
    onTerminal
  } = args
  const signal = handle.controller.signal

  // Skills whose instructions have already been injected this turn, so a repeated
  // `use_skill` doesn't re-inject the whole SKILL.md body each step.
  const activatedSkills = new Set<string>()
  // How many raw-code nudges have been spent this turn (see MAX_NUDGES).
  let nudges = 0
  // How many autonomous "keep building" continuations spent this turn (MAX_CONTINUES).
  let continues = 0
  // How many "you promised but built nothing — start now" nudges spent (MAX_START_NUDGES).
  let startNudges = 0
  // Files written this turn that failed their static check and have not been
  // rewritten cleanly since, keyed by path. This is what stops the turn ending on
  // a file we already know is broken (see MAX_FIX_NUDGES).
  const pendingIssues = new Map<string, string[]>()
  // How many "fix what you just broke" nudges spent this turn (MAX_FIX_NUDGES).
  let fixNudges = 0
  // Whether this turn has actually built anything yet (executed a side effect or ran a
  // subagent). Gates the start-build nudge so a genuine closing summary — prose after real
  // work — is treated as a finish, not a stall.
  let built = false
  // The agent's latest non-empty prose — its conclusion, returned as the report.
  let report = ''

  // Last few characters of prose streamed so far, and whether the current step has
  // yet to stream any. Each step is a separate completion appended to the SAME
  // assistant message, so a model that ends a step without a trailing newline would
  // otherwise run straight into the next step's opening line
  // ("…writing the config.Config's in — now the router."). See `emitProse`.
  let proseTail = ''
  let stepOpening = false

  /**
   * Streams prose to the UI, keeping a paragraph break between the narration of one
   * step and the next. Only ever *adds* separator whitespace — the model's own text
   * is never altered — and only at a step boundary, so prose within a single step
   * (before and after a tool block) flows exactly as written.
   */
  const emitProse = (text: string): void => {
    let out = text
    if (stepOpening && text.trim() !== '') {
      if (proseTail !== '' && !/\n[ \t]*\n[ \t]*$/.test(proseTail)) {
        out = (/\n[ \t]*$/.test(proseTail) ? '\n' : '\n\n') + text.replace(/^\s+/, '')
      }
      stepOpening = false
    }
    proseTail = (proseTail + out).slice(-8)
    emit({ type: 'delta', runId, text: out })
  }

  /**
   * Which tool block ends the model's message. One action per message is what makes
   * the work legible: a line of narration, one file, its result, then the next
   * decision — the same rhythm as the CLI, and the reason each tool card appears at
   * its own point in the prose instead of the whole batch arriving at the end.
   *
   * Reads are deliberately exempt: gathering three files before deciding anything is
   * one investigative act, and splitting it would just cost three round-trips.
   * `spawn_agent` only counts when this agent may actually spawn — otherwise the
   * block is filtered out later and stopping on it would end the step having done
   * nothing at all. Plan-first is exempt too: it is contractually a single pass that
   * writes plan.md and breaks, so there is nothing to interleave and cutting its
   * closing summary would only lose the explanation the user asked for.
   */
  const stopAfter = (tool: ParsedTool): boolean => {
    if (planFirstStop) return false
    return (
      tool.tool === 'write_file' ||
      tool.tool === 'edit_file' ||
      tool.tool === 'run_command' ||
      tool.tool === 'mcp_call' ||
      (allowSpawn && tool.tool === 'spawn_agent')
    )
  }

  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return report

    // 4a. Stream one completion, demuxing prose from tool blocks. Accumulate the
    // raw text (prose + blocks) so the assistant turn can be replayed verbatim,
    // and the prose alone so we can detect a raw-code dump (see the nudge below).
    //
    // The stream is cut at the first *action* (see `stopAfter`): the model narrates
    // one line, acts once, sees the result, and only then decides what comes next.
    // That is the whole think → act → observe → think rhythm — without it a model
    // emits eight write_file blocks in one message, every card lands at the same
    // point in the prose (so they all appear at once, at the end), and file #8 was
    // written without ever having seen what happened to file #1.
    //
    // Paced + retried (see resilience.ts): requests are spaced so parallel
    // specialists can't trip a rate limit, and a 429/5xx/timeout is retried up to
    // 10 times a minute apart, reported to the UI as a dimmed notice. `received`
    // guards replay safety — once bytes have reached the user, a retry would
    // duplicate them, so the attempt is not repeated.
    const parser = new ToolStreamParser({ stopAfter })
    const think = new ReasoningStripper()
    stepOpening = true
    let raw = ''
    let proseText = ''
    let received = false
    // Cuts the HTTP stream the moment the parser closes, so we don't sit waiting on
    // tokens we have already decided to discard. Chained off the run signal so a real
    // cancellation still propagates. Latency only — the one-action guarantee is the
    // parser's, which holds even when a provider delivers the whole message at once.
    const stepCtl = new AbortController()
    const relayAbort = (): void => stepCtl.abort()
    signal.addEventListener('abort', relayAbort, { once: true })
    const retry = retryReporter(runId, emit, args.agentId)
    try {
      await withRetry(
        async () => {
          await provider.streamCompletion(
            modelId,
            outbound,
            (chunk) => {
              if (!chunk.delta) return
              received = true
              raw += chunk.delta
              const prose = parser.push(chunk.delta)
              if (parser.stopped) stepCtl.abort()
              if (!prose) return
              const shown = think.push(prose)
              if (shown) {
                proseText += shown
                emitProse(shown)
              }
            },
            stepCtl.signal
          )
        },
        {
          signal,
          canRetry: () => !received,
          onRetry: retry.onRetry
        }
      )
    } catch (err) {
      // The abort we raised ourselves is the normal path, not a failure: the action
      // is already parsed and everything after it was going to be thrown away. Any
      // other error — including a genuine user cancel — still propagates.
      if (!(parser.stopped && !signal.aborted && isAbort(err))) throw err
    } finally {
      signal.removeEventListener('abort', relayAbort)
    }
    // A retry that eventually succeeded left the line dimmed; restore it so the
    // rest of the phase doesn't read as stalled.
    retry.clear('Generating…')
    if (signal.aborted) return report
    const tail = think.push(parser.flush()) + think.flush()
    if (tail) {
      proseText += tail
      emitProse(tail)
    }
    // Cut the replayed turn at the action too. The tail the model had already
    // generated — more blocks, or a summary of writes that never happened — is not
    // history: it was never executed and the user never saw it. Keeping it would let
    // the model carry on from a plan it only imagined.
    if (parser.stopped) raw = raw.slice(0, parser.consumed)
    // Some models inline their chain-of-thought as `<think>…</think>` in the
    // content channel; it's stripped from the shown prose above. Strip it from the
    // verbatim turn too, so a stray trace never re-primes the model on the next step.
    raw = stripReasoningTags(raw)
    // The last non-empty prose is the agent's conclusion — its report to the lead.
    if (proseText.trim()) report = proseText.trim()

    // 4b. Record any `remember` notes. These only append to the project's local
    // memory (no disk write, no command), so they skip the approval pipeline —
    // strictly less powerful than a file write and reversible in the DB.
    const memoryNotes = parser.tools.filter(
      (t): t is Extract<ParsedTool, { tool: 'remember' }> => t.tool === 'remember'
    )
    if (memoryNotes.length > 0) {
      recordMemory(memoryNotes, projectId, runId, emit)
    }

    // 4c. Skill activations. `use_skill` loads a disk-authored SKILL.md's
    // instructions into the conversation so the next iteration follows them —
    // like the CLI's Skill tool. It's inline (no approval): reading a local
    // playbook is strictly less powerful than a write or command, and anything
    // the skill then proposes still flows through the gated pipeline below.
    const skillRequests = parser.tools.filter(
      (t): t is Extract<ParsedTool, { tool: 'use_skill' }> => t.tool === 'use_skill'
    )
    const skillInjection = buildSkillInjections(skillRequests, enabledSkills, activatedSkills)
    for (const name of skillInjection.activatedNow) {
      emitProse(`\n\n📎 Using skill: ${name}`)
    }

    // 4d. Executable tools and (lead only) delegated subagents. When the model
    // proposed none of these and no skill, it has given its final answer for this
    // turn — stop looping. A skill-only turn keeps looping so the injected
    // instructions get a following iteration in which to be acted on. Reads count:
    // a turn that only looked at files must get another iteration to ACT on what
    // it found, otherwise the agent would stop mid-investigation.
    const sideEffects = parser.tools.filter(
      (t): t is ExecutableTool =>
        t.tool === 'write_file' ||
        t.tool === 'edit_file' ||
        t.tool === 'read_file' ||
        t.tool === 'list_files' ||
        t.tool === 'search_files' ||
        t.tool === 'run_command' ||
        t.tool === 'mcp_call'
    )
    const spawnRequests = allowSpawn
      ? parser.tools.filter(
          (t): t is Extract<ParsedTool, { tool: 'spawn_agent' }> => t.tool === 'spawn_agent'
        )
      : []

    // 4d′. Raw-code guard. On an edit turn where the model proposed no tools, no
    // subagent, and no skill, but pasted file contents as plain Markdown fences,
    // nothing was staged and the user got un-actionable code. Nudge it — up to
    // MAX_NUDGES times — to re-emit those files as write_file blocks, then loop so
    // it can. This is also what makes a "here's the code / now I'll stage it" turn
    // read as think → act → think. Skipped in plan-first (single-pass) mode.
    if (
      sideEffects.length === 0 &&
      spawnRequests.length === 0 &&
      !skillInjection.text &&
      intentKind === 'edit' &&
      !planFirstStop &&
      nudges < MAX_NUDGES &&
      hasPlainCodeFence(proseText)
    ) {
      nudges++
      emit({
        type: 'status',
        runId,
        stage: 'generating',
        message: 'Turning that code into file edits…'
      })
      outbound.push({ role: 'assistant', content: raw })
      outbound.push({ role: 'user', content: RAW_CODE_NUDGE })
      continue
    }

    // 4d″. Autonomous continuation (lead only). If the lead stalled — proposed no
    // tool, subagent, or skill — on an edit turn but `plan.md` still has unchecked
    // `- [ ]` items, the build isn't finished; nudge it to implement the next item
    // and loop, instead of stopping right after the plan. Gated to the lead, edit
    // intent, non-plan-first, with continuation budget left and a step to spare —
    // and only when open plan items actually remain, so a small task with no
    // plan.md (or a fully-checked one) still stops here and pays nothing.
    if (
      sideEffects.length === 0 &&
      spawnRequests.length === 0 &&
      !skillInjection.text &&
      allowSpawn &&
      intentKind === 'edit' &&
      !planFirstStop &&
      continues < MAX_CONTINUES &&
      step < maxSteps - 1 &&
      /- \[ \]/.test(readPlanMd())
    ) {
      continues++
      emit({ type: 'status', runId, stage: 'generating', message: 'Continuing the build…' })
      outbound.push({ role: 'assistant', content: raw })
      outbound.push({ role: 'user', content: CONTINUE_NUDGE })
      continue
    }

    // 4d‴. Start-build nudge (lead only). The general stall: on a build/edit turn the
    // model produced ONLY prose (a promise like "I'll create…") — no tool block of any
    // kind — and nothing has been built yet this turn, with no plan.md checklist to fall
    // back on (e.g. a one-shot "build me a signup page"). Push it to emit the first
    // write_file block(s) now, the way Claude Code just starts writing. Gated tightly:
    // lead + edit intent + non-plan-first + zero parsed tools (so a remember- or
    // skill-only turn is exempt) + real prose present + not a raw-code dump (that has its
    // own nudge above) + budget and a step to spare.
    if (
      parser.tools.length === 0 &&
      allowSpawn &&
      intentKind === 'edit' &&
      !planFirstStop &&
      !built &&
      !hasPlainCodeFence(proseText) &&
      proseText.trim().length > 0 &&
      startNudges < MAX_START_NUDGES &&
      step < maxSteps - 1
    ) {
      startNudges++
      emit({ type: 'status', runId, stage: 'generating', message: 'Starting the build…' })
      outbound.push({ role: 'assistant', content: raw })
      outbound.push({ role: 'user', content: START_BUILD_NUDGE })
      continue
    }

    // The turn wants to end here: nothing was proposed, delegated, or activated.
    const ending = sideEffects.length === 0 && spawnRequests.length === 0 && !skillInjection.text

    // 4d⁗. Verify-fix nudge. The turn is ending but a file written earlier this turn
    // is still failing its static check — the model wrote something broken and is
    // about to tell the user it's done. Send it back to the file. Applies to every
    // agent and every intent, because a file that cannot parse is broken regardless
    // of who wrote it or why; plan-first is exempt since it is contractually
    // single-pass.
    if (ending && pendingIssues.size > 0) {
      // Re-check each one against the file as it stands NOW. An issue can be
      // resolved by a later write to a different file — the missing stylesheet
      // finally created, the imported module finally added — and nudging about an
      // already-fixed file would be worse than not checking at all.
      for (const path of [...pendingIssues.keys()]) {
        const issues = recheckWrittenFile(path)
        if (issues.length === 0) pendingIssues.delete(path)
        else pendingIssues.set(path, issues.map((issue) => issue.message))
      }
    }
    if (
      ending &&
      !planFirstStop &&
      pendingIssues.size > 0 &&
      fixNudges < MAX_FIX_NUDGES &&
      step < maxSteps - 1
    ) {
      fixNudges++
      emit({ type: 'status', runId, stage: 'generating', message: 'Fixing what broke…' })
      outbound.push({ role: 'assistant', content: raw })
      outbound.push({ role: 'user', content: fixItNudge([...pendingIssues]) })
      continue
    }

    if (ending) {
      // Out of fix attempts (or out of steps) with something still broken. The
      // model's closing prose may well claim success, so state the truth plainly
      // next to it — the user finding out from a blank page instead is the exact
      // failure this whole check exists to prevent.
      if (pendingIssues.size > 0) {
        const detail = [...pendingIssues]
          .map(([path, messages]) => `- \`${path}\` — ${messages.join('; ')}`)
          .join('\n')
        emitProse(
          `\n\n_Heads up: these files still look broken to me, so check them before relying on this:_\n${detail}\n`
        )
      }
      break
    }

    // Once we're past the break, real work is about to happen this step. Remember it so a
    // later prose-only turn reads as a closing summary (a finish), not a stall to nudge.
    // Reads are deliberately excluded: looking at files is progress, but it is not
    // *building*, and if a read refunded the stall budgets a model could investigate
    // in circles forever instead of being nudged into writing something.
    const mutated = sideEffects.some(
      (t) => t.tool !== 'read_file' && t.tool !== 'list_files' && t.tool !== 'search_files'
    )
    if (mutated || spawnRequests.length > 0) {
      built = true
      // A productive step refunds the stall budgets: the continuation/start/nudge
      // caps exist to stop a model that only *talks*, and this step just DID work.
      // Refunding here is what makes a large build effectively unlimited — every
      // real step re-arms the budget for the next possible stall — while a genuine
      // dead stall (talk with no work, repeatedly) still exhausts it and stops.
      continues = 0
      startNudges = 0
      nudges = 0
    }

    // 4e. Execute each proposed tool under the permission mode, pairing each with
    // its structured outcome so the results can be fed back to the model.
    const outcomes: Array<{ tool: ExecutableTool; result: ToolResult }> = []
    if (sideEffects.length > 0) {
      const batch = describeBatch(sideEffects)
      emit({ type: 'status', runId, stage: batch.stage, message: batch.message })
      for (const tool of sideEffects) {
        if (signal.aborted) return report
        const result = await executeTool(tool, {
          runId,
          permissionMode,
          handle,
          emit,
          onTerminal,
          capabilities: args.capabilities,
          filesWritten: args.filesWritten
        })

        if (!result) return report // aborted while awaiting a decision
        outcomes.push({ tool, result })

        // Track which files are still known-broken. A clean rewrite of the same path
        // clears it, so the nudge above fires only while something is actually wrong
        // — and a file the model fixed on its own never triggers it.
        if (result.kind === 'write_file' && result.ok) {
          const path = tool.tool === 'write_file' || tool.tool === 'edit_file' ? tool.path : ''
          if (result.issues && result.issues.length > 0) pendingIssues.set(path, result.issues)
          else pendingIssues.delete(path)
        }
      }
      if (signal.aborted) return report
    }

    // 4e′. Delegated subagents (lead only — allowSpawn is false past depth 1).
    // Each runs this same gated loop in the same folder and hands back a report,
    // fed to the lead exactly like a tool result so it can decide the next step.
    const spawnReports: string[] = []
    for (const spawn of spawnRequests) {
      if (signal.aborted) return report
      const { report: subReport, ok } = await runSubagent(spawn, args)
      spawnReports.push(
        `Report from the ${spawn.role} subagent (${ok ? 'completed' : 'failed'}) ` +
          `for task "${spawn.task}":\n\n${subReport || '(no report returned)'}`
      )
    }
    if (signal.aborted) return report

    // 4f. Plan-first runs exactly once — never loop back after writing plan.md.
    if (planFirstStop) break

    // 4g. Out of budget: tell the user and stop rather than silently truncating.
    if (step === maxSteps - 1) {
      emitProse(
        `\n\n_(Reached the ${maxSteps}-step limit for this turn — ask me to continue if there's more to do.)_`
      )
      break
    }

    // 4h. Feed the round back: the assistant's own output (so it recalls what it
    // proposed) followed by a synthesized user turn combining any tool results,
    // subagent reports, and freshly activated skill instructions, so the next
    // iteration acts on all of them.
    outbound.push({ role: 'assistant', content: raw })
    const feedback: string[] = []
    if (outcomes.length > 0) feedback.push(summarizeResults(outcomes))
    if (spawnReports.length > 0) feedback.push(spawnReports.join('\n\n'))
    if (skillInjection.text) feedback.push(skillInjection.text)
    outbound.push({ role: 'user', content: feedback.join('\n\n') })
  }

  return report
}

/**
 * Truncates `text` to at most `maxWords` whitespace-separated words, marking the
 * cut. Bounds a subagent's handoff so one verbose agent can't flood the
 * orchestrator's context. Counts words, not chars, because the budget the roles
 * advertise ("under 150 words") is in words. A short string is returned unchanged.
 */
export function capWords(text: string, maxWords: number): string {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  const words = trimmed.split(/\s+/)
  if (words.length <= maxWords) return trimmed
  return `${words.slice(0, maxWords).join(' ')} …[report truncated at ${maxWords} words]`
}

/** Recap sizing: at most N prior turns, each clamped, and the whole clamped again. */
const RECAP_MAX_TURNS = 6
const RECAP_TURN_CHARS = 240
const RECAP_TOTAL_CHARS = 1200

/** Character clamp with a trailing ellipsis marker, keeping a recap bounded. */
function recapClamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max).trimEnd()} …`
}

/**
 * A cheap (no-LLM) recap of the conversation BEFORE the current turn, so a
 * fresh-context subagent can resolve back-references like "now make it blue"
 * without inheriting the whole history. Drops the final user turn (that's the
 * live request the subagent already receives as its task), strips tool-block and
 * reasoning noise from each prior message, keeps the last {@link RECAP_MAX_TURNS}
 * turns, and clamps both per-turn and overall. Returns '' when there is no prior
 * turn — the common first-message case, where callers see no change.
 */
export function buildConversationRecap(messages: readonly ChatMessage[]): string {
  const lastUserIdx = messages.map((m) => m.role).lastIndexOf('user')
  const prior = lastUserIdx > 0 ? messages.slice(0, lastUserIdx) : []
  const turns = prior
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const text = stripReasoningTags(m.content)
        .replace(/```sylor-tool[\s\S]*?```/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const who = m.role === 'user' ? 'User' : 'Sylor'
      return text ? `${who}: ${recapClamp(text, RECAP_TURN_CHARS)}` : ''
    })
    .filter(Boolean)
  if (turns.length === 0) return ''
  return recapClamp(turns.slice(-RECAP_MAX_TURNS).join('\n'), RECAP_TOTAL_CHARS)
}

/**
 * Runs one delegated subagent (requirement B). Emits `agent-start` on the
 * parent's (unstamped) sink, runs the SAME gated agent loop with a role-scoped
 * system prompt, capability-scoped tools, and a bounded step budget — its
 * activity tagged with a fresh agentId so the renderer nests it — then emits
 * `agent-end` with the report the lead reads. `allowSpawn` is false so a subagent
 * cannot spawn (nesting depth 1). Never throws: a subagent failure becomes a
 * failed report, so one bad slice can't abort the whole build.
 *
 * `opts.context` is the orchestrator's scoped shared-context digest (what this
 * agent's upstream dependencies already established); `opts.filesWritten`
 * collects the paths it actually changed.
 */
async function runSubagent(
  spawn: Extract<ParsedTool, { tool: 'spawn_agent' }>,
  parent: AgentLoopArgs,
  opts: { context?: string; filesWritten?: string[] } = {}
): Promise<{ report: string; ok: boolean; agentId: string }> {
  const agentId = nextAgentId()
  const { role, task } = spawn
  parent.emit({ type: 'agent-start', runId: parent.runId, agentId, role, task })

  const system = buildSubagentSystem(role, task, parent.spawnContext, opts.context)
  const outbound: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: task }
  ]

  let report = ''
  let ok = false
  try {
    report = await runAgentLoop({
      ...parent,
      role,
      agentId,
      outbound,
      maxSteps: SUBAGENT_MAX_STEPS,
      intentKind: 'edit',
      planFirstStop: false,
      allowSpawn: false,
      capabilities: resolveRole(role).capabilities,
      filesWritten: opts.filesWritten,
      emit: stampEmit(parent.emit, agentId)
    })
    ok = !parent.handle.controller.signal.aborted
  } catch (err) {
    report = `Subagent error: ${toErrorMessage(err)}`
    ok = false
  }

  // Bound the handoff: the orchestrator (and the nested-agent UI) only ever see a
  // report capped to the role's word budget, so one verbose subagent can't flood
  // the lead's context. Error strings are short, so this is a no-op for them.
  report = capWords(report, reportWordBudget(role))

  parent.emit({ type: 'agent-end', runId: parent.runId, agentId, role, report, ok })
  return { report, ok, agentId }
}

/**
 * Executes one orchestrator task node as a real agent — the bridge between the
 * (engine-agnostic) orchestrator and this file's agent machinery.
 *
 * Two shapes, one loop:
 *  - `asLead` (a single-node graph — the SIMPLE path): the node *is* the turn, so
 *    it runs as the lead over the real conversation history with the full tool
 *    set, free to delegate further via `spawn_agent`. A small edit therefore
 *    behaves exactly as it did before orchestration existed.
 *  - otherwise: a scoped specialist with its own agentId, its role's
 *    capability-filtered tools/MCP/skills, and only the slice of shared context
 *    its upstream dependencies produced.
 *
 * Either way, the paths it actually wrote come back in `filesChanged`.
 */
async function executeNode(
  node: TaskNode,
  opts: NodeRunOptions,
  leadArgs: AgentLoopArgs
): Promise<NodeRunResult> {
  const filesWritten: string[] = []

  if (opts.asLead) {
    const report = await runAgentLoop({ ...leadArgs, filesWritten })
    return {
      agentId: 'lead',
      report,
      ok: !leadArgs.handle.controller.signal.aborted,
      filesChanged: filesWritten
    }
  }

  const { report, ok, agentId } = await runSubagent(
    { tool: 'spawn_agent', role: node.role, task: nodeBrief(node) },
    leadArgs,
    { context: opts.context, filesWritten }
  )
  return { agentId, report, ok, filesChanged: filesWritten }
}

/** The brief a specialist receives for its node: the task plus any file hints. */
function nodeBrief(node: TaskNode): string {
  const hint = node.filesHint?.length ? `\n\nLikely files: ${node.filesHint.join(', ')}` : ''
  return `${node.description}${hint}`
}

/**
 * Scripts tried, in order, for the orchestrator's VERIFY stage — cheapest and
 * most deterministic first. A project with none of these simply isn't verified
 * (reported honestly) rather than having a command invented for it.
 */
const VERIFY_SCRIPTS = ['typecheck', 'lint', 'build', 'test'] as const

/** Watcher-shaped scripts, skipped because they never exit and would hang the turn. */
const WATCHER_RE = /--watch|^\s*(vitest|jest|nodemon)\s*$/

/**
 * The VERIFY stage: runs the project's own check through the SAME approval gate
 * as any other command, so the user sees and authorizes it. Distinguishes three
 * outcomes honestly — no check exists / the user declined (`ran: false`, no
 * claim made), the check passed, or the check failed (which the reviewer then
 * sees and can route to rework).
 */
async function verifyProject(ctx: ExecContext): Promise<VerifyOutcome> {
  const command = detectVerifyCommand()
  if (!command) return { ran: false, ok: false }

  const result = await executeTool({ tool: 'run_command', command }, ctx)
  if (!result || result.kind !== 'run_command') return { ran: false, ok: false }
  // A null exit code means it never actually ran (declined or aborted) — that is
  // "unverified", not "failed". We don't manufacture evidence in either direction.
  if (result.exitCode === null) return { ran: false, ok: false, command }
  return { ran: true, ok: result.exitCode === 0, command, output: result.output }
}

/**
 * Picks the project's verification command from its package.json scripts, or null
 * when it has none (a non-Node project, or no package.json). Best-effort and
 * never throws — an unreadable/malformed manifest simply means "no check".
 */
function detectVerifyCommand(): string | null {
  let scripts: Record<string, unknown>
  try {
    const pkg = JSON.parse(readProjectFile('package.json')) as { scripts?: Record<string, unknown> }
    scripts = pkg.scripts ?? {}
  } catch {
    return null
  }
  for (const name of VERIFY_SCRIPTS) {
    const script = scripts[name]
    if (typeof script !== 'string' || !script.trim()) continue
    if (WATCHER_RE.test(script)) continue
    return `npm run ${name}`
  }
  return null
}

/**
 * Wraps an emit sink so a subagent's streamed activity is tagged with its
 * agentId, letting the renderer route those deltas/status/tool events into that
 * agent's nested card. `agent-start`/`agent-end` already carry an explicit
 * agentId (and are emitted on the parent's sink), so they pass through unstamped.
 */
function stampEmit(emit: EventSink, agentId: string): EventSink {
  return (event) => {
    if (
      event.type === 'status' ||
      event.type === 'delta' ||
      event.type === 'tool-request' ||
      event.type === 'tool-result'
    ) {
      emit({ ...event, agentId })
    } else {
      emit(event)
    }
  }
}

/**
 * Reads the living `plan.md` (requirement E) so a subagent's prompt is seeded
 * with the current plan the lead maintains. Best-effort: a missing file or a path
 * error yields '' (the plan may not exist yet). Truncated so a huge plan can't
 * blow the subagent's context budget.
 */
function readPlanMd(): string {
  try {
    const content = readProjectFile('plan.md').trim()
    return content.length > 8000 ? `${content.slice(0, 8000)}\n… (truncated)` : content
  } catch {
    return ''
  }
}

/**
 * Assembles a subagent's system prompt: the same base protocol + shell / MCP /
 * skills framing the lead received — but **capability-scoped**, so a role only
 * ever sees the MCP servers and skills its capabilities unlock (a docs writer
 * isn't shown a database server) — its role-specific operating instruction from
 * the registry, the project preamble + overview, a bounded recap of the prior
 * conversation (so references survive a fresh context), the current `plan.md`,
 * the orchestrator's scoped shared-context digest, and finally the assigned task.
 * `spawnDirective` is deliberately omitted: subagents can't spawn (depth 1).
 */
function buildSubagentSystem(
  role: Exclude<AgentRole, 'lead'>,
  task: string,
  ctx: SpawnContext,
  sharedContext?: string
): string {
  const capabilities = resolveRole(role).capabilities
  const mcpTools = scopeMcpTools(ctx.mcpTools, capabilities, mcpServerCategories())
  const skills = scopeSkills(ctx.enabledSkills, capabilities)

  let system =
    SYSTEM_PROMPT +
    shellDirective() +
    mcpDirective(mcpTools) +
    skillsDirective(skills) +
    effortDirective(ctx.effort) +
    roleDirectiveFor(role)
  if (ctx.projectPreamble) system += `\n\n${ctx.projectPreamble}`
  if (ctx.overview) system += `\n\n## Project context\n${ctx.overview}`
  if (ctx.recap) {
    system +=
      `\n\n## Conversation so far\n${ctx.recap}\n\n` +
      'This is prior context to resolve references in your task ("it", "that", "the button" ' +
      'from an earlier turn) — not new work to do.'
  }
  const plan = readPlanMd()
  if (plan) system += `\n\n## Current plan.md\n${plan}`
  if (sharedContext?.trim()) {
    system +=
      `\n\n## What the team has established so far\n${sharedContext.trim()}\n\n` +
      'Build on this instead of rediscovering it. Do not redo work already reported here.'
  }
  system += `\n\n## Your assigned task\n${task}`
  return system
}

/**
 * `server → category` lookup for MCP capability scoping. Best-effort: an MCP
 * manager without a server list (or one that throws) yields an empty map, which
 * scopes every tool as `external` — visible only to roles with broad `mcp`
 * access. Never throws, so prompt assembly can't fail on this.
 */
function mcpServerCategories(): Map<string, McpCategory> {
  try {
    return serverCategoryMap(mcpManager.listServers())
  } catch {
    return new Map()
  }
}

interface ExecContext {
  runId: string
  permissionMode: PermissionMode
  handle: RunHandle
  emit: EventSink
  onTerminal: TerminalSink
  /**
   * The acting role's capabilities. When present, a tool kind the role isn't
   * granted is refused before any approval is asked for. Absent = unrestricted
   * (the lead).
   */
  capabilities?: readonly Capability[]
  /** Collector for successfully written project-relative paths. */
  filesWritten?: string[]
}

/**
 * The tools that flow through the approval pipeline: everything that produces a
 * `tool-request` / `tool-result` pair. `read_file` / `list_files` / `search_files`
 * ride the same rails as the side-effecting three — so the user sees what Sylor
 * looked at — but are auto-approved by `decideAuto` since they change nothing.
 * `edit_file` is staged as a `write_file` proposal (see {@link executeTool}), so
 * a surgical edit is still reviewed as a diff.
 */
type ExecutableTool = Extract<
  ParsedTool,
  {
    tool: 'write_file' | 'edit_file' | 'read_file' | 'list_files' | 'search_files' | 'run_command' | 'mcp_call'
  }
>

/**
 * Turns a parsed tool op into a proposal, requests a decision (auto-approved or
 * user-driven per the permission mode), and — if approved — executes it,
 * emitting the outcome as a `tool-result`. Errors become failed results, never
 * thrown, so one bad op doesn't abort the run. Returns the structured result so
 * the agent loop can feed it back to the model, or `null` if the run was aborted
 * while awaiting the user's decision.
 */
async function executeTool(tool: ExecutableTool, ctx: ExecContext): Promise<ToolResult | null> {
  const { runId, permissionMode, handle, emit, onTerminal } = ctx
  const id = nextToolId()

  // Build the proposal (resolving file diffs up front for write_file / edit_file).
  let proposal: ToolProposal
  try {
    if (tool.tool === 'write_file') {
      const { exists, oldContent, newContent } = proposeWrite(tool.path, tool.content)
      proposal = { id, kind: 'write_file', path: tool.path, oldContent, newContent, exists }
    } else if (tool.tool === 'edit_file') {
      // A surgical edit becomes an ordinary write_file proposal: the exact-string
      // replacement is resolved against the file's CURRENT contents here, so the
      // user still reviews a diff, the permission gate is unchanged, and every
      // downstream consumer (diff stats, filesWritten, auto-preview) keeps working.
      // A miss or an ambiguous match throws and lands in the catch below.
      const { oldContent, newContent } = applyEdit(
        tool.path,
        tool.oldString,
        tool.newString,
        tool.replaceAll
      )
      proposal = { id, kind: 'write_file', path: tool.path, oldContent, newContent, exists: true }
    } else if (tool.tool === 'read_file') {
      proposal = {
        id,
        kind: 'read',
        op: 'read_file',
        path: tool.path,
        offset: tool.offset,
        limit: tool.limit
      }
    } else if (tool.tool === 'list_files') {
      proposal = { id, kind: 'read', op: 'list_files', path: tool.path }
    } else if (tool.tool === 'search_files') {
      proposal = {
        id,
        kind: 'read',
        op: 'search_files',
        path: tool.path,
        query: tool.query,
        glob: tool.glob
      }
    } else if (tool.tool === 'run_command') {
      proposal = { id, kind: 'run_command', command: tool.command }
    } else {
      proposal = {
        id,
        kind: 'mcp_call',
        server: tool.server,
        name: tool.name,
        arguments: tool.arguments
      }
    }
  } catch (err) {
    // A sandbox (path-escape) violation, or an edit whose old_string didn't match.
    // Surface a proposal + failed result of the right shape so the UI shows what
    // was refused and the model is told precisely why, in its own terms.
    const failed = failedPreparation(id, tool, toErrorMessage(err))
    emit({ type: 'tool-request', runId, proposal: failed.proposal, auto: false })
    emit({ type: 'tool-result', runId, result: failed.result })
    return failed.result
  }

  const outcome = decideAuto(permissionMode, proposal.kind)

  // Capability gate (requirement: per-agent tool scoping). A scoped specialist may
  // only use the tool kinds its role holds — a reviewer that tries to rewrite the
  // feature gets a refusal fed back to it instead of silently mutating files. This
  // sits BEFORE the approval prompt so the user is never asked to approve
  // something the agent isn't allowed to do. The lead passes no capabilities and
  // is unrestricted.
  if (ctx.capabilities && !allowsTool(ctx.capabilities, proposal.kind)) {
    emit({ type: 'tool-request', runId, proposal, auto: false })
    const result = rejectedResult(
      proposal,
      `Not permitted for this agent's role (missing capability for ${proposal.kind}).`
    )
    emit({ type: 'tool-result', runId, result })
    return result
  }

  emit({ type: 'tool-request', runId, proposal, auto: outcome === 'auto' })

  const decision = outcome === 'auto' ? 'approve' : await awaitDecision(handle, id)
  if (handle.controller.signal.aborted) return null

  if (decision === 'reject') {
    const result = rejectedResult(proposal)
    emit({ type: 'tool-result', runId, result })
    return result
  }

  const result = await applyTool(proposal, onTerminal, handle.controller.signal)
  // Record what actually landed on disk, so the orchestrator can attribute files
  // to the task node that changed them (and decide whether to verify at all).
  if (
    ctx.filesWritten &&
    proposal.kind === 'write_file' &&
    result.kind === 'write_file' &&
    result.ok
  ) {
    if (!ctx.filesWritten.includes(proposal.path)) ctx.filesWritten.push(proposal.path)
  }
  // Check the bytes that just landed, before the model moves on. The project-level
  // verify (typecheck/lint/build) runs once at the end of an orchestrated turn and
  // needs npm scripts to exist at all; this catches the silent breakage — broken
  // JSON, a truncated file, a dead asset or import — immediately, for any project,
  // and hands it back through `summarizeResults` so the next iteration fixes it.
  // `newContent` is the final text even for an `edit_file` (desugared above).
  if (proposal.kind === 'write_file' && result.kind === 'write_file' && result.ok) {
    const issues = verifyWrittenFile(proposal.path, proposal.newContent)
    if (issues.length > 0) result.issues = issues.map((issue) => issue.message)
  }
  emit({ type: 'tool-result', runId, result })
  return result
}

/** Blocks until the renderer resolves the decision for `toolId` (or run aborts). */
function awaitDecision(handle: RunHandle, toolId: string): Promise<ToolDecision> {
  return new Promise((resolve) => {
    handle.pending.set(toolId, {
      resolve: (decision) => {
        handle.pending.delete(toolId)
        resolve(decision)
      }
    })
  })
}

/**
 * A proposal + matching failed result for a tool that couldn't even be *prepared*
 * — a path-escape, or an `edit_file` whose `old_string` didn't match. Kept in one
 * place so the emitted pair always agrees in `kind`: the renderer switches on the
 * result's kind, so a read that failed must NOT come back shaped like a write.
 */
function failedPreparation(
  id: string,
  tool: ExecutableTool,
  error: string
): { proposal: ToolProposal; result: ToolResult } {
  if (tool.tool === 'read_file' || tool.tool === 'list_files' || tool.tool === 'search_files') {
    return {
      proposal: {
        id,
        kind: 'read',
        op: tool.tool,
        path: tool.path,
        query: tool.tool === 'search_files' ? tool.query : undefined
      },
      result: { id, kind: 'read', ok: false, output: '', truncated: false, summary: 'failed', error }
    }
  }
  const path = tool.tool === 'write_file' || tool.tool === 'edit_file' ? tool.path : ''
  return {
    proposal: { id, kind: 'write_file', path, oldContent: '', newContent: '', exists: false },
    result: { id, kind: 'write_file', ok: false, error }
  }
}

/** A rejected (or refused) proposal's skipped result, with the reason shown. */
function rejectedResult(proposal: ToolProposal, reason = 'Skipped by user'): ToolResult {
  if (proposal.kind === 'write_file') {
    return { id: proposal.id, kind: 'write_file', ok: false, error: reason }
  }
  if (proposal.kind === 'read') {
    return {
      id: proposal.id,
      kind: 'read',
      ok: false,
      output: '',
      truncated: false,
      summary: 'skipped',
      error: reason
    }
  }
  if (proposal.kind === 'mcp_call') {
    return {
      id: proposal.id,
      kind: 'mcp_call',
      ok: false,
      output: '',
      truncated: false,
      error: reason
    }
  }
  return { id: proposal.id, kind: 'run_command', exitCode: null, output: reason, truncated: false }
}

/** Executes an approved proposal, returning its structured outcome. */
async function applyTool(
  proposal: ToolProposal,
  onTerminal: TerminalSink,
  signal: AbortSignal
): Promise<ToolResult> {
  if (proposal.kind === 'write_file') {
    try {
      writeProjectFile(proposal.path, proposal.newContent)
      return { id: proposal.id, kind: 'write_file', ok: true }
    } catch (err) {
      return { id: proposal.id, kind: 'write_file', ok: false, error: toErrorMessage(err) }
    }
  }

  // read — inspect the project and hand the text back to the model. Reads are the
  // only tool kind whose *output* is the whole point, so unlike a write they echo
  // real content into the next turn (bounded by fs/operations' caps).
  if (proposal.kind === 'read') {
    try {
      const outcome =
        proposal.op === 'read_file'
          ? readFileSlice(proposal.path, proposal.offset, proposal.limit)
          : proposal.op === 'list_files'
            ? listDirectory(proposal.path)
            : searchProject(proposal.query ?? '', proposal.path, proposal.glob)
      return {
        id: proposal.id,
        kind: 'read',
        ok: true,
        output: outcome.output,
        truncated: outcome.truncated,
        summary: outcome.summary
      }
    } catch (err) {
      return {
        id: proposal.id,
        kind: 'read',
        ok: false,
        output: '',
        truncated: false,
        summary: 'failed',
        error: toErrorMessage(err)
      }
    }
  }

  // mcp_call — dispatch to the connected server via the manager. The manager
  // never throws (missing server, disconnected, or tool error all come back as
  // an outcome), and enforces its own call timeout, so no abort plumbing here.
  if (proposal.kind === 'mcp_call') {
    onTerminal(`\r\n\x1b[38;5;208m⚙ ${proposal.server}/${proposal.name}\x1b[0m\r\n`)
    const outcome = await mcpManager.callTool(proposal.server, proposal.name, proposal.arguments)
    if (outcome.ok) {
      onTerminal(`\x1b[32m✓ ${proposal.server}/${proposal.name}\x1b[0m\r\n`)
    } else {
      onTerminal(`\x1b[31m${outcome.error ?? 'MCP call failed.'}\x1b[0m\r\n`)
    }
    return {
      id: proposal.id,
      kind: 'mcp_call',
      ok: outcome.ok,
      output: outcome.output,
      truncated: outcome.truncated,
      error: outcome.error
    }
  }

  // run_command
  onTerminal(`\r\n\x1b[38;5;208m$ ${proposal.command}\x1b[0m\r\n`)

  // A dev server never exits, so the blocking one-shot runner would hang this
  // turn forever — no tool-result, no live preview. Route it to the preview
  // subsystem's own managed pty, which scrapes the localhost URL and drives the
  // right-side panel, then return promptly with that URL so the agent loop can
  // continue. The dev server intentionally outlives the turn (it keeps the
  // preview live); stopPreview tears it down on close/shutdown.
  if (looksLikeDevServer(proposal.command)) {
    const started = await startDev(proposal.command)
    if (started.ok && started.url) {
      onTerminal(`\x1b[32m✓ Live preview started at ${started.url}\x1b[0m\r\n`)
      return {
        id: proposal.id,
        kind: 'run_command',
        exitCode: 0,
        output: `Live preview started at ${started.url}`,
        truncated: false
      }
    }
    const message = started.error ?? 'Dev server failed to start.'
    onTerminal(`\x1b[31m${message}\x1b[0m\r\n`)
    return { id: proposal.id, kind: 'run_command', exitCode: 1, output: message, truncated: false }
  }

  const { exitCode, output, truncated } = await runCommand(proposal.command, onTerminal, signal)
  return { id: proposal.id, kind: 'run_command', exitCode, output, truncated }
}

/** Last path segment of a POSIX-relative path (its basename), for compact labels. */
function baseName(path: string): string {
  const i = path.lastIndexOf('/')
  return i >= 0 ? path.slice(i + 1) : path
}

/**
 * A short, human label for the files being read — the first few basenames plus a
 * "+N more" tail — so the live "Reading…" status names real files (requirement
 * #3) rather than a bare count. Purely cosmetic: drawn from the already-built
 * file index, never the file contents.
 */
function describeFiles(files: string[]): string {
  const names = files.map(baseName).filter(Boolean)
  const head = names.slice(0, 3).join(', ')
  const rest = names.length - 3
  const label = rest > 0 ? `${head} +${rest} more` : head
  return `${label} (${files.length} file${files.length === 1 ? '' : 's'})`
}

/** Matches a command that is clearly a verification/build step, not a mutation. */
const VERIFY_RE = /\b(tests?|vitest|jest|typecheck|tsc|lint|eslint|build|check)\b/i

/**
 * Picks the phase + label for a batch of side-effecting tools about to run, so the
 * timeline shows a real, contextual step (requirement #2/#3): a command batch
 * that's clearly a check (test/build/lint/typecheck) reads as the `verifying`
 * phase; otherwise it's `executing`, with the concrete files or command named.
 * Exactly one status per batch — the per-tool cards carry the detail — so the
 * engine's status stream stays single-emission per step.
 */
function describeBatch(tools: ExecutableTool[]): { stage: WorkflowStage; message: string } {
  const commands = tools.filter(
    (t): t is Extract<ExecutableTool, { tool: 'run_command' }> => t.tool === 'run_command'
  )
  const writes = tools.filter(
    (t): t is Extract<ExecutableTool, { tool: 'write_file' | 'edit_file' }> =>
      t.tool === 'write_file' || t.tool === 'edit_file'
  )
  const reads = tools.filter(
    (t): t is Extract<ExecutableTool, { tool: 'read_file' | 'list_files' | 'search_files' }> =>
      t.tool === 'read_file' || t.tool === 'list_files' || t.tool === 'search_files'
  )
  const firstCmd = (): string => commands[0].command.trim().split(/\s+/).slice(0, 3).join(' ')

  // Pure inspection → the reading phase, naming what's being looked at. This is
  // the status the user sees while Sylor is orienting itself in their code.
  if (reads.length > 0 && commands.length === 0 && writes.length === 0) {
    const search = reads.find((r) => r.tool === 'search_files')
    if (search && search.tool === 'search_files') {
      return { stage: 'scanning', message: `Searching for "${search.query}"` }
    }
    const files = reads.filter((r) => r.tool === 'read_file').map((r) => baseName(r.path))
    if (files.length > 0) {
      const head = files.slice(0, 2).join(', ')
      const rest = files.length - 2
      return { stage: 'reading', message: `Reading ${rest > 0 ? `${head} +${rest} more` : head}` }
    }
    return { stage: 'scanning', message: 'Looking through the project…' }
  }

  // A command batch that's purely checks/builds → the verifying phase.
  if (
    commands.length > 0 &&
    writes.length === 0 &&
    commands.every((c) => VERIFY_RE.test(c.command))
  ) {
    return {
      stage: 'verifying',
      message:
        commands.length === 1
          ? `Verifying · ${firstCmd()}`
          : `Verifying · ${commands.length} checks`
    }
  }
  // Pure writes → name the files being edited/created.
  if (writes.length > 0 && commands.length === 0) {
    const names = writes.map((w) => baseName(w.path))
    const head = names.slice(0, 2).join(', ')
    const rest = names.length - 2
    return { stage: 'executing', message: `Editing ${rest > 0 ? `${head} +${rest} more` : head}` }
  }
  // Pure commands (not all checks) → name the command.
  if (commands.length > 0 && writes.length === 0) {
    return {
      stage: 'executing',
      message:
        commands.length === 1 ? `Running ${firstCmd()}` : `Running ${commands.length} commands`
    }
  }
  // Mixed / MCP batch → a generic apply.
  return { stage: 'executing', message: 'Applying changes…' }
}

/**
 * Builds the synthesized user turn fed back to the model after a round of tool
 * execution, so the next loop iteration can react to what actually happened.
 * Provider-agnostic plain text (works across Ollama/Gateway).
 *
 * Writes report only their path and outcome — a write's content is already in the
 * model's own message. A `read` deliberately DOES echo its output, since that text
 * is the entire point of having asked; `fs/operations` caps each read, and command
 * output is bounded by the runner, so the context window still can't blow up.
 */
function summarizeResults(outcomes: Array<{ tool: ExecutableTool; result: ToolResult }>): string {
  /** True when a write landed but its static check found something broken. */
  let broken = false
  const lines = outcomes.map(({ tool, result }) => {
    if (result.kind === 'write_file') {
      // An edit_file was staged as a write_file, so name the verb the model used.
      const verb = tool.tool === 'edit_file' ? 'edit_file' : 'write_file'
      const path = tool.tool === 'write_file' || tool.tool === 'edit_file' ? tool.path : ''
      const head = `${verb} ${path} → ${result.ok ? 'applied' : (result.error ?? 'failed')}`
      // A successful write that failed its static check reports both: the file IS
      // on disk, and here is what's wrong with it. Silence means nothing was
      // detected — never a claim that the file is correct.
      const check = describeIssues(result.issues ?? [])
      if (check) broken = true
      return check ? `${head}\n${check}` : head
    }
    if (result.kind === 'read') {
      const label =
        tool.tool === 'search_files'
          ? `search_files "${tool.query}" in ${tool.path}`
          : tool.tool === 'read_file' || tool.tool === 'list_files'
            ? `${tool.tool} ${tool.path}`
            : 'read'
      if (!result.ok) return `${label} → error: ${result.error ?? 'failed'}`
      const truncNote = result.truncated ? ' — truncated, ask for a narrower range if you need more' : ''
      return `${label} → ${result.summary}${truncNote}\n${result.output}`
    }
    if (result.kind === 'mcp_call') {
      const label = tool.tool === 'mcp_call' ? `${tool.server}/${tool.name}` : ''
      if (!result.ok) return `mcp_call ${label} → error: ${result.error ?? 'failed'}`
      const truncNote = result.truncated ? ' (output truncated)' : ''
      return `mcp_call ${label} → ok${truncNote}\noutput:\n${result.output.trim()}`
    }
    // run_command — a null exit code means the user skipped it (it never ran).
    const command = tool.tool === 'run_command' ? tool.command : ''
    if (result.exitCode === null) {
      return `run_command ${command} → ${result.output.trim() || 'not run'}`
    }
    const truncNote = result.truncated ? ' (output truncated)' : ''
    return `run_command ${command} → exit ${result.exitCode}${truncNote}\noutput:\n${result.output.trim()}`
  })
  return (
    'Results of the actions you just proposed:\n\n' +
    lines.join('\n\n') +
    (broken
      ? // A file with a detected defect is not done, whatever the model believes.
        // Naming that here is what closes the write → check → fix loop, instead of
        // leaving the user to discover it as a blank page.
        '\n\nOne or more files you just wrote are broken as written. Fix them now — ' +
        'read the file if you need to see its current state, then correct it with a ' +
        'tool block. Do not give your final answer while a detected problem remains.'
      : '\n\nIf these results complete the task, give your final answer to the user now. ' +
        'If a command failed or work remains, take the NEXT SINGLE step: open with ONE short ' +
        'line telling the user what just landed and what you are doing next, then ONE tool ' +
        'block — and stop there so it can run before you continue. Never reply with a block ' +
        'alone (from the outside that looks like nothing is happening), and never stack several ' +
        'files into one message.')
  )
}

/**
 * Resolves the model's `use_skill` requests against the enabled skills, producing
 * the text fed back so the next loop iteration follows the chosen skill(s), plus
 * the names newly activated this turn (for a user-facing note). A skill's full
 * SKILL.md body is injected only the first time it's activated in a turn (tracked
 * in `activated`, which this mutates); re-requesting an active skill yields a
 * short reminder instead of re-injecting the whole body, and an unknown or
 * disabled name yields a note listing what's actually available — so a typo can't
 * silently do nothing. `text` is '' when no request resolved to anything.
 */
function buildSkillInjections(
  requests: Array<Extract<ParsedTool, { tool: 'use_skill' }>>,
  enabled: SkillInfo[],
  activated: Set<string>
): { text: string; activatedNow: string[] } {
  const blocks: string[] = []
  const activatedNow: string[] = []
  for (const req of requests) {
    const name = req.name.trim()
    const skill = enabled.find((s) => s.name === name)
    if (!skill) {
      const available = enabled.map((s) => s.name).join(', ') || '(none)'
      blocks.push(`Skill "${name}" is not available. Enabled skills: ${available}.`)
      continue
    }
    if (activated.has(skill.name)) {
      blocks.push(
        `Skill "${skill.name}" is already active — follow its instructions from earlier this turn; do not invoke it again.`
      )
      continue
    }
    activated.add(skill.name)
    activatedNow.push(skill.name)
    blocks.push(
      `Skill "${skill.name}" is now active. Follow these instructions for the rest of this task:\n\n${skill.instructions}`
    )
  }
  return { text: blocks.join('\n\n'), activatedNow }
}

/**
 * Resolves a pending tool decision from the renderer. No-op if the run or tool
 * is unknown (e.g. a late click after cancel).
 */
export function resolveToolDecision(runId: string, toolId: string, decision: ToolDecision): void {
  activeRuns.get(runId)?.pending.get(toolId)?.resolve(decision)
}

/** Cancels an in-flight run by id (no-op if unknown). */
export function cancelWorkflow(runId: string): void {
  const handle = activeRuns.get(runId)
  if (!handle) return
  handle.controller.abort()
  // Unblock any awaiting tool decisions so the run can unwind promptly.
  for (const p of handle.pending.values()) p.resolve('reject')
  handle.pending.clear()
  activeRuns.delete(runId)
}

/** Aborts every in-flight run. Called on app shutdown. */
export function cancelAllWorkflows(): void {
  for (const handle of activeRuns.values()) {
    handle.controller.abort()
    for (const p of handle.pending.values()) p.resolve('reject')
    handle.pending.clear()
  }
  activeRuns.clear()
}

/**
 * Assembles the outbound message list: system prompt (+ per-project instructions
 * and + project file overview when present) followed by the conversation history.
 * Project instructions come before the read-only file overview so the user's
 * standing guidance frames how the model reads and acts on the code.
 */
function buildMessages(
  history: ChatMessage[],
  overview: string,
  projectPreamble: string,
  effort: ReasoningEffort,
  intentKind: IntentKind,
  planFirst: boolean,
  mcpTools: McpToolInfo[],
  skills: SkillInfo[]
): ChatMessage[] {
  let system =
    SYSTEM_PROMPT +
    shellDirective() +
    mcpDirective(mcpTools) +
    skillsDirective(skills) +
    spawnDirective() +
    effortDirective(effort) +
    intentDirective(intentKind) +
    planDirective(planFirst, intentKind)
  if (projectPreamble) system += `\n\n${projectPreamble}`
  if (overview) system += `\n\n## Project context\n${overview}`
  return [{ role: 'system', content: system }, ...history]
}

/**
 * Builds the per-project preamble (custom instructions + knowledge docs) for a
 * chat filed under a project. Returns '' when there's no project, it's unknown,
 * or it carries no guidance. Reads only the local DB — no new file access, so
 * the sandbox boundary is untouched. Never throws (persistence is best-effort).
 */
function buildProjectPreamble(projectId: string | null): string {
  if (!projectId) return ''
  try {
    const project = getProject(projectId)
    if (!project) return ''
    const parts: string[] = []
    const instructions = project.instructions.trim()
    if (instructions) {
      parts.push(`## Project instructions (from "${project.name}")\n${instructions}`)
    }
    const knowledge = listProjectKnowledge(projectId)
    for (const doc of knowledge) {
      const content = doc.content.trim()
      if (content) parts.push(`## Project knowledge: ${doc.name}\n${content}`)
    }
    const memory = project.memory.trim()
    if (memory) {
      parts.push(
        `## Project memory (things you learned in earlier chats on "${project.name}")\n${memory}`
      )
    }
    return parts.join('\n\n')
  } catch (err) {
    console.error('[sylor] failed to load project context:', err)
    return ''
  }
}

/**
 * Appends Sylor's `remember` notes to the active project's long-term memory and
 * confirms each as a `delta` so the user sees what was recorded. Memory is
 * per-project, so with no active project it emits a single note explaining the
 * facts weren't saved. DB-only and best-effort: a persistence failure is logged,
 * never thrown, and never aborts the turn.
 */
function recordMemory(
  notes: Array<Extract<ParsedTool, { tool: 'remember' }>>,
  projectId: string | null,
  runId: string,
  emit: EventSink
): void {
  if (!projectId) {
    emit({
      type: 'delta',
      runId,
      text: '\n\n🧠 (Open this chat under a project to save notes to its long-term memory.)'
    })
    return
  }
  for (const note of notes) {
    try {
      appendProjectMemory(projectId, note.note, Date.now())
      emit({ type: 'delta', runId, text: `\n\n🧠 Noted to project memory: ${note.note.trim()}` })
    } catch (err) {
      console.error('[sylor] failed to append project memory:', err)
    }
  }
}
