import type {
  AgentRole,
  ChatImage,
  ChatMessage,
  CompletionOptions,
  ContextUsage,
  HookEvent,
  IntentKind,
  McpCategory,
  McpToolInfo,
  PermissionMode,
  PreviewInspectResponse,
  ReasoningEffort,
  SkillInfo,
  TaskNode,
  ToolDecision,
  ToolDecisionDetail,
  ToolKind,
  ToolProposal,
  ToolResult,
  WorkflowEvent,
  WorkflowRunRequest,
  WorkflowStage
} from '../../shared/types'
import { standingApprovalKey, standingApprovalNote } from '../../shared/approvals'
import { contextWindowFor } from '../../shared/context-window'
import { providerFromSettings, type Provider } from '../providers'
import { toErrorMessage } from '../providers/http'
import {
  getSettings,
  isSkillEnabled,
  getUserProfileForPrompt,
  appendUserProfile,
  fullAccessEnabled,
  autoSendEnabled
} from '../settings'
import { contextManager } from '../context/manager'
import { buildInstructionsPreamble } from '../context/instructions'
import { buildAuditInventory } from '../context/projectAudit'
import {
  activePlanPath,
  buildMemoryPreamble,
  isPlaceholder,
  memoryDocPath,
  readMemoryDoc,
  scaffoldMemory
} from '../context/projectMemory'
import {
  appendDecision,
  appendFollowup,
  archivePlan as archiveActivePlan,
  readProjectState,
  updateProjectState,
  writeSessionCheckpoint
} from '../context/projectState'
import {
  applyEdits,
  findFiles,
  listDirectory,
  proposeWrite,
  readFileSlice,
  readMediaFile,
  readProjectFile,
  searchProject,
  writeProjectFile
} from '../fs/operations'
import { describeIssues, recheckWrittenFile, verifyWrittenFile } from '../fs/verify'
import { appendProjectMemory, getProject, listProjectKnowledge } from '../db/projects'
import { runCommand } from '../terminal/runner'
import {
  devServerLogs,
  looksLikeDevServer,
  notePreviewRuntimeError,
  previewHealth,
  startDev
} from '../preview/server'
import { requestPreviewInspect } from '../preview/inspect'
import { classifyBrowse, describeBrowse, runBrowserAction } from '../browser/runner'
import { fetchUrl } from '../web/fetch'
import { searchWeb } from '../web/search'
import {
  availableCheckers,
  realDiagnosticsDeps,
  runDiagnostics,
  scopeFor
} from '../diagnostics/run'
import { mcpManager } from '../mcp/manager'
import { skillsRegistry } from '../skills/registry'
import { mergeSkillCatalog } from '../skills/catalog'
import { commandsRegistry } from '../commands/registry'
import { installPlugin } from '../plugins/installer'
import { classifyIntent } from './intent'
import { decideAuto, decideBrowse, type PermissionOutcome } from './permission'
import { ToolStreamParser, parseToolBlock, type ParsedTool } from './toolStream'
import { ReasoningStripper, stripReasoningTags } from './reasoning'
import { isAbort, withRetry, type RetryNotice } from './resilience'
import { writingProgress } from './writingProgress'
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
  type PlanDecision,
  type PlanProposal,
  type VerifyOutcome
} from './orchestrator/orchestrator'
import type { MemoryPort } from './orchestrator/staging'
import { classifyComplexity } from './orchestrator/complexity'
import { createWorktree, finalizeWorktree, type WorktreeHandle } from './worktree'
import { createCheckpoint } from '../checkpoint/checkpoints'
import { runHooks, type HookCommandRunner } from './hooks'
import {
  hasCompleteRead,
  servedFromReadCache,
  updateReadCache,
  type ReadCacheEntry
} from './readCache'
import {
  findingsNudge,
  isGatherTool,
  planReadWindow,
  stopGatheringNudge
} from './gather'

/** Sink the engine emits events to (wired to IPC in workflow-ipc.ts). */
export type EventSink = (event: WorkflowEvent) => void

/** Sink for live command output (wired to the terminal pane in workflow-ipc.ts). */
export type TerminalSink = (data: string) => void

/**
 * The shared BROWSE THE WEB teaching block.
 *
 * Both prompts — Code and Cowork — interpolate this exact text, so the browse
 * protocol the model learns cannot drift between the two modes (in Cowork it is
 * the *only* tool, in Code it sits alongside the file/command ones).
 *
 * The rules are carried over from the standalone browser agent loop, which is where
 * they were proven in practice: one action per message, work from the numbered
 * elements of the last read rather than re-reading, never type a credential, and
 * stop once a scroll stops revealing anything new.
 */
const BROWSE_BLOCK = `BROWSE THE WEB — you have a real browser on screen, use it like a person would:
- The browser sits beside the chat and the user watches every step. It drives either the
  in-app page view or the user's own Chrome (whichever they picked), so the sites they are
  already signed into work.
- web_fetch only downloads a URL's text. Use browse whenever you must actually USE a site:
  click, type, search inside it, page through it, or see what the user sees.

\`\`\`sylor-tool
{ "tool": "browse", "action": "navigate", "url": "https://news.ycombinator.com" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "browse", "action": "read" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "browse", "action": "click", "target": "#12" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "browse", "action": "type", "target": "Search", "text": "electron webcontentsview", "submit": true }
\`\`\`

\`\`\`sylor-tool
{ "tool": "browse", "action": "scroll", "direction": "down" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "browse", "action": "console", "level": "error" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "browse", "action": "network", "filter": "failed" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "browse", "action": "inspect", "selector": ".hero h1", "styles": ["line-height"] }
\`\`\`
- The actions: "navigate" (open a URL — a bare word or phrase becomes a web search), "read"
  (the page's text plus a NUMBERED list of every link, button and field on it), "click",
  "type" ("text" into a field; add "submit": true to press Enter), and "scroll"
  ("direction": "up"/"down"). Add "visual": true to a "read" to also SEE a picture of the
  page — reach for that when the layout or an image matters, not by default.
- To DEBUG a page rather than drive it: "console" (its console messages and uncaught
  errors; "level": "error"/"warn"/"all"), "network" (the requests it made with their
  status and timing; "filter": "failed"/"all") and "inspect" ("selector" — one element's
  box, text and COMPUTED styles). Use them to find out why a page misbehaves instead of
  guessing from what it renders; recording starts when Sylor first touches the page, so
  read the console AFTER the click that misbehaved, not before.
- "target" is how you point at something: the NUMBER from the last read ("#12" — always
  prefer this, it is exact) or the element's visible label ("Sign in").
- Every browse block ENDS your message, like any other action: one short line, the single
  block, stop. The app reports what happened and only then do you continue.
- You do NOT need a separate read after acting — a navigate/click/type/scroll already returns
  the page it landed on. Work from that observation; re-reading an unchanged page wastes a step.
- Keep going until the goal is actually met. If the user asked for several things, do every
  one of them. If there is more below, scroll — but when a scroll reveals nothing new you have
  reached the end, so stop scrolling and answer.
- SAFETY: never type a password, card number, verification code or any other credential —
  those fields are refused, and if a site demands a sign-in, say so and let the user do it
  themselves. Anything that pays, orders or subscribes is refused outright; a click that
  sends, posts, publishes or deletes needs the user's approval first, so expect to wait.
- Finish by TELLING THE USER what you found, in your own words. The page text is context for
  you, not the answer — never paste the raw dump back at them.`

/**
 * The project-memory + inspection-discipline block of the system prompt. Its job is
 * to kill the `READ → SEARCH → READ → SEARCH` loop: a project's understanding is
 * written down once (see `context/projectMemory.ts`) and re-injected every run, so
 * rediscovering it is wasted budget. Deliberately directory-agnostic — the per-run
 * memory preamble names the actual folder (`.claude/` or `.sylor/`) and carries the
 * documents themselves.
 */
const MEMORY_BLOCK = `PROJECT MEMORY — understand once, then remember:
- This project keeps its understanding in a small set of markdown documents — PROJECT.md
  (what is being built), ARCHITECTURE.md (how), FILEMAP.md (what each file is responsible
  for), CONVENTIONS.md, DECISIONS.md, STATE.md (where the work stands) and TASKS.md — inside
  its agent-memory folder. When they exist they are handed to you below: read them, trust
  them, and do NOT rediscover what they already tell you.
- Before every read_file / list_files / search_files / find_files, ask: do I actually need
  this for the task in front of me, and is it already in memory? Opening a file to learn what
  it is for, re-listing a directory you have already seen, or re-searching a fact you were
  already given is wasted work — and a READ → SEARCH → READ → SEARCH loop is exactly how a
  turn ends with nothing built. Inspect what you are about to change; skip the rest — and
  open all of it in the ONE gathering step, never a file per step.
- When something errors, do NOT restart discovery. Name the actual error, inspect the
  smallest scope it implicates, fix the root cause, verify it, and carry on.
- Keep the documents true as you go: the file map when files appear, disappear or change
  job; STATE.md and TASKS.md as work lands; ARCHITECTURE.md when the shape changes; and
  DECISIONS.md when you make a call worth remembering, with its reason. A section that is
  still a bare heading is one you are expected to fill in — do it as you learn the answer,
  not at the very end. Stale or absent memory means the next session pays for this one.`

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
{ "tool": "write_file", "path": "relative/path.ts", "content": "<full new file contents>", "purpose": "<what this file is for, one short phrase>" }
\`\`\`

or

\`\`\`sylor-tool
{ "tool": "run_command", "command": "npm test" }
\`\`\`

YOU CAN LOOK AT THE PROJECT — DO IT BEFORE YOU CHANGE ANYTHING:

\`\`\`sylor-tool
{ "tool": "read_file", "path": "src/App.tsx", "purpose": "to find where the layout wraps the page" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "list_files", "path": "src/components" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "search_files", "query": "useAuth", "path": "src", "glob": "*.ts" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "find_files", "glob": "**/*.test.ts" }
\`\`\`

These four only LOOK — they change nothing, so they run immediately without asking the
user, and (unlike an action) you MUST emit them together in ONE message: see GATHERING
below. Each takes an optional "purpose" — a half-sentence on what you are trying to find
out; it is a note for you, not shown to the user, who simply sees "Reading <filename>" as
each file opens. Keep it short or omit it.

read_file gives you the WHOLE file. Do not pass "offset" or "limit" — you cannot know which
lines matter before you have seen the file, and a 60-line window is never enough to edit
against. If a file is genuinely too large for one read, the result says exactly where it
stopped and which "offset" to continue from; that — continuing through a file you have
already started — is the only time an "offset" belongs in a read_file block. Pointed at an
image ("png"/"jpg"/"gif"/"webp"), read_file hands you the picture itself to SEE, not its raw
bytes. search_files takes a regular expression; "path" and "glob" are optional filters; add
"before"/"after"/"context" for N lines around each hit (like grep -B/-A/-C), "multiline":
true for a pattern that spans lines, or "mode": "files" (just the matching paths) / "count"
(per-file tallies) instead of the default matching lines. find_files lists files by a
name/path glob (\`**\` across folders, \`*\` within one, \`{a,b}\` alternatives) — use it to
locate files by name when search_files (which greps CONTENTS) is the wrong tool.

GATHERING — look once, then say what you found:
- Work out everything you need to see, and open it ALL in ONE message: every file, in full,
  in a single batch of read-only blocks. One reading step, not five.
- NEVER open the same file twice. Its whole text stays in this conversation, word for word;
  re-reading it tells you nothing you do not already have, and you will be told so.
- Then, before you touch anything, send ONE message with no tool block: what you read, what
  you actually found — the real problem and exactly where it lives (file, and the line or
  the class/symbol) — every problem if there are several, and how you are going to fix it as
  concrete steps in order. That message is what the user is waiting for; a wall of file
  cards followed by a silent edit is not.
- Then take the first step. If something you never read turns out to be needed, read it in
  the SAME message as your next action — never as a step of its own.

When a task genuinely needs the outside world — reading a doc page, an API reference, or
the text of an error — fetch a URL:

\`\`\`sylor-tool
{ "tool": "web_fetch", "url": "https://example.com/docs" }
\`\`\`

web_fetch reaches the network, so unlike the read-only blocks it IS an action: it needs the
user's approval, ENDS your message (one per message, like any action), and returns the
page's readable text. Only http/https URLs work, and internal/loopback addresses are
refused. Sylor works offline — reach for web_fetch only when the answer isn't already in the
project or your own knowledge, not as a first move.

When you don't already have a URL, SEARCH the web to find current, real sources:

\`\`\`sylor-tool
{ "tool": "web_search", "query": "vite configure base path for subdirectory deploy" }
\`\`\`

web_search returns a ranked list of results (title, URL, and a snippet each). Like web_fetch
it reaches the network, so it IS an action: it needs approval and ENDS your message. The
normal flow is search → pick the best result → web_fetch that URL to read it in full. Prefer
primary sources (official docs, the project's own repo) over blog summaries.

To change part of an existing file, replace exact pieces of it — do NOT rewrite the
whole file. Read the file once (in full), work out EVERY change it needs, then make them
ALL in a single edit_file with an "edits" list, applied in order:

\`\`\`sylor-tool
{ "tool": "edit_file", "path": "src/App.tsx", "edits": [
  { "old_string": "<exact text to replace>", "new_string": "<replacement>" },
  { "old_string": "<another exact snippet>", "new_string": "<replacement>" }
], "purpose": "<what these changes are for>" }
\`\`\`

For a single change you may pass "old_string"/"new_string" directly instead of an "edits"
list — but never split several edits to the SAME file across several messages.

Rules that matter more than any others when working on code that already exists:
- NEVER edit a file you have not read this turn. Guessing at contents you haven't seen
  destroys the user's work. read_file first, then edit.
- Prefer edit_file over write_file for any file that already exists. write_file replaces
  the ENTIRE file, so using it on a real file silently deletes everything you forgot to
  reproduce. Use write_file for NEW files (and for a rewrite the user actually asked for).
- One consolidated edit per file. When a file needs several changes, do not edit it, wait
  for the result, then edit it again — put every change in ONE edit_file's "edits" list.
  Small repeated edits to the same file are slow and error-prone; one pass is not.
- Each "old_string" (in the list or on its own) must match the file byte for byte,
  including indentation, and must be unique. Include a few surrounding lines if the snippet
  appears more than once, or set "replace_all": true to change every occurrence. Edits
  apply in order, so a later one may target text an earlier one just introduced.
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

You ALSO have a global memory ABOUT THE USER that follows them across every
project — this is how you get more useful the more you work together. When you
learn something durable about the person themselves — their name, how they like
to work, the kind of sites or apps they build, and the visual style, typography,
layout, or tone they gravitate to — record it with:

\`\`\`sylor-tool
{ "tool": "remember_user", "note": "<one concise fact about the user or their taste>" }
\`\`\`

Prefer their remembered taste by default so you don't have to ask again, and
record a new preference the moment they express one ("I like clean minimal
sites", "use a serif for headings", "call me Arafat"). Keep each note short and
durable; never store secrets, keys, or one-off details.

When the user asks you to INSTALL a skill, plugin, or connector from somewhere — e.g.
"Sylor, install this skill https://github.com/acme/cool-skills", "install owner/repo", or
"add this plugin <folder>" — do it with:

\`\`\`sylor-tool
{ "tool": "install_plugin", "source": "owner/repo", "scope": "global" }
\`\`\`

"source" is exactly what they gave you: a GitHub \`owner/repo\`, a full git URL, a
\`github:owner/repo\` shorthand, or a local folder path. "scope" is "global" (usable in every
project — the default, and what to use unless they say otherwise) or "project" (only the open
folder). Like web_fetch this reaches outside the app (a git clone) and writes to disk, so it
needs approval and ENDS your message. Sylor clones the source, adds every skill / command /
connector it bundles, and reports what it installed — you never hand-write those files
yourself. After it lands, the new skills are available immediately and any \`/command\` it added
can be used from the composer.

Rules for tool blocks:
- ONE ACTION PER MESSAGE. A write_file, edit_file, run_command, web_fetch, web_search, install_plugin,
  diagnostics, or mcp_call block ENDS your message: say one short line, emit that single block, and
  stop. The app runs it and reports back, and only THEN do you continue. Anything you write after an
  action block is discarded unseen — so never stack a second file, a summary, or "next I'll…" behind it.
  (Read-only blocks are the sole exception, and for them the opposite rule applies: put ALL the
  read_file / list_files / search_files / find_files you need in the SAME message — one gathering
  step — instead of one file per step. See GATHERING above.)
- ALWAYS include "purpose" on a write_file or edit_file block: one short phrase for what
  that file is FOR ("the login endpoint the dashboard calls", "shared Button used by every
  page"), not what you did to it ("created a file"). It is shown to the user next to the
  file, so they can tell why each file exists long after the conversation has scrolled past.
  On a read-only block "purpose" is optional (a note for you) — the user only sees
  "Reading <filename>".
- To create or change several files, emit them one per message across several steps — file,
  result, next file — never many at once.
- One JSON object per block.
- Use ONLY project-relative paths (never absolute, never "..").
- For write_file, "content" MUST be the complete new file, not a diff or a fragment.
- For remember (and remember_user), "note" is a single short fact (not a whole
  conversation). Only record things that stay true across chats; never secrets, keys,
  or one-off details. remember is scoped to THIS project; remember_user is about the
  person and applies everywhere.
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
- For a multi-file project, build it ONE FILE AT A TIME: say briefly what this file is and
  what it is for, emit the single write_file block for it, and after the app reports it
  applied, move to the next file. Do not dump the whole project in one message — that is the
  opposite of what's wanted.
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

VERIFY IN THE PREVIEW — don't just claim it works, SEE that it works:
- Once the preview is on screen, you can inspect and drive it to confirm a UI change actually
  landed, the same way a developer would open devtools. Use one action per message (it ENDS
  the message like any action) and read the result back before deciding what's next:

\`\`\`sylor-tool
{ "tool": "preview_inspect", "action": "screenshot" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "preview_inspect", "action": "snapshot" }
\`\`\`

\`\`\`sylor-tool
{ "tool": "preview_inspect", "action": "inspect", "selector": ".cta", "styles": ["color", "background-color"] }
\`\`\`

\`\`\`sylor-tool
{ "tool": "preview_inspect", "action": "eval", "expression": "document.querySelectorAll('.todo').length" }
\`\`\`

- The actions: "screenshot" (a rendered picture of the page — you SEE it), "snapshot" (the
  page's text + structure), "inspect" (computed CSS for a "selector" — the most reliable way
  to verify a color/font/spacing, better than eyeballing a screenshot), "console_logs"
  (recent console output; add "level": "error" to see only errors), "network" (recent
  requests; add "filter": "failed" for only failures), "click" (click a "selector"), "fill"
  ("selector" + "value" to type into an input), and "resize" ("preset": "mobile"/"tablet"/
  "desktop", or "width"/"height", to test responsive layout).
- Three more give you the rest of a real browser:
  - "eval" runs an "expression" INSIDE the page and returns its value — the way to do anything
    the fixed actions don't cover: hover or key events
    (\`el.dispatchEvent(new MouseEvent('mouseover', {bubbles:true}))\`), scrolling
    (\`window.scrollTo(0, 500)\`), reading app state (\`localStorage.getItem('theme')\`), or
    calling a function the page exposes. Objects, arrays and elements come back readable. Use
    an expression; for several steps, wrap them in an IIFE that RETURNS the value.
  - "navigate" points the preview at another page of the app — \`{"action": "navigate", "url":
    "/about"}\` for a route, or no "url" at all to reload. Localhost only: it is the user's own
    app, and the real web is the browse tool's job.
  - "server_logs" reads the DEV SERVER's own output (add "level": "error" for just the
    failures). This is where a compile error lives — the one thing the page itself cannot tell
    you. Reach for it FIRST when the preview is blank, stale, or won't load: the guest console
    is empty in exactly that case because nothing was ever served.
- After a visible change, prefer "inspect" for exact style values and "console_logs"
  ("level": "error") to catch runtime errors, then a "screenshot" to confirm the look. These
  only observe/drive the user's OWN local preview — they change no files and reach no network,
  so they run immediately without asking.
- SAFETY: "fill" refuses password / token / card / secret-looking fields. Never try to type a
  credential into the preview, and never use "eval" to read one out of a page.

CHECK YOUR WORK WITH THE PROJECT'S OWN CHECKERS (diagnostics):
- \`diagnostics\` runs the checkers the project already has — TypeScript (\`tsc --noEmit\`) and
  ESLint — and hands you back a sorted list of \`file:line:col  code  message\`. Use it after a
  round of edits instead of guessing whether the code compiles:

\`\`\`sylor-tool
{ "tool": "diagnostics" }
\`\`\`

- Optional "scope": "typescript" or "eslint" narrows it to one checker (default is both);
  optional "files": ["src/main/foo.ts"] narrows the REPORT to those paths or folders (the
  whole project is still checked — a file's type errors depend on the rest of the program).
- Prefer this over a run_command like \`npx tsc\`: it needs no shell, produces no ANSI noise,
  and comes back as structured problems instead of pages of compiler output.
- Read the reply carefully: it names which checkers RAN and which were SKIPPED. "Nothing was
  checked" means the project has no checker installed — NOT that the code is fine. An empty
  problem list is only meaningful for a checker that actually ran.
- Fix what it reports, then re-run it once to confirm. Don't re-run it when it already came
  back clean.

${BROWSE_BLOCK}

HOW YOU COMMUNICATE — narrate the WORK, never the THINKING:
- Every message you send must contain at least one short line of prose. A reply that is
  nothing but tool blocks looks frozen from the outside: the user sees a spinner, has no
  idea what you're doing, and gives up on you. Going quiet is the fastest way to lose them.
- One short line each time you act. Before the block, what you're about to do: "Reading
  Header.tsx to see how the nav is built." After the app reports results back, what landed
  and what's next: "Config's in — wiring the router now." One or two sentences, present
  tense, name the file. Then the block. The user is watching a progress feed, not reading
  an essay.
- The gathering step is the one exception to "one short line": once the files come back, the
  user gets a real paragraph — what you read, what is wrong and where, and the fix in order
  (see GATHERING). After that, back to one line per step.
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

${MEMORY_BLOCK}

Be concise, correct, and grounded in the provided project context.`

/**
 * The Cowork-mode system prompt. Cowork is a ChatGPT-like conversational
 * assistant with ONE capability: the browser. Sylor answers, explains, and writes
 * code directly in its reply, and can go use the web on the user's behalf — but it
 * has NO access to their files or terminal, and the `browse` allowlist in
 * `runAgentLoop` enforces that regardless of what the model tries to emit.
 */
const COWORK_SYSTEM_PROMPT = `You are Sylor, a friendly, sharp AI assistant. Right now you are in "Cowork" mode — you work like a chat assistant (think ChatGPT), with a real web browser you can drive.

In Cowork mode you:
- Answer questions, explain ideas, brainstorm, review snippets the user pastes, and hold a normal conversation.
- Write any code directly in your reply inside fenced Markdown code blocks (e.g. \`\`\`ts). The user can read and copy it.
- Go and USE the web when the answer lives out there: look something up, open a site, work through a webapp the user is signed into, and report back what you found.
- Do NOT have access to the user's files, folders, or terminal. You cannot edit files, run commands, or start servers here — so never say you did. If they want that, they can switch to "Code" mode with the Cowork/Code toggle by the message box.

To use the browser, emit a fenced block in this exact format — one block, at the END of your message, and nothing after it:

${BROWSE_BLOCK}

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
 * The output ceiling for Sylor's "no compromise" tier. A gateway that isn't told
 * otherwise caps output conservatively (often ~4096 tokens), which silently
 * truncates a large file or a whole scaffold mid-generation — the model just
 * stops. When the effort is `max` (auto-forced for from-scratch/multi-domain
 * builds, or picked by hand), we lift that ceiling well clear of any single file
 * so project creation runs to completion. Tuned for current-generation Claude
 * models (this app's default), which support outputs far above this; a smaller
 * self-hosted model simply generates up to its own limit.
 */
const MAX_OUTPUT_TOKENS = 32_000

/**
 * Turns the composer's reasoning effort into concrete sampling/thinking hints for
 * the provider. `reasoningEffort` is the primary lever — a capable gateway maps it
 * to the model's extended-thinking budget, which is most of what makes replies
 * feel deliberate (Claude-Code-like) rather than glib. `temperature` is a coding
 * default (kept in a precise range) that only backends without a reasoning knob —
 * e.g. Ollama — actually apply; the gateway drops it in favour of the effort. Both
 * are best-effort: a backend that understands neither is unaffected.
 *
 * The `max` tier additionally raises the output cap (see {@link MAX_OUTPUT_TOKENS})
 * so a big build isn't truncated — the one place tokens must not be compromised.
 */
function completionOptions(effort: ReasoningEffort): CompletionOptions {
  const temperature = effort === 'low' ? 0.3 : effort === 'medium' ? 0.5 : 0.7
  const options: CompletionOptions = { reasoningEffort: effort, temperature }
  if (effort === 'max') options.maxTokens = MAX_OUTPUT_TOKENS
  return options
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
    'narrate your decisions in prose but never paste file contents into chat — always use write_file.\n\n' +
    'Two optional modifiers on a spawn:\n' +
    '- `"isolation": "worktree"` runs the agent in a private git worktree (its own copy of the ' +
    'project at the last commit). Use this ONLY for a genuinely independent slice — one that neither ' +
    'reads your uncommitted edits nor touches the same files as another running agent — so two ' +
    'builders can work in parallel without clobbering each other. Its changes are merged back when it ' +
    'finishes. For work that depends on your current edits, do NOT isolate.\n' +
    '- `"background": true` makes the spawn non-blocking: you keep working immediately and receive the ' +
    "subagent's report in a later step, once it finishes. Use it to fan a slow, independent slice out " +
    'while you make progress elsewhere; leave it off when you need the result before your next step.'
  )
}

/**
 * The lead-only directive teaching the `update_todos` block — a flat, visible
 * checklist the model keeps for the user (Claude-Code's TodoWrite). It is NOT the
 * orchestrator's phase plan: it's the lead's own short list of concrete steps, so
 * even a simple turn can show "where we are". Handled outside executeTool (no side
 * effect, no approval) and taught to the lead only, so a subagent never clobbers
 * the lead's list. Skipped for one-step changes — ceremony must be earned.
 */
function todosDirective(): string {
  return (
    '\n\n## Keeping a task checklist (for multi-step work)\n' +
    'When a task has more than a couple of steps, keep a short, visible checklist so the user sees ' +
    'the plan and how far along you are. Write or update it with:\n\n' +
    '```sylor-tool\n{ "tool": "update_todos", "todos": [\n' +
    '  { "text": "Add the /logout route", "status": "in_progress" },\n' +
    '  { "text": "Wire the header button to it", "status": "pending" },\n' +
    '  { "text": "Add a test for logout", "status": "pending" }\n' +
    '] }\n```\n\n' +
    'Rules: always send the WHOLE list (it replaces the previous one). Keep exactly ONE item ' +
    '"in_progress" as you work; flip it to "completed" the moment it is done; add items if the work ' +
    'grows. Keep it to a handful of concrete steps — not sub-tasks — and skip it entirely for a ' +
    'one-step change. The checklist is your plan, not a substitute for doing the work: a list on its ' +
    'own is not progress, so always follow it with a real action (a tool block) in the same or the ' +
    'next message.'
  )
}

/**
 * The lead-only directive teaching the `ask_user` block — a blocking clarifying
 * question (Claude-Code's AskUserQuestion). Unlike Sylor's usual "assume the most
 * reasonable default and note it", this HALTS the turn until the user answers, so
 * it is reserved for genuine forks the answer changes: a real ambiguity in the
 * request, or a choice between approaches with real trade-offs. The turn does not
 * continue — no files are written, no commands run — until the answer comes back.
 */
function askDirective(): string {
  return (
    '\n\n## Asking the user a question (only when you are genuinely blocked)\n' +
    'Your default is to pick the most reasonable option and say so, then keep moving — do NOT ask ' +
    'about things you can decide yourself or verify in the code. But when the request is genuinely ' +
    'ambiguous, or you are at a fork between approaches with real trade-offs and the wrong guess would ' +
    'waste real work, ask ONE focused question and wait for the answer:\n\n' +
    '```sylor-tool\n{ "tool": "ask_user", "question": "Which auth should the login page use?", ' +
    '"header": "Auth method", "options": ["Email + password", "Google sign-in", "Both"] }\n```\n\n' +
    'Rules: ask only when blocked, one question at a time, and keep `options` to a few concrete ' +
    'choices (the user can always type their own answer instead, so options are suggestions, not a ' +
    'closed set). `header` is a short topic label. After you emit the block, STOP and wait — the run ' +
    'pauses until the user answers, and their answer arrives as the next turn for you to act on.'
  )
}

/**
 * The directive teaching the `flag_followup` block — how to report an out-of-scope
 * issue WITHOUT doing it (Claude-Desktop's `spawn_task`). This closes the gap where
 * an agent has exactly two bad options on spotting an unrelated problem: fix it and
 * bloat the change, or say nothing and lose the finding. Taught to subagents too —
 * a reviewer reading the whole diff is precisely who notices the loose ends.
 */
function followupDirective(): string {
  return (
    '\n\n## Flagging something out of scope (instead of fixing it)\n' +
    'While working you will notice real problems that are NOT what you were asked to do — dead code, ' +
    'a stale doc, a missing test, a TODO that turned out to be true, a security smell. Do not widen ' +
    'your change to fix them, and do not stay silent about them. Flag each one:\n\n' +
    '```sylor-tool\n{ "tool": "flag_followup", "title": "Fix the stale README badge", ' +
    '"note": "It points at the old CI workflow name, so it always renders as unknown.", ' +
    '"files": ["README.md"] }\n```\n\n' +
    'Rules: the `title` must stand on its own as a task someone could pick up cold — imperative, ' +
    'specific, no "this"/"that" referring to the current conversation. Flag only what you actually ' +
    'saw in the code, only when fixing it would bloat the work you were asked to do, and at most a ' +
    'couple per turn: a trivial fix you can make inline is not a follow-up, and neither is a vague ' +
    'code smell or a hunch you have not verified. Flagging is never a substitute for doing your own ' +
    'task — record it and carry straight on with the work.'
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
  resolve: (decision: ToolDecision, detail?: ToolDecisionDetail) => void
  /**
   * Which agent is parked on this decision (absent = the lead). Cancelling ONE
   * subagent has to unblock exactly its own waiting approvals: leave them and the
   * agent never notices it was stopped, resolve them all and a sibling lane loses
   * an approval the user never answered.
   */
  agentId?: string
}

/** A pending clarifying question the engine is blocked on, keyed by questionId. */
interface PendingQuestionSlot {
  resolve: (answer: string) => void
}

/** Tracks a running workflow so it can be cancelled and answered. */
interface RunHandle {
  controller: AbortController
  /** Tool requests awaiting a renderer decision, keyed by toolId. */
  pending: Map<string, PendingDecision>
  /**
   * Clarifying questions (the `ask_user` tool) awaiting a renderer answer, keyed by
   * questionId. Mirrors {@link pending}: the loop blocks on the promise, the renderer
   * unblocks it with the user's answer, and a cancel resolves every slot so a run
   * waiting on an unanswered question can still tear down.
   */
  pendingQuestions: Map<string, PendingQuestionSlot>
  /**
   * In-flight background subagents (spawned with `background: true`). The lead
   * keeps working while these run; each one's report is drained into a later
   * feedback turn, and the run is not allowed to emit `done` until all have
   * settled ({@link joinBackgroundTasks}). Nesting is depth 1, so only a lead
   * ever populates this — a subagent can't spawn, background or otherwise.
   */
  backgroundTasks: Promise<void>[]
  /**
   * Per-run read-dedup cache (Problem 1). Maps a `read_file` window key (root +
   * path + line range, see `readCache.ts`) to the file's `size:mtime` stamp when it
   * was served plus whether that read reached the end of the file, so a second read
   * of a file unchanged since is answered from a short note instead of a fresh disk
   * hit AND a second full-content copy in the model's context. Because
   * {@link planReadWindow} makes the first read of any path whole, the whole-file
   * entry also answers every later WINDOW of that path. Evicted on a write to that
   * path; cleared after any command (which could touch arbitrary files).
   */
  readCache: Map<string, ReadCacheEntry>
  /**
   * Standing approvals granted from the permission bar with "Always" — keys from
   * {@link standingApprovalKey}. Shared by the lead and every subagent (they all
   * share this handle), which is the point: a 9-phase build asks once about file
   * edits instead of once per file. Run-scoped only — nothing here is persisted,
   * so the next turn starts from the user's configured mode again.
   */
  standingApprovals: Set<string>
  /**
   * Tool ids the user explicitly REJECTED at the permission bar. A refusal is a
   * decision to respect, not a technical failure: without this, a rejected write
   * lands in `lastFailures` exactly like a write that threw, and the
   * retry-on-failure nudge then pushes the model to re-attempt the very thing the
   * user just declined. Recording the id here lets the loop skip it. Run-scoped;
   * ids are globally unique (salted counter) so entries never collide.
   */
  refused: Set<string>
  /**
   * Per-subagent abort controllers, keyed by agentId. Each is chained to the run's
   * own controller (cancelling the run cancels every agent), but not the other way
   * round — which is the entire point: the user can stop one lane that has gone
   * wrong and let the rest of the turn finish. The lead has no entry here; it lives
   * and dies with the run.
   */
  agents: Map<string, AbortController>
}

/**
 * The abort signal that governs `agentId` — its own if it is a subagent, otherwise
 * the run's. Every abort check inside the agent loop and the tool gate goes through
 * here, so "stop this one agent" and "stop the run" are the same mechanism at two
 * scopes instead of two code paths that can disagree.
 */
function signalFor(handle: RunHandle, agentId?: string): AbortSignal {
  const own = agentId ? handle.agents.get(agentId) : undefined
  return own ? own.signal : handle.controller.signal
}

const activeRuns = new Map<string, RunHandle>()

/**
 * Awaits every in-flight background subagent and clears the list. Called before
 * each `done` emit (and as a backstop in `runWorkflow`'s `finally`) so an
 * `agent-end` from a background task can never arrive after the run has already
 * reported completion. Total: individual task failures are swallowed inside the
 * fire-and-forget wrapper, so this only ever waits, never throws.
 */
async function joinBackgroundTasks(handle: RunHandle): Promise<void> {
  if (handle.backgroundTasks.length === 0) return
  const pending = handle.backgroundTasks.splice(0)
  await Promise.allSettled(pending)
}

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
  '```sylor-tool\n{ "tool": "write_file", "path": "relative/path.ext", "content": "<the full file>", "purpose": "<what it is for>" }\n```\n\n' +
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
  '```sylor-tool\n{ "tool": "write_file", "path": "relative/path.ext", "content": "<the full file>", "purpose": "<what it is for>" }\n```\n\n' +
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
 * Upper bound on "the action failed — don't stop, fix it" nudges in a single
 * turn. Distinct from {@link MAX_FIX_NUDGES} (which is about a file that parsed
 * but failed a static check): this fires when the OPERATION itself errored — a
 * command exited non-zero, a write or MCP call failed — and the model then tries
 * to end the turn without addressing it. Small on purpose: some failures (a test
 * that is legitimately red, a command that can't succeed here) are not the
 * model's to fix by retrying, so after a couple of pushes the turn is allowed to
 * end with an honest explanation rather than looping forever.
 */
const MAX_FAIL_NUDGES = 2

/** Fed back when the turn is about to end right after an action errored. */
function fixFailureNudge(failures: string[]): string {
  return (
    'The last action did not succeed:\n\n' +
    failures.map((f) => `- ${f}`).join('\n') +
    '\n\nDo not stop here. Take ONE next step to make it work: if you can fix the cause, do it ' +
    '(read_file to see the current state or adjust the command first if needed), then retry with ' +
    'a single tool block. Only if it genuinely cannot succeed, tell the user plainly what failed ' +
    'and why — do not claim it worked. Open with one short line, then one tool block.'
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

/**
 * Monotonic counter for tool ids, salted with the launch time. `tool_ops.id` is a
 * DB PRIMARY KEY, but toolCounter resets to 0 on every app start — so a bare
 * `tool-1` collides with an op a prior run persisted, and `appendToolOp`'s
 * `ON CONFLICT(id) DO UPDATE` would rewrite that other session's op instead of
 * inserting. The per-launch salt makes ids globally unique, matching the salted
 * `msg-`/`run-` ids in the renderer and the timestamped `sess-`/`att-` ids in the
 * db layer.
 */
const TOOL_ID_SALT = Date.now().toString(36)
let toolCounter = 0
const nextToolId = (): string => `tool-${TOOL_ID_SALT}-${++toolCounter}`

/**
 * Ids for clarifying questions (the `ask_user` tool). Transient — never persisted,
 * unlike tool ops — but salted the same way so a renderer keying its pending-question
 * UI on them can't collide two questions from different launches.
 */
let questionCounter = 0
const nextQuestionId = (): string => `q-${TOOL_ID_SALT}-${++questionCounter}`

/**
 * Ids for flagged follow-ups. Transient like question ids — the durable record is
 * the `FOLLOWUPS.md` entry, so this only has to key a chip and its dismissal.
 */
let followupCounter = 0
const nextFollowupId = (): string => `fu-${TOOL_ID_SALT}-${++followupCounter}`

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
  const handle: RunHandle = {
    controller,
    pending: new Map(),
    pendingQuestions: new Map(),
    backgroundTasks: [],
    readCache: new Map(),
    standingApprovals: new Set(),
    refused: new Set(),
    agents: new Map()
  }
  activeRuns.set(runId, handle)

  const settings = getSettings()
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''

  // Pin the whole run to the conversation's own folder when the client passed one
  // (`request.root` = the chat's persisted projectRoot). Reuses the same
  // AsyncLocalStorage override that worktree isolation uses, so every read/write/
  // command — and every project-memory lookup below — resolves against THIS chat's
  // folder even if the user opens a different conversation, switching the global
  // root, mid-run. Omitted → runs against the live global root exactly as before.
  // Generic over sync and async callbacks: the override covers the whole async
  // subtree, so an awaited call stays pinned for its entire continuation.
  const pinToRunRoot = <T>(fn: () => T): T =>
    request.root ? contextManager.runWithRoot(request.root, fn) : fn()

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

    // UserPromptSubmit hooks (Phase 4): fire once as the turn begins, before any
    // model call, so an automation can react to the prompt (log it, prep a file).
    // Non-blocking; a no-op when unconfigured. Fires for both Cowork and Code.
    await runLifecycleHooks('UserPromptSubmit', controller.signal, {
      SYLOR_PROMPT: lastUser,
      SYLOR_MODE: mode ?? 'code'
    })
    if (controller.signal.aborted) return

    // Cowork mode: a conversational assistant with ONE capability — the browser.
    // It answers and writes code directly in the reply, never touches the user's
    // files or terminal, but can go and USE the web on their behalf. That means it
    // needs the real gated agent loop, not a single completion: a `browse` has to
    // be proposed, approved, executed, and fed back so the model can act on what it
    // saw. `toolAllowlist: ['browse']` is what keeps the mode's promise — every
    // other tool kind is refused in `executeTool`, whatever the model emits.
    //
    // `allowSpawn: false` both forbids subagents here and disables the
    // continue/start-build nudges, which exist for file builds and would misfire on
    // a turn whose only work is browsing.
    if ((mode ?? 'code') === 'cowork') {
      emit({ type: 'status', runId, stage: 'generating', message: 'Thinking…' })
      const provider = providerFromSettings(settings)
      let system = COWORK_SYSTEM_PROMPT + effortDirective(effort ?? 'medium')
      const coworkProfile = buildUserProfilePreamble(lastUser)
      if (coworkProfile) system += `\n\n${coworkProfile}`
      const outbound: ChatMessage[] = [{ role: 'system', content: system }, ...messages]

      await runAgentLoop({
        role: 'lead',
        outbound,
        maxSteps: MAX_STEPS,
        intentKind: 'question',
        allowSpawn: false,
        runId,
        permissionMode,
        projectId: projectId ?? null,
        handle,
        provider,
        modelId: settings.modelId,
        enabledSkills: [],
        emit,
        onTerminal,
        spawnContext: {
          overview: '',
          projectPreamble: '',
          effort: effort ?? 'medium',
          mcpTools: [],
          enabledSkills: [],
          recap: ''
        },
        toolAllowlist: ['browse']
      })

      if (controller.signal.aborted) return
      emit({ type: 'done', runId })
      return
    }

    // 1. Understand the request (lightweight intent parse).
    emit({ type: 'status', runId, stage: 'understanding', message: 'Analyzing your request…' })
    const intent = await classifyIntent(lastUser, settings, controller.signal)
    if (controller.signal.aborted) return
    emit({ type: 'intent', runId, intent })

    // 1b. Project memory. Everything the run knows about the project that ISN'T in
    // the code: the DB-backed per-project instructions/knowledge, the hierarchical
    // checked-in instruction files (user ~/.sylor/SYLOR.md + the project's own
    // SYLOR.md / AGENTS.md / CLAUDE.md slots, @imports inlined), and the persisted
    // understanding documents (PROJECT / ARCHITECTURE / FILEMAP / CONVENTIONS /
    // DECISIONS / STATE / TASKS). Together they are what stops a run rediscovering
    // the project from zero. Built inside the run-root pin because two of the three
    // read files, and never throws — a bad project id or an unreadable doc degrades
    // to a shorter preamble.
    //
    // On a work turn the documents are scaffolded first, so the agent has real files
    // to maintain instead of having to remember to invent them. Scaffolding never
    // overwrites, so an existing `.claude/` (or a doc a human wrote) is adopted, not
    // clobbered. Read-only turns scaffold nothing.
    const projectPreamble = pinToRunRoot(() => {
      if (intent.kind === 'edit') {
        const created = scaffoldMemory()
        if (created.length > 0) {
          // A status line, never a delta: seeding memory is infrastructure, and the
          // assistant's own prose must stay the assistant's (§33 — no internal noise).
          emit({
            type: 'status',
            runId,
            stage: 'understanding',
            message: `Started project memory in ${created[0].split('/')[0]}/…`
          })
        }
      }
      return [
        buildProjectPreamble(projectId ?? null),
        buildInstructionsPreamble(),
        buildMemoryPreamble()
      ]
        .filter(Boolean)
        .join('\n\n')
    })
    if (controller.signal.aborted) return

    // 2. Gather project context when the intent calls for it.
    let overview = ''
    if (intent.needsContext) {
      emit({ type: 'status', runId, stage: 'scanning', message: 'Scanning the project structure…' })
      if (controller.signal.aborted) return

      // A bulk internal scan of many files at once — there is no single "current file"
      // to name, and a `(12 files)` count is exactly the noise the reading status is
      // meant to drop, so this stays a plain neutral line.
      emit({ type: 'status', runId, stage: 'reading', message: 'Reading the project for context…' })
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

    // How big is this turn? The MODEL decides (see {@link classifyComplexity}),
    // once, here — and the same verdict is handed to the orchestrator below, so a
    // turn is never sized twice and the effort tier can never disagree with the
    // roadmap it is thinking for. Only a build (edit intent) is sized at all;
    // chat and questions get no round-trip.
    const turnComplexity =
      intent.kind === 'edit'
        ? await classifyComplexity(lastUser, settings, controller.signal, { overview })
        : null
    if (controller.signal.aborted) return

    // Project creation must not be starved of thinking budget. When the turn is a
    // build the model sized as `complex` — a whole product, or a change across the
    // codebase — force the `max` tier regardless of the composer setting. That
    // lifts both levers at once: extended-thinking budget (via effortDirective +
    // the gateway) and the output cap (via completionOptions → MAX_OUTPUT_TOKENS),
    // so a whole scaffold reasons hard and generates to completion instead of
    // being cut short. Smaller turns keep the requested effort so everyday edits
    // stay fast.
    const requestedEffort = effort ?? 'medium'
    const effectiveEffort: ReasoningEffort =
      turnComplexity === 'complex' ? 'max' : requestedEffort

    const outbound = buildMessages(
      messages,
      overview,
      projectPreamble,
      effectiveEffort,
      intent.kind,
      mcpTools,
      enabledSkills
    )

    // The context meter's opening reading (§Phase 4), taken once the turn's array is
    // assembled and before anything is appended to it. The agent loop re-measures at
    // every step, but a turn that delegates all of its work never enters that loop —
    // the specialists run their own private histories, and those are deliberately not
    // reported — so without this the meter would sit frozen through exactly the
    // longest turns. `outbound.length` is the pinned prologue: nothing has grown yet.
    emit({
      type: 'context',
      runId,
      usage: measureContext(outbound, outbound.length, settings.modelId)
    })

    // "Plan first" (#2) is an APPROVAL CHECKPOINT, not a separate mode: the turn
    // runs the ordinary orchestrated flow, and the orchestrator halts after the
    // plan — before a single file is touched — for the user's go-ahead. Approving
    // builds it in the SAME turn; rejecting stops the run having written only the
    // plan. Only an edit turn has a plan worth approving.
    const planApprovalGate = (planFirst ?? false) && intent.kind === 'edit'
    const maxSteps = MAX_STEPS

    // Everything a delegated subagent needs to be framed exactly as the lead was
    // (requirement B): the same project overview, preamble, effort, MCP tools, and
    // skills. Threaded through every spawn so a subagent starts with the lead's
    // context, not a blank slate.
    const spawnContext: SpawnContext = {
      overview,
      projectPreamble,
      effort: effectiveEffort,
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
    // planning and review would be pure overhead). "Plan first" turns DO run this
    // gate — the plan they promise is the orchestrator's, and the halt they promise
    // is its APPROVE stage (#2).
    if (intent.kind === 'edit') {
      // One internal completion, paced + retried like every other model call.
      // Used for document authoring (audit, spec, phase plan) and the review
      // verdict; safe to replay verbatim because nothing it produces has been
      // shown to the user yet. Collected over the STREAMING transport (see
      // {@link collectCompletion}), so a 26-section phase plan is bounded by
      // silence rather than by total generation time — and the signal means a
      // Stop kills the HTTP request instead of orphaning it.
      //
      // `working` is what the status row says while the call is in flight. These
      // are the longest silent stretches of a staged turn (minutes, at high
      // reasoning effort), and a row still reading `Phase 1 of 9` through one of
      // them is indistinguishable from a hang — so the caller names the document
      // and {@link writingProgress} counts what has actually arrived.
      const complete = async (
        msgs: ChatMessage[],
        settled: string,
        working?: string
      ): Promise<string> => {
        const retry = retryReporter(runId, emit)
        const progress = working ? writingProgress({ runId, label: working, emit }) : null
        try {
          const text = await withRetry(
            () =>
              provider.getCompletion(
                settings.modelId,
                msgs,
                completionOptions(effectiveEffort),
                controller.signal,
                progress?.onProgress
              ),
            { signal: controller.signal, onRetry: retry.onRetry }
          )
          retry.clear(settled)
          return text
        } finally {
          // Before `retry.clear`'s own line would land, so the counter can't
          // narrate over whatever the next stage puts on the row.
          progress?.stop()
        }
      }
      await pinToRunRoot(() =>
        runOrchestrator({
          runId,
          request: lastUser,
          overview,
          settings,
          // Already decided, by the model, above. Passed down so the orchestrator
          // does not re-ask and the two stages can't disagree.
          complexity: turnComplexity ?? undefined,
          emit,
          signal: controller.signal,
          executeNode: (node, opts) => executeNode(node, opts, leadArgs),
          // plan.md goes through the same approval gate as any other write.
          writePlan: async (markdown) => {
            await executeTool(
              {
                tool: 'write_file',
                path: activePlanPath(),
                content: markdown,
                purpose: 'the plan for this phase — what gets built, in what order, and why'
              },
              { runId, permissionMode, handle, emit, onTerminal }
            )
          },
          verify: () => verifyProject({ runId, permissionMode, handle, emit, onTerminal }),
          // #2 — the "Plan first" checkpoint. Supplied ONLY when the toggle is on, so
          // an ordinary turn never pays a click. A plan is a proposed action like any
          // other, so it is answered over the same tool-decision channel the
          // permission bar already uses — no second answer-back path to keep in sync.
          ...(planApprovalGate
            ? {
                approvePlan: async (proposal: PlanProposal): Promise<PlanDecision> => {
                  const id = nextToolId()
                  emit({
                    type: 'plan-approval',
                    runId,
                    approval: {
                      id,
                      complexity: proposal.complexity,
                      steps: proposal.steps,
                      ...(proposal.wrotePlan ? { planPath: activePlanPath() } : {}),
                      ...(proposal.phase ? { phase: proposal.phase } : {})
                    }
                  })
                  const { decision } = await awaitDecision(handle, id)
                  // Every non-approval is a stop: a cancel resolves pending decisions
                  // with 'reject', and no standing grant can widen a one-off plan.
                  return decision === 'approve' || decision === 'approve-always'
                    ? 'approve'
                    : 'reject'
                }
              }
            : {}),
          judge: (msgs) => complete(msgs, 'Reviewing…', 'Reviewing the work…'),
          // Staged execution (§12–§27): the run becomes one phase of a roadmap that
          // persists in the project's own agent-memory folder.
          memory: projectMemoryPort(),
          // Each document names itself on the status row while it is being written
          // (the label comes from the stage that asked for it).
          scribe: (msgs, label) => complete(msgs, 'Writing the plan…', label ?? 'Writing…'),
          // Named in the plan's verification checklist so the phase's definition of
          // done is the project's real checks, not a generic wish.
          verifyCommands: detectVerifyCommands(),
          // What the preview pane is actually showing, so STATE.md can never claim a
          // stale preview is current (§23).
          previewHealth: () => previewHealth(),
          // The one-time project audit (§3). The current file map is passed back in so
          // re-rendering it keeps every purpose line already refined by hand.
          auditInventory: () => buildAuditInventory(readMemoryDoc('filemap'))
        })
      )
      if (controller.signal.aborted) return
      // Never let a `done` race ahead of a still-running background subagent's
      // `agent-end` (the lead may have finished before it did).
      await joinBackgroundTasks(handle)
      emit({ type: 'done', runId })
      return
    }

    emit({ type: 'status', runId, stage: 'generating', message: 'Generating…' })
    await pinToRunRoot(() => runAgentLoop(leadArgs))

    if (controller.signal.aborted) return
    await joinBackgroundTasks(handle)
    emit({ type: 'done', runId })
  } catch (err) {
    if (!controller.signal.aborted) {
      emit({ type: 'error', runId, message: toErrorMessage(err) })
    }
  } finally {
    // Release any resolvers still waiting so nothing leaks on completion.
    for (const p of handle.pending.values()) p.resolve('reject')
    handle.pending.clear()
    // Backstop: on an abort/error path (or any done we didn't guard) drain
    // background tasks so a late `agent-end` can't outlive the run's teardown.
    await joinBackgroundTasks(handle)
    // Stop hooks (Phase 4): fire once the turn has fully settled, but only when it
    // ran to completion — a user cancel isn't a "stop". Non-blocking side effects
    // (notify, commit, clean up). Best-effort; a no-op when unconfigured.
    if (!controller.signal.aborted) {
      await runLifecycleHooks('Stop', controller.signal, {
        SYLOR_PROMPT: lastUser,
        SYLOR_MODE: mode ?? 'code'
      })
    }
    // Persist the project file-index (Problem 1) so the structural summaries this
    // run gathered survive into the next run/session. No-op when nothing changed;
    // never throws (saveIndex swallows write errors).
    contextManager.flushIndex()
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
   * A hard whitelist of tool kinds for the whole loop, orthogonal to capabilities.
   * Cowork passes `['browse']` so the mode's "no files, no terminal" promise is
   * enforced by code and not just by the prompt.
   */
  toolAllowlist?: readonly ToolKind[]
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
 *
 * The wording follows the failure kind, because the two mean different things to
 * someone watching. A rejection ("Request failed") really is worth waiting out —
 * a quota rolls over. A deadline ("no response in time") is not the same story:
 * the request was accepted and simply took too long, we're giving it one quick
 * second chance, and saying "attempt 2/10" there would promise eight more tries
 * that will never happen.
 */
function emitRetryNotice(
  notice: RetryNotice,
  runId: string,
  emit: EventSink,
  agentId?: string
): void {
  const seconds = Math.max(1, Math.round(notice.delayMs / 1000))
  const what =
    notice.kind === 'timeout'
      ? `No response in time (${notice.reason})`
      : `Request failed (${notice.reason})`
  emit({
    type: 'status',
    runId,
    stage: 'generating',
    message: `${what} — retrying in ${seconds}s · attempt ${notice.attempt + 1}/${notice.max}`,
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
 * Formats a finished subagent's report for feeding back to the lead — identical
 * wording whether the subagent ran inline (awaited) or in the background, so the
 * lead reads both the same way. `(no report returned)` guards a silent agent.
 */
function describeSubagentReport(
  role: string,
  task: string,
  subReport: string,
  ok: boolean
): string {
  return (
    `Report from the ${role} subagent (${ok ? 'completed' : 'failed'}) ` +
    `for task "${task}":\n\n${subReport || '(no report returned)'}`
  )
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
    agentId,
    outbound,
    maxSteps,
    intentKind,
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
  const signal = signalFor(handle, agentId)

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
  // Human summaries of any op that ERRORED in the most recently executed step —
  // a command that exited non-zero, a write/mcp that failed. Distinct from
  // pendingIssues (files that parsed but failed a static check): this is "the
  // action itself failed". Recomputed each executed step and cleared on success,
  // so it only fires the retry nudge below while a failure is genuinely unresolved.
  let lastFailures: string[] = []
  // How many "the last action failed — don't stop, fix it" nudges spent (MAX_FAIL_NUDGES).
  let failNudges = 0
  // Whether this turn has actually built anything yet (executed a side effect or ran a
  // subagent). Gates the start-build nudge so a genuine closing summary — prose after real
  // work — is treated as a finish, not a stall.
  let built = false
  // How many steps this turn consisted ONLY of looking (read/list/search/find and
  // nothing else), and every path opened along the way. This is the count the user's
  // 13-step report was really about: gathering is one pass, not a habit, so pass 1
  // gets the "now tell me what you found" hand-off and every pass after gets told to
  // stop. Paths accumulate across passes so the nudge can name what is already held
  // in full. See `gather.ts`.
  let gatherPasses = 0
  const gathered: string[] = []
  // The agent's latest non-empty prose — its conclusion, returned as the report.
  let report = ''
  // Reports from BACKGROUND subagents that have finished since the last feedback
  // turn (lead only). A background spawn returns immediately; when it settles it
  // pushes its report here, and the next feedback turn (or the end-of-turn join)
  // drains this so the lead reacts to the fan-out result. Persists across steps
  // because a task started in step 2 may not finish until step 5.
  const backgroundReports: string[] = []

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
   * nothing at all.
   */
  const stopAfter = (tool: ParsedTool): boolean => {
    return (
      tool.tool === 'write_file' ||
      tool.tool === 'edit_file' ||
      tool.tool === 'run_command' ||
      tool.tool === 'web_fetch' ||
      tool.tool === 'web_search' ||
      tool.tool === 'install_plugin' ||
      tool.tool === 'mcp_call' ||
      tool.tool === 'preview_inspect' ||
      tool.tool === 'browse' ||
      tool.tool === 'diagnostics' ||
      // A clarifying question ends the message too — the model asks, then waits; it
      // must not narrate its way past the question into work that depends on the
      // still-unknown answer.
      tool.tool === 'ask_user' ||
      (allowSpawn && tool.tool === 'spawn_agent')
    )
  }

  // The pinned prologue — system prompt, prior conversation, and the original
  // request — captured before any step appends to `outbound`, so compaction folds
  // only the per-step growth after it (see {@link compactHistory}).
  const baseLen = outbound.length

  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return report

    // Before streaming, fold the old middle of a long history into a short note so
    // it can't overflow the model's context mid-build (§17). The note is written by
    // the model (a coherent recap of the folded steps), falling back to a
    // deterministic file/command list if that call fails — so it degrades to the
    // old behaviour offline. A no-op (same array back) until the turn has actually
    // grown large, so short turns are untouched and cost nothing.
    const compacted = await compactHistoryWithModel(outbound, baseLen, (folded) =>
      summarizeFoldedWithModel(provider, modelId, folded, signal)
    )
    if (compacted !== outbound) {
      outbound.splice(0, outbound.length, ...compacted)
      emit({
        type: 'status',
        runId,
        stage: 'generating',
        message: 'Condensing earlier steps to stay within context…'
      })
    }

    // Report the measured context load for the footer meter (§Phase 4), AFTER any
    // fold above so the number is the one actually being sent. Lead only: a
    // subagent runs its own private `outbound`, and letting those emit would make
    // the meter flip between unrelated conversations. `stampEmit` deliberately
    // doesn't attribute this variant either, so gating here is the whole guard.
    if (agentId == null) {
      emit({ type: 'context', runId, usage: measureContext(outbound, baseLen, modelId) })
    }

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
            stepCtl.signal,
            completionOptions(args.spawnContext.effort)
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

    // 4b′. Record any `remember_user` notes to the GLOBAL user profile. Like
    // `remember` these are inline (no approval, no disk/command power beyond a
    // small JSON write) but are project-independent — they follow the user into
    // every future chat, which is what makes Sylor more useful over time.
    const userNotes = parser.tools.filter(
      (t): t is Extract<ParsedTool, { tool: 'remember_user' }> => t.tool === 'remember_user'
    )
    if (userNotes.length > 0) {
      recordUserProfile(userNotes, runId, emit)
    }

    // 4b″. Record any `flag_followup` notices — out-of-scope work the agent spotted
    // and deliberately did NOT do. Inline for the same reason as `remember`: it only
    // appends to a markdown log the user reads, so gating it would be noise. Not
    // lead-gated (unlike the checklist and the question): a subagent reviewing code
    // is the likeliest one to notice a loose end, and its flag belongs to the run.
    const followupNotices = parser.tools.filter(
      (t): t is Extract<ParsedTool, { tool: 'flag_followup' }> => t.tool === 'flag_followup'
    )
    if (followupNotices.length > 0) {
      recordFollowups(followupNotices, runId, emit)
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
        t.tool === 'find_files' ||
        t.tool === 'run_command' ||
        t.tool === 'web_fetch' ||
        t.tool === 'web_search' ||
        t.tool === 'install_plugin' ||
        t.tool === 'mcp_call' ||
        t.tool === 'preview_inspect' ||
        t.tool === 'browse' ||
        t.tool === 'diagnostics'
    )
    const spawnRequests = allowSpawn
      ? parser.tools.filter(
          (t): t is Extract<ParsedTool, { tool: 'spawn_agent' }> => t.tool === 'spawn_agent'
        )
      : []

    // 4d″. The lead's flat TODO checklist (Claude-Code's TodoWrite). Handled here,
    // outside executeTool: it has no side effect and needs no approval — it only
    // replaces the live checklist panel. Lead-only (`!agentId`): a subagent's list
    // would clobber the lead's, and subagents are never taught the tool anyway. The
    // list is replace-wholesale, so the LAST block in a message wins.
    const todoRequests = !agentId
      ? parser.tools.filter(
          (t): t is Extract<ParsedTool, { tool: 'update_todos' }> => t.tool === 'update_todos'
        )
      : []
    if (todoRequests.length > 0) {
      emit({ type: 'todos', runId, todos: todoRequests[todoRequests.length - 1].todos })
    }

    // 4d‴. The lead's clarifying question (Claude-Code's AskUserQuestion). Like the
    // checklist it is handled here, outside executeTool: it writes nothing and needs
    // no approval — it BLOCKS the turn on a user answer instead. Lead-only (`!agentId`):
    // subagents are never taught the tool and must not stop the whole run to ask. Only
    // the FIRST question in a message is honoured; the model is told to ask one at a
    // time, and it must not queue several. The actual emit + await happens in the
    // feedback step (4h) so any reads in the same message still execute first.
    const askRequests = !agentId
      ? parser.tools.filter(
          (t): t is Extract<ParsedTool, { tool: 'ask_user' }> => t.tool === 'ask_user'
        )
      : []

    // 4d′. Raw-code guard. On an edit turn where the model proposed no tools, no
    // subagent, and no skill, but pasted file contents as plain Markdown fences,
    // nothing was staged and the user got un-actionable code. Nudge it — up to
    // MAX_NUDGES times — to re-emit those files as write_file blocks, then loop so
    // it can. This is also what makes a "here's the code / now I'll stage it" turn
    // read as think → act → think.
    if (
      sideEffects.length === 0 &&
      spawnRequests.length === 0 &&
      !skillInjection.text &&
      askRequests.length === 0 &&
      intentKind === 'edit' &&
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
    // intent, with continuation budget left and a step to spare — and only when open
    // plan items actually remain, so a small task with no plan.md (or a fully-checked
    // one) still stops here and pays nothing.
    if (
      sideEffects.length === 0 &&
      spawnRequests.length === 0 &&
      !skillInjection.text &&
      askRequests.length === 0 &&
      allowSpawn &&
      intentKind === 'edit' &&
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
    // lead + edit intent + zero parsed tools (so a remember- or skill-only turn is
    // exempt) + real prose present + not a raw-code dump (that has its own nudge
    // above) + budget and a step to spare.
    if (
      parser.tools.length === 0 &&
      allowSpawn &&
      intentKind === 'edit' &&
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

    // The turn wants to end here: nothing was proposed, delegated, or activated. A
    // bare checklist update is NOT an ending — the model declared its plan and must
    // get another iteration to act on it (like a read-only turn), so it counts here.
    // A pending clarifying question is likewise not an ending: the turn is paused on
    // the user, not finished, and must resume with their answer.
    const ending =
      sideEffects.length === 0 &&
      spawnRequests.length === 0 &&
      !skillInjection.text &&
      todoRequests.length === 0 &&
      askRequests.length === 0

    // 4d‴′. Background-agent join (lead only). The turn wants to end, but a
    // subagent the lead fired off with `background: true` may still be running —
    // or may have just finished with a report the lead hasn't reacted to yet.
    // Don't conclude blind: wait for every in-flight background task, then feed
    // their reports back so the lead integrates the work (or genuinely finishes)
    // instead of stopping with the fan-out still pending. Bounded — subagents
    // can't spawn (depth 1) and each background task settles exactly once, so
    // after draining, `ending` is reached again with nothing left and falls
    // through.
    //
    // The `allowSpawn` guard makes this genuinely lead-only: `handle.backgroundTasks`
    // is SHARED across the whole run, so an un-guarded subagent reaching its own
    // ending would try to `joinBackgroundTasks` the lead's fan-out — including the
    // very task that IS itself — and await its own completion forever. Subagents
    // never spawn, so their own `backgroundReports` is always empty; gating on
    // `allowSpawn` keeps them out of the shared handle entirely.
    if (
      ending &&
      allowSpawn &&
      (handle.backgroundTasks.length > 0 || backgroundReports.length > 0)
    ) {
      if (handle.backgroundTasks.length > 0) {
        emit({
          type: 'status',
          runId,
          stage: 'generating',
          message: 'Waiting for background agents to finish…'
        })
        await joinBackgroundTasks(handle)
      }
      if (signal.aborted) return report
      if (backgroundReports.length > 0) {
        outbound.push({ role: 'assistant', content: raw })
        outbound.push({ role: 'user', content: backgroundReports.splice(0).join('\n\n') })
        continue
      }
    }

    // 4d⁗. Verify-fix nudge. The turn is ending but a file written earlier this turn
    // is still failing its static check — the model wrote something broken and is
    // about to tell the user it's done. Send it back to the file. Applies to every
    // agent and every intent, because a file that cannot parse is broken regardless
    // of who wrote it or why.
    if (ending && pendingIssues.size > 0) {
      // Re-check each one against the file as it stands NOW. An issue can be
      // resolved by a later write to a different file — the missing stylesheet
      // finally created, the imported module finally added — and nudging about an
      // already-fixed file would be worse than not checking at all.
      for (const path of [...pendingIssues.keys()]) {
        const issues = recheckWrittenFile(path)
        if (issues.length === 0) pendingIssues.delete(path)
        else
          pendingIssues.set(
            path,
            issues.map((issue) => issue.message)
          )
      }
    }
    if (
      ending &&
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

    // 4d⁗′. Retry-on-failure nudge. The turn is ending, no broken file is pending,
    // but the most recent action ERRORED — a command exited non-zero, a write or an
    // MCP call failed — and the model is about to conclude without addressing it.
    // Send it back to make the thing work, or (only if it genuinely can't) to say so
    // honestly instead of implying success. Bounded by MAX_FAIL_NUDGES so a
    // legitimately-red command can't loop forever.
    if (
      ending &&
      pendingIssues.size === 0 &&
      lastFailures.length > 0 &&
      failNudges < MAX_FAIL_NUDGES &&
      step < maxSteps - 1
    ) {
      failNudges++
      emit({ type: 'status', runId, stage: 'generating', message: 'Retrying what failed…' })
      outbound.push({ role: 'assistant', content: raw })
      outbound.push({ role: 'user', content: fixFailureNudge(lastFailures) })
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
    // Reads (and web_fetch / web_search / browse) are deliberately excluded: gathering
    // information is progress, but it is not *building*, and if a read, fetch, search, or
    // page visit refunded the stall budgets a model could investigate in circles forever
    // instead of being nudged into writing something. (Cowork, where browsing IS the whole
    // job, runs with allowSpawn:false — which disables both of those nudges outright.)
    const mutated = sideEffects.some(
      (t) =>
        t.tool !== 'read_file' &&
        t.tool !== 'list_files' &&
        t.tool !== 'search_files' &&
        t.tool !== 'find_files' &&
        t.tool !== 'web_fetch' &&
        t.tool !== 'web_search' &&
        t.tool !== 'preview_inspect' &&
        t.tool !== 'browse' &&
        // A checker reads the project and changes nothing, so it must not refund
        // the stall budgets either — otherwise a model could re-run `tsc` forever.
        t.tool !== 'diagnostics'
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
      // A pure-look batch (only read/list/search/find) narrates itself file by file:
      // one `Reading <filename>` before each read runs, each replacing the last on the
      // single status line, so the user sees only the file being opened right now — no
      // grep query, glob, purpose, or count. Any other batch keeps its one
      // describeBatch line (Editing…, Verifying…, etc.), unchanged.
      const readingBatch = sideEffects.every((t) => isGatherTool(t.tool))
      if (!readingBatch) {
        const batch = describeBatch(sideEffects)
        emit({ type: 'status', runId, stage: batch.stage, message: batch.message })
      }
      for (const tool of sideEffects) {
        if (signal.aborted) return report
        if (readingBatch) {
          emit({
            type: 'status',
            runId,
            stage: 'reading',
            message:
              tool.tool === 'read_file' ? `Reading ${baseName(tool.path)}` : 'Reading the project…'
          })
        }
        const result = await executeTool(tool, {
          runId,
          permissionMode,
          handle,
          emit,
          onTerminal,
          agentId,
          capabilities: args.capabilities,
          toolAllowlist: args.toolAllowlist,
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

    // 4e″. Gathering-pass bookkeeping. A step whose whole output was read-only blocks
    // changed nothing: it was a LOOK. One look is right and necessary; the defect this
    // counts is the habit — thirteen inspection steps before a one-line CSS fix,
    // because nothing ever declared the looking finished. So count the passes, and
    // remember every file now held in full, for the hand-off pushed in 4h.
    const gatherOnly =
      outcomes.length > 0 &&
      spawnRequests.length === 0 &&
      outcomes.every(({ tool }) => isGatherTool(tool.tool))
    if (gatherOnly) {
      gatherPasses++
      for (const { tool, result } of outcomes) {
        // Only a SUCCESSFUL read is "held word for word" — the claim the nudges make.
        // A listing or a search told the model where to look, not what the code says.
        if (tool.tool !== 'read_file' || result.kind !== 'read' || !result.ok) continue
        if (!gathered.includes(tool.path)) gathered.push(tool.path)
      }
    }

    // Record which ops ERRORED this step (a command that exited non-zero, a write
    // or MCP call that failed), so the retry-on-failure nudge can catch the model
    // trying to end on an unresolved failure. Recomputed every executed step —
    // an empty list means the last actions all landed (or only read), which clears
    // the nudge. Failed READS are excluded on purpose: a bad path is investigative,
    // not a broken deliverable, and the model already reacts to it from the fed-back
    // result without being forced to retry.
    lastFailures = outcomes.flatMap(({ tool, result }) => {
      // A user-rejected op is a "no", not a failure — it must never feed the retry
      // nudge, which would push the model to re-attempt what the user just declined.
      if (handle.refused.has(result.id)) return []
      if (result.kind === 'write_file' && !result.ok) {
        const path = tool.tool === 'write_file' || tool.tool === 'edit_file' ? tool.path : ''
        return [`write ${path} failed: ${result.error ?? 'unknown error'}`]
      }
      if (result.kind === 'mcp_call' && !result.ok) {
        const label = tool.tool === 'mcp_call' ? `${tool.server}/${tool.name}` : 'mcp_call'
        return [`${label} failed: ${result.error ?? 'unknown error'}`]
      }
      if (result.kind === 'run_command' && result.exitCode !== 0 && result.exitCode !== null) {
        const command = tool.tool === 'run_command' ? tool.command : ''
        return [`command \`${command}\` exited ${result.exitCode}`]
      }
      return []
    })

    // 4e′. Delegated subagents (lead only — allowSpawn is false past depth 1).
    // Each runs this same gated loop in the same folder and hands back a report,
    // fed to the lead exactly like a tool result so it can decide the next step.
    // A `background: true` spawn is fire-and-forget: the lead keeps working and
    // the report is drained into a later feedback turn (or the end-of-turn join).
    const spawnReports: string[] = []
    for (const spawn of spawnRequests) {
      if (signal.aborted) return report
      if (spawn.background) {
        // Non-blocking. The task settles into `backgroundReports`; the handle
        // tracks it so the run can't emit `done` while it's still in flight, and
        // the lead is told now that it started so it moves on to other work.
        const task = runSubagent(spawn, args)
          .then(({ report: subReport, ok }) => {
            backgroundReports.push(describeSubagentReport(spawn.role, spawn.task, subReport, ok))
          })
          .catch((err) => {
            backgroundReports.push(
              describeSubagentReport(
                spawn.role,
                spawn.task,
                `crashed: ${toErrorMessage(err)}`,
                false
              )
            )
          })
        handle.backgroundTasks.push(task)
        spawnReports.push(
          `Started the ${spawn.role} subagent in the BACKGROUND for task "${spawn.task}". ` +
            'It runs independently and will report back when it finishes — continue with other ' +
            'work now; do not wait for it.'
        )
      } else {
        const { report: subReport, ok } = await runSubagent(spawn, args)
        spawnReports.push(describeSubagentReport(spawn.role, spawn.task, subReport, ok))
      }
    }
    if (signal.aborted) return report

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
    // Drain any background subagents that finished since the last step, so the
    // lead reacts to their reports mid-build rather than only at the very end.
    if (backgroundReports.length > 0) feedback.push(backgroundReports.splice(0).join('\n\n'))
    if (skillInjection.text) feedback.push(skillInjection.text)
    // A checklist-only turn keeps the loop alive (it isn't an ending) but produced no
    // result to feed back, so nudge the model onward — the list is a plan, not the work.
    if (todoRequests.length > 0 && sideEffects.length === 0 && spawnRequests.length === 0) {
      feedback.push(
        'Task checklist updated. That is your plan, not progress — now take the next real step ' +
          '(a tool block that does the work).'
      )
    }
    // The gathering hand-off, riding the feedback turn that was being sent anyway.
    // Pass 1 closes the pass and asks for the findings message — what was read, what
    // is actually wrong and where, and the fix in order — which is the message the
    // user wants to read before anything is touched. Every pass after that is the
    // agent going back for "one more look" instead, and gets told to stop; uncapped
    // on purpose (it costs no extra step, and the honest answer to a fifth round is a
    // firmer version of the same instruction), with MAX_STEPS as the backstop.
    if (gatherOnly) {
      feedback.push(
        gatherPasses === 1 ? findingsNudge(gathered) : stopGatheringNudge(gatherPasses, gathered)
      )
    }
    // 4h′. A pending clarifying question (lead only). The model asked and stopped;
    // now BLOCK the turn on the user's answer. Emit the question so the renderer
    // shows the answer bar, await the reply, then fold the exchange into this same
    // feedback turn so the next iteration acts on it. Only the first question is
    // honoured (the model is told to ask one at a time). A cancel resolves the wait
    // with an empty string and flips `signal.aborted`, so we bail without feeding a
    // phantom answer back.
    if (askRequests.length > 0) {
      const ask = askRequests[0]
      const questionId = nextQuestionId()
      emit({
        type: 'question',
        runId,
        question: {
          id: questionId,
          question: ask.question,
          ...(ask.header ? { header: ask.header } : {}),
          ...(ask.options ? { options: ask.options } : {})
        }
      })
      emit({
        type: 'status',
        runId,
        stage: 'generating',
        message: 'Waiting for your answer…'
      })
      const answer = await awaitAnswer(handle, questionId)
      if (signal.aborted) return report
      feedback.push(`You asked: "${ask.question}"\n\nMy answer: ${answer}`)
    }
    // An image `read_file` attaches its bytes to this fed-back turn so a
    // vision-capable model actually SEES the file — the text summary already
    // named it. A `preview_inspect` "screenshot" and a visual `browse` "read" ride
    // the SAME channel, so the model literally sees the preview it's verifying and
    // the web page it's driving. Transient: these live only in this run's
    // `outbound`, never in the persisted (text-only) transcript, so re-reads happen
    // per run, not per open.
    const images: ChatImage[] = outcomes.flatMap(({ result }) =>
      (result.kind === 'read' || result.kind === 'preview_inspect' || result.kind === 'browse') &&
      result.media
        ? [{ mediaType: result.media.mediaType, dataBase64: result.media.dataBase64 }]
        : []
    )
    outbound.push(
      images.length > 0
        ? { role: 'user', content: feedback.join('\n\n'), images }
        : { role: 'user', content: feedback.join('\n\n') }
    )
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
 * Trigger and window sizes for mid-run context compaction, in characters
 * (≈4 chars/token). A short turn never reaches the trigger, so the common case is
 * untouched. Tunable — a model-aware budget is the eventual refinement, but a fixed
 * floor already removes the unbounded-growth failure.
 *
 * Sized ABOVE one whole-file read, deliberately. `MAX_READ_CHARS` is 80k because
 * reading a real source file in full is what stops the repeated-read loop
 * (`workflow/gather.ts`); if the fold trigger sat below that, opening one big file
 * would compact the conversation — and spend a summarisation model call — on every
 * single step after it, which is both slower and lossier than the reads it was
 * meant to pay for. 240k leaves room for the gathering pass (several whole files)
 * plus the build that follows, and `RECENT_KEEP_CHARS` keeps the last ~90k — the
 * files just read, and the edits made against them — verbatim past a fold.
 */
const MAX_CONTEXT_CHARS = 240_000
const RECENT_KEEP_CHARS = 90_000
/** Most file paths / commands listed in one compaction note before eliding. */
const MAX_COMPACTION_ITEMS = 12
/**
 * Cap on the folded-transcript text fed to the summariser model. The folded middle
 * can itself be tens of thousands of characters (that is *why* we are compacting),
 * so we clip it — keeping the start and end, eliding the centre — before spending a
 * model call on it. Bounds the cost of the one summarisation to a small, fixed size.
 */
const COMPACTION_INPUT_CHARS = 24_000
/**
 * System prompt for the model that rewrites the folded middle into a coherent note.
 * It asks for exactly what lets the agent continue seamlessly — decisions, outcomes,
 * and facts later steps must remember — and forbids narration, code, and preamble,
 * so the note stays short. The deterministic file/command list is appended around
 * this by {@link decorateModelNote}, so hard facts survive even a vague summary.
 */
const COMPACTION_SUMMARY_SYSTEM =
  'You are compacting the middle of an in-progress engineering session to save context. ' +
  'Given a transcript of earlier steps (assistant actions and their results), write a SHORT ' +
  'summary — a few sentences or terse bullets — of what was attempted, what was decided, what ' +
  'succeeded or failed, and any fact a later step must remember (paths, identifiers, error causes). ' +
  'Keep concrete details; drop narration, code bodies, and pleasantries. No preamble and no ' +
  'headings — output only the summary itself, so the assistant can read it and continue seamlessly.'

/** The `sylor-tool` operations recorded in one assistant turn (for compaction). */
function extractToolBlocks(content: string): ParsedTool[] {
  const out: ParsedTool[] = []
  const re = /```sylor-tool\r?\n([\s\S]*?)\r?\n```/g
  for (let m = re.exec(content); m !== null; m = re.exec(content)) {
    const parsed = parseToolBlock(m[1])
    if (parsed) out.push(parsed)
  }
  return out
}

/** Joins a bounded, de-duplicated list, eliding the overflow as "+N more". */
function briefList(items: string[]): string {
  const uniq = [...new Set(items)]
  const shown = uniq.slice(0, MAX_COMPACTION_ITEMS).join(', ')
  const extra = uniq.length - MAX_COMPACTION_ITEMS
  return extra > 0 ? `${shown}, +${extra} more` : shown
}

/** How many assistant turns are in a folded run (its "step" count). */
function countFoldedSteps(folded: readonly ChatMessage[]): number {
  return folded.reduce((n, m) => n + (m.role === 'assistant' ? 1 : 0), 0)
}

/**
 * The hard, deterministic facts of a folded run — the files it changed and the
 * commands it ran, read from the turns' own `sylor-tool` blocks. These are the
 * anchors that must never be lost in compaction (a summary may gloss "edited a few
 * files"; the agent needs the exact paths). Returned as a trailing clause, or '' if
 * the run touched nothing. Shared by the deterministic and model-based notes.
 */
function foldedFactClause(folded: readonly ChatMessage[]): string {
  const files: string[] = []
  const commands: string[] = []
  for (const m of folded) {
    if (m.role !== 'assistant') continue
    for (const t of extractToolBlocks(m.content)) {
      if (t.tool === 'write_file' || t.tool === 'edit_file') files.push(t.path)
      else if (t.tool === 'run_command') commands.push(t.command)
    }
  }
  let clause = ''
  if (files.length > 0) clause += ` Files changed: ${briefList(files)}.`
  if (commands.length > 0) clause += ` Commands run: ${briefList(commands)}.`
  return clause
}

/**
 * A single short note standing in for a run of folded steps: how many steps, the
 * files they changed, and the commands they ran — read from the turns' own
 * `sylor-tool` blocks, so it states what actually happened rather than a guess.
 * This is what lets the model keep the thread ("I already wrote a.ts, b.ts")
 * after the verbose middle of the history is dropped. This is the deterministic,
 * no-model fallback; {@link compactHistoryWithModel} produces a richer note.
 */
function summarizeFoldedSteps(folded: readonly ChatMessage[]): string {
  const steps = countFoldedSteps(folded)
  let note = `[Context note — ${steps} earlier step${steps === 1 ? '' : 's'} condensed to save room.`
  note += foldedFactClause(folded)
  note += ' Continue from the latest result below.]'
  return note
}

/**
 * Wraps a model-written summary as the folded-middle note: the same `[Context note …]`
 * framing as the deterministic path, the model's narrative, then the deterministic
 * file/command clause so exact paths survive even if the prose glossed them.
 */
function decorateModelNote(summary: string, folded: readonly ChatMessage[]): string {
  const steps = countFoldedSteps(folded)
  const facts = foldedFactClause(folded)
  return (
    `[Context note — ${steps} earlier step${steps === 1 ? '' : 's'} condensed to save room.]\n` +
    `${summary}` +
    (facts ? `\n${facts.trim()}` : '') +
    '\nContinue from the latest result below.'
  )
}

/**
 * Renders a folded run as a plain transcript for the summariser, clipped to
 * {@link COMPACTION_INPUT_CHARS} by keeping the head and tail and eliding the middle
 * — the ends carry the run's opening intent and its latest state, which matter most.
 */
function renderFoldedTranscript(folded: readonly ChatMessage[]): string {
  const full = folded.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
  if (full.length <= COMPACTION_INPUT_CHARS) return full
  const half = Math.floor(COMPACTION_INPUT_CHARS / 2)
  return `${full.slice(0, half)}\n\n…[middle elided]…\n\n${full.slice(-half)}`
}

interface CompactionPlan {
  head: ChatMessage[]
  folded: ChatMessage[]
  tail: ChatMessage[]
}

/**
 * Decides what a compaction pass would fold, without producing the note. Returns
 * null (a no-op) when the whole history fits `budget`, or when the only thing over
 * budget is the pinned head plus the must-keep last pair (nothing old to drop).
 * Otherwise splits into the pinned prologue (first `baseLen`), the recent tail grown
 * backwards while it fits `recentBudget` (always at least the last two turns), and
 * the folded middle between them. Shared by the sync and model-based compactors so
 * both fold at exactly the same boundary.
 */
function planCompaction(
  messages: ChatMessage[],
  baseLen: number,
  budget: number,
  recentBudget: number
): CompactionPlan | null {
  const total = messages.reduce((n, m) => n + m.content.length, 0)
  if (total <= budget) return null

  const head = messages.slice(0, baseLen)
  const appended = messages.slice(baseLen)
  // Grow the kept tail backwards from the end while it fits the recency budget,
  // but always keep the last two appended turns (latest action + its result) so
  // the step the model must continue from is never the thing we drop.
  let tailChars = 0
  let firstTail = appended.length
  for (let i = appended.length - 1; i >= 0; i--) {
    const withThis = tailChars + appended[i].content.length
    const mustKeep = appended.length - i <= 2
    if (withThis > recentBudget && !mustKeep) break
    tailChars = withThis
    firstTail = i
  }
  const folded = appended.slice(0, firstTail)
  if (folded.length === 0) return null // only the pinned head is large — nothing to fold
  return { head, folded, tail: appended.slice(firstTail) }
}

/**
 * The context meter's numbers, measured off the array that is actually about to be
 * sent (§Phase 4). Every field is counted here rather than in the renderer, because
 * the renderer never sees two of the biggest consumers — the assembled system prompt
 * and the tool output fed back between turns — and would have to guess at them.
 *
 * `foldSteps` comes from {@link planCompaction}, the same boundary the real fold
 * uses, so "N earlier steps will be condensed next" is a fact rather than an
 * estimate. `windowTokens` is omitted whenever the model's real window is unknown
 * (see `shared/context-window.ts`): the meter then reports its own fold budget and
 * says "unknown" for the model, instead of drawing a percentage of a guess.
 */
export function measureContext(
  messages: ChatMessage[],
  baseLen: number,
  modelId: string,
  budget = MAX_CONTEXT_CHARS,
  recentBudget = RECENT_KEEP_CHARS
): ContextUsage {
  const sum = (list: ChatMessage[]): number => list.reduce((n, m) => n + m.content.length, 0)
  const head = messages.slice(0, baseLen)
  const appended = messages.slice(baseLen)
  const systemChars = sum(head.filter((m) => m.role === 'system'))
  // Anything appended that is not the model's own turn arrived as tool output: the
  // engine feeds every result back as a user turn (see the step loop below).
  const assistantChars = sum(appended.filter((m) => m.role === 'assistant'))
  const windowTokens = contextWindowFor(modelId)
  return {
    chars: sum(messages),
    budget,
    systemChars,
    historyChars: sum(head) - systemChars,
    assistantChars,
    toolChars: sum(appended) - assistantChars,
    foldSteps: planCompaction(messages, baseLen, budget, recentBudget)?.folded.length ?? 0,
    ...(windowTokens === undefined ? {} : { windowTokens })
  }
}

/**
 * Mid-run context compaction (§17). Every step the agent loop appends the model's
 * turn (which can carry a whole file's contents) and a user feedback turn (tool
 * output), so across a long build `outbound` grows without bound and would
 * eventually overflow the model's context window mid-run. When the assembled size
 * passes {@link MAX_CONTEXT_CHARS}, this folds the OLD middle of that growth into
 * one short {@link summarizeFoldedSteps} note while preserving verbatim (a) the
 * pinned prologue — system prompt, prior conversation, and the original request:
 * the first `baseLen` messages, never folded — and (b) the most recent turns
 * (~{@link RECENT_KEEP_CHARS}, and always at least the last pair), so the model
 * still sees its latest action and its result and can continue coherently.
 *
 * No model call — the note is scanned from the turns themselves, matching Sylor's
 * offline-first, deterministic style (cf. {@link summarizeResults}). Returns the
 * SAME array reference when nothing needs folding, so the caller detects a no-op
 * by identity and skips the rewrite. See {@link compactHistoryWithModel} for the
 * richer, model-written note used at run time.
 */
export function compactHistory(
  messages: ChatMessage[],
  baseLen: number,
  budget = MAX_CONTEXT_CHARS,
  recentBudget = RECENT_KEEP_CHARS
): ChatMessage[] {
  const plan = planCompaction(messages, baseLen, budget, recentBudget)
  if (!plan) return messages
  const note: ChatMessage = { role: 'user', content: summarizeFoldedSteps(plan.folded) }
  return [...plan.head, note, ...plan.tail]
}

/**
 * Model-based context compaction — the run-time default. Folds at the SAME boundary
 * as {@link compactHistory}, but the note replacing the folded middle is written by
 * the model: a coherent summary of what those steps accomplished (decisions, results,
 * facts to remember), which reads far better than a bare file/command list — the way
 * Claude Code condenses a long session. The deterministic file/command clause is still
 * appended as a hard-fact anchor, so exact paths survive a glossy summary.
 *
 * `summarize` does the model call. It is only ever invoked when there is genuinely
 * something to fold, and any failure/empty reply (offline, provider error, cancelled)
 * falls back to the exact deterministic {@link summarizeFoldedSteps} note — so this
 * never blocks a build and keeps working with no reachable model. Returns the SAME
 * array reference on a no-op, matching {@link compactHistory}.
 */
export async function compactHistoryWithModel(
  messages: ChatMessage[],
  baseLen: number,
  summarize: (folded: readonly ChatMessage[]) => Promise<string>,
  budget = MAX_CONTEXT_CHARS,
  recentBudget = RECENT_KEEP_CHARS
): Promise<ChatMessage[]> {
  const plan = planCompaction(messages, baseLen, budget, recentBudget)
  if (!plan) return messages
  let summary = ''
  try {
    summary = (await summarize(plan.folded)).trim()
  } catch {
    summary = ''
  }
  const content = summary
    ? decorateModelNote(summary, plan.folded)
    : summarizeFoldedSteps(plan.folded)
  return [...plan.head, { role: 'user', content }, ...plan.tail]
}

/**
 * The default `summarize` for {@link compactHistoryWithModel}: one cheap, low-effort
 * completion that turns the folded transcript into a note. Skipped (returns '') when
 * the run is already cancelled, so we don't spend a call whose result is discarded.
 */
async function summarizeFoldedWithModel(
  provider: Provider,
  modelId: string,
  folded: readonly ChatMessage[],
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) return ''
  return provider.getCompletion(
    modelId,
    [
      { role: 'system', content: COMPACTION_SUMMARY_SYSTEM },
      { role: 'user', content: renderFoldedTranscript(folded) }
    ],
    completionOptions('low'),
    signal
  )
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
  parent.emit({
    type: 'agent-start',
    runId: parent.runId,
    agentId,
    role,
    task,
    // Surface how this agent runs so the renderer can badge it. Both optional and
    // only present when set, so a plain spawn's event is byte-identical to before.
    ...(spawn.background ? { background: true } : {}),
    ...(spawn.isolation ? { isolation: spawn.isolation } : {})
  })

  const system = buildSubagentSystem(role, task, parent.spawnContext, opts.context)
  const outbound: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: task }
  ]

  let worktree: WorktreeHandle | null = null
  let report = ''
  let ok = false
  // This agent's own kill switch (requirement: cancel one subagent without killing
  // the run). Chained downward only: the run aborting aborts this, but stopping this
  // lane leaves the run and its siblings alone. Registered under the agentId so
  // `cancelAgent` can find it, and removed in the `finally` so a lane that has
  // already settled can't be "cancelled" afterwards.
  const ctl = new AbortController()
  const runSignal = parent.handle.controller.signal
  const onRunAbort = (): void => ctl.abort()
  if (runSignal.aborted) ctl.abort()
  else runSignal.addEventListener('abort', onRunAbort, { once: true })
  parent.handle.agents.set(agentId, ctl)
  try {
    // Worktree isolation (requirement: sub-agent power-up). When requested, carve a
    // private git worktree and run the WHOLE loop inside `runWithRoot(dir, …)` so
    // every file this agent writes and every command it runs resolves against the
    // worktree, not the shared root — letting parallel isolated agents work without
    // colliding. `createWorktree` returns null (no git / not a repo / failure), in
    // which case we simply run in the shared root: isolation is best-effort.
    if (spawn.isolation === 'worktree') {
      worktree = await createWorktree(agentId, ctl.signal)
    }
    const runLoop = (): Promise<string> =>
      runAgentLoop({
        ...parent,
        role,
        agentId,
        outbound,
        maxSteps: SUBAGENT_MAX_STEPS,
        intentKind: 'edit',
        allowSpawn: false,
        capabilities: resolveRole(role).capabilities,
        filesWritten: opts.filesWritten,
        emit: stampEmit(parent.emit, agentId)
      })
    report = worktree ? await contextManager.runWithRoot(worktree.dir, runLoop) : await runLoop()
    ok = !ctl.signal.aborted
  } catch (err) {
    report = `Subagent error: ${toErrorMessage(err)}`
    ok = false
  } finally {
    parent.handle.agents.delete(agentId)
    runSignal.removeEventListener('abort', onRunAbort)
    // Always wind the worktree down — syncing the agent's changes back into the
    // project and removing the temp branch — even on abort or error, so work isn't
    // stranded and temp dirs don't accumulate. No signal: teardown must complete
    // regardless of cancellation (each git call is still bounded by its timeout).
    if (worktree) {
      const note = await finalizeWorktree(worktree)
      if (note) report = report ? `${report}\n\n${note}` : note
    }
  }

  // Stopped by hand while the run itself carries on: say that plainly, rather than
  // letting a half-finished report read as a conclusion the lead can build on. Files
  // it had already written stay where they are — claiming otherwise would be the lie,
  // since nothing is rolled back here.
  if (ctl.signal.aborted && !runSignal.aborted) {
    const partial = report.trim()
    report =
      'Cancelled by you before it finished. Anything it had already written is still there.' +
      (partial ? `\n\nHow far it got:\n${partial}` : '')
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
 * The project's persistent memory, as the orchestrator's {@link MemoryPort}.
 *
 * This is the seam that makes a run one phase of a roadmap instead of a one-shot:
 * the orchestrator reads where the work stands, plans only the current phase, and
 * closes it by writing STATE.md / TASKS.md / the archive / the checkpoint — so the
 * next turn resumes from what is recorded instead of re-deriving the project (§1).
 *
 * Two deliberate choices:
 *
 *  - **Bookkeeping writes are NOT gated.** STATE.md and TASKS.md go through the
 *    plain `writeProjectFile` path (the same one `scaffoldMemory` uses), because
 *    maintaining the agent's own memory is infrastructure — asking the user to
 *    approve a status line every turn would be noise, not safety. The *plan* still
 *    goes through the gate: `writePlan` is a real tool call.
 *  - **A placeholder reads as absent.** `readDoc` returns null for a doc that is
 *    still the untouched scaffold, so "has this project been specified yet?" is
 *    answered by content, not by the file's existence.
 *
 * Every call resolves against the run's pinned root, because the orchestrator runs
 * inside `pinToRunRoot`. Best-effort throughout: the underlying helpers swallow
 * their own write failures, so a read-only checkout degrades to an unrecorded phase
 * rather than a failed turn.
 */
function projectMemoryPort(): MemoryPort {
  return {
    readState: () => readProjectState(),
    writeState: (patch) => updateProjectState(patch),
    readDoc: (id) => {
      const text = readMemoryDoc(id)
      return text && !isPlaceholder(text) ? text : null
    },
    writeDoc: async (id, content) => {
      try {
        writeProjectFile(memoryDocPath(id), content)
      } catch {
        // A read-only project simply keeps no memory; the turn still stands.
      }
    },
    readPlan: () => {
      try {
        return readProjectFile(activePlanPath())
      } catch {
        return null
      }
    },
    archivePlan: (phase, name, completedIds) =>
      archiveActivePlan(phase, name, activePlanPath(), completedIds),
    decide: (entry) => void appendDecision(entry),
    checkpoint: (cp) => writeSessionCheckpoint(cp)
  }
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
 * The VERIFY stage: runs the project's own checks through the SAME approval gate
 * as any other command, so the user sees and authorizes each one. Distinguishes
 * three outcomes honestly — no check exists / the user declined (`ran: false`, no
 * claim made), the checks passed, or one failed (which the reviewer then sees and
 * can route to rework).
 *
 * Runs EVERY check the project has, not just the first (§34): "it compiles" is not
 * verification, and a phase can't be called done on a typecheck alone. Fails fast —
 * once one check fails there is nothing to learn from the rest, and the run's job
 * is to fix that failure.
 *
 * Type errors and lint problems are read through the `diagnostics` tool rather than
 * `npm run typecheck`/`npm run lint` when the project's checkers are installed: it
 * is the same check, but the reviewer gets sorted, deduped, capped, file-grouped
 * entries instead of a wall of pty-wrapped terminal text. Only what diagnostics
 * genuinely covered is dropped from the script list, and "nothing was checked" is
 * never treated as coverage — so an unusable checker falls back to the script.
 */
async function verifyProject(ctx: ExecContext): Promise<VerifyOutcome> {
  const passed: string[] = []
  let covered: 'typecheck' | 'lint' | 'both' | null = null

  const scope = scopeFor(availableCheckers(realDiagnosticsDeps(contextManager.getRoot())))
  if (scope !== null) {
    const result = await executeTool({ tool: 'diagnostics', scope }, ctx)
    // No result means declined or aborted: unverified, not failed. Fall through to
    // the scripts rather than claiming anything.
    if (result && result.kind === 'diagnostics' && result.ok) {
      if (result.errors > 0) {
        return { ran: true, ok: false, command: `diagnostics (${scope})`, output: result.output }
      }
      // Warnings are not failures — `eslint .` exits 0 on them, and so do we.
      passed.push(`diagnostics (${scope})`)
      covered = scope === 'all' ? 'both' : scope === 'typescript' ? 'typecheck' : 'lint'
    }
  }

  const commands = detectVerifyCommands().filter((command) => {
    if (covered === null) return true
    if (covered === 'both' || covered === 'typecheck') {
      if (command === 'npm run typecheck') return false
    }
    if (covered === 'both' || covered === 'lint') {
      if (command === 'npm run lint') return false
    }
    return true
  })
  if (commands.length === 0 && passed.length === 0) return { ran: false, ok: false }

  for (const command of commands) {
    const result = await executeTool({ tool: 'run_command', command }, ctx)
    // A null exit code (or no result) means it never actually ran — declined or
    // aborted. That is "unverified", not "failed": stop asking, and report only
    // what genuinely ran. We don't manufacture evidence in either direction.
    if (!result || result.kind !== 'run_command' || result.exitCode === null) break
    if (result.exitCode !== 0) return { ran: true, ok: false, command, output: result.output }
    passed.push(command)
  }
  return passed.length > 0
    ? { ran: true, ok: true, command: passed.join(' && ') }
    : { ran: false, ok: false, command: commands[0] }
}

/**
 * The project's verification commands, cheapest first, or an empty list when it has
 * none (a non-Node project, or no package.json). Best-effort and never throws — an
 * unreadable/malformed manifest simply means "no checks".
 *
 * `build` is skipped when the project also has a `typecheck` script: for a typed
 * project the two prove the same thing and a production build is minutes of work
 * for no extra signal.
 */
function detectVerifyCommands(): string[] {
  let scripts: Record<string, unknown>
  try {
    const pkg = JSON.parse(readProjectFile('package.json')) as { scripts?: Record<string, unknown> }
    scripts = pkg.scripts ?? {}
  } catch {
    return []
  }
  const usable = (name: string): boolean => {
    const script = scripts[name]
    return typeof script === 'string' && !!script.trim() && !WATCHER_RE.test(script)
  }
  const out: string[] = []
  for (const name of VERIFY_SCRIPTS) {
    if (!usable(name)) continue
    if (name === 'build' && usable('typecheck')) continue
    out.push(`npm run ${name}`)
  }
  return out
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
 * with the current plan the lead maintains. Resolved through
 * {@link activePlanPath}, so the plan is found in the project's agent-memory folder
 * (`.claude/plan.md` / `.sylor/plan.md`) as well as at the historical project root.
 * Best-effort: a missing file or a path error yields '' (the plan may not exist
 * yet). Truncated so a huge plan can't blow the subagent's context budget.
 */
function readPlanMd(): string {
  try {
    const content = readProjectFile(activePlanPath()).trim()
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
 * `followupDirective` deliberately is NOT omitted: a specialist reading code it was
 * not asked to change is the likeliest one to spot an out-of-scope loose end, and
 * flagging one writes nothing it wasn't already allowed to write.
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
    followupDirective() +
    roleDirectiveFor(role)
  const userProfile = buildUserProfilePreamble(task)
  if (userProfile) system += `\n\n${userProfile}`
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
   * The subagent this op belongs to, if any. Two things key off it: which abort
   * signal governs the op ({@link signalFor}), and which lane a pending approval
   * belongs to when the user stops one agent. Absent = the lead / orchestrator.
   */
  agentId?: string
  /**
   * The acting role's capabilities. When present, a tool kind the role isn't
   * granted is refused before any approval is asked for. Absent = unrestricted
   * (the lead).
   */
  capabilities?: readonly Capability[]
  /**
   * A hard whitelist of tool kinds, independent of capabilities. Cowork passes
   * `['browse']`: it must have NO files and NO terminal, and capabilities alone
   * can't express that because `allowsTool('read')` is unconditionally true.
   * Absent = no allowlist (Code mode).
   */
  toolAllowlist?: readonly ToolKind[]
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
    tool:
      | 'write_file'
      | 'edit_file'
      | 'read_file'
      | 'list_files'
      | 'search_files'
      | 'find_files'
      | 'run_command'
      | 'web_fetch'
      | 'web_search'
      | 'install_plugin'
      | 'mcp_call'
      | 'preview_inspect'
      | 'browse'
      | 'diagnostics'
  }
>

/**
 * Base environment shared by every hook fired for a run: the event name and the
 * workspace root the command already runs in. Hooks read these `SYLOR_*` vars to
 * know why they were invoked.
 */
function baseHookEnv(event: HookEvent): Record<string, string> {
  return { SYLOR_HOOK_EVENT: event, SYLOR_PROJECT_ROOT: contextManager.getRoot() }
}

/**
 * Per-tool hook context: the tool name (matched against a hook's `matcher`), a
 * JSON dump of the tool's input, and a few convenience vars (file path, command,
 * url) so a hook can act without parsing JSON. Best-effort — a value that can't
 * serialize is simply omitted.
 */
function toolHookEnv(event: HookEvent, tool: ExecutableTool): Record<string, string> {
  const env = baseHookEnv(event)
  env.SYLOR_TOOL_NAME = tool.tool
  try {
    env.SYLOR_TOOL_INPUT = JSON.stringify(tool)
  } catch {
    // A value that won't serialize (shouldn't happen for a parsed tool) is skipped.
  }
  if ('path' in tool && typeof tool.path === 'string') env.SYLOR_FILE_PATH = tool.path
  if (tool.tool === 'run_command') env.SYLOR_COMMAND = tool.command
  if (tool.tool === 'web_fetch') env.SYLOR_URL = tool.url
  return env
}

/**
 * Adapter turning the pty-backed {@link runCommand} into the {@link
 * HookCommandRunner} the pure hooks core expects: output is captured (not
 * streamed to the integrated terminal — hooks are plumbing, not agent work), the
 * run's abort signal cancels it, and `timeoutMs` bounds it.
 */
function hookRunner(signal: AbortSignal): HookCommandRunner {
  return async (command, env, timeoutMs) => {
    const res = await runCommand(command, () => {}, signal, { env, timeoutMs })
    return { exitCode: res.exitCode, output: res.output }
  }
}

/**
 * Fire a run-lifecycle hook (`UserPromptSubmit` at the start of a run, `Stop` at
 * the end). Neither blocks — they run for their side effects (prep context, send
 * a notification) and their exit codes are ignored. A missing/empty config is a
 * no-op with zero overhead. Never throws, so a bad hook can't derail a run.
 */
async function runLifecycleHooks(
  event: 'UserPromptSubmit' | 'Stop',
  signal: AbortSignal,
  extra: Record<string, string>
): Promise<void> {
  const hooks = getSettings().hooks
  if (!hooks?.[event]?.length) return
  try {
    await runHooks(hooks, event, { env: { ...baseHookEnv(event), ...extra } }, hookRunner(signal))
  } catch (err) {
    console.error(`[sylor] ${event} hook failed:`, err)
  }
}

/** Cap on a `server_logs` reply — the tail is kept, since the failure is newest. */
const MAX_SERVER_LOG_CHARS = 8_000

/**
 * Answer a `server_logs` preview action from the dev server's own output.
 *
 * Shaped like a renderer reply so the executor can use it interchangeably with a
 * round-trip result. The two "no logs" cases are kept apart on purpose (the same
 * honesty rule the browse reads follow): a static preview never had a server to
 * print anything, which is a different fact from a server that ran and stayed
 * quiet, and a filtered read that finds nothing must not read as "all clear" when
 * the filter itself is what hid the lines.
 */
function readDevServerLogs(level: 'all' | 'error' | 'warn' | undefined): PreviewInspectResponse {
  const wanted = level ?? 'all'
  const { command, lines, total, watching } = devServerLogs(wanted)
  const header = command ? `$ ${command}\n` : ''
  if (!watching) {
    return {
      requestId: '',
      ok: true,
      output:
        'No dev server has been started, so there is no server output to read. This preview is served statically — a compile error would come from a build command instead.',
      truncated: false,
      summary: 'no dev server'
    }
  }
  if (lines.length === 0) {
    const scope = wanted === 'error' ? 'errors' : wanted === 'warn' ? 'warnings or errors' : 'output'
    const note =
      total > 0 && wanted !== 'all'
        ? ` ${total} other line${total === 1 ? '' : 's'} were logged — read them with level "all".`
        : ''
    return {
      requestId: '',
      ok: true,
      output: `${header}The dev server has printed no ${scope}.${note}`,
      truncated: false,
      summary: `0 ${scope}`
    }
  }
  const body = header + lines.join('\n')
  const truncated = body.length > MAX_SERVER_LOG_CHARS
  return {
    requestId: '',
    ok: true,
    output: truncated ? `…(earlier output dropped)\n${body.slice(-MAX_SERVER_LOG_CHARS)}` : body,
    truncated,
    summary: `${lines.length} line${lines.length === 1 ? '' : 's'}${
      wanted === 'all' ? '' : ` (${wanted})`
    }`
  }
}

/**
 * Turns a proposal into the checkpoint's timeline label — what the user is going
 * back to a point *before*. Deliberately names the specific file or command, since
 * "Before step 4" tells nobody anything a week later.
 */
function checkpointLabel(proposal: ToolProposal): string {
  if (proposal.kind === 'write_file') return `Before writing ${proposal.path}`
  if (proposal.kind === 'run_command') return `Before running ${proposal.command.slice(0, 120)}`
  return 'Before an edit'
}

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
  // Agent-scoped: cancelling one lane must stop that lane's ops, and only those.
  const signal = signalFor(handle, ctx.agentId)

  // Build the proposal (resolving file diffs up front for write_file / edit_file).
  let proposal: ToolProposal
  try {
    if (tool.tool === 'write_file') {
      const { exists, oldContent, newContent } = proposeWrite(tool.path, tool.content)
      proposal = {
        id,
        kind: 'write_file',
        path: tool.path,
        oldContent,
        newContent,
        exists,
        ...(tool.purpose ? { purpose: tool.purpose } : {})
      }
    } else if (tool.tool === 'edit_file') {
      // A surgical edit becomes an ordinary write_file proposal: every replacement is
      // resolved (in order) against the file's CURRENT contents here, so one block
      // carrying several edits still yields ONE diff, ONE approval, and one action.
      // The user reviews that diff, the permission gate is unchanged, and every
      // downstream consumer (diff stats, filesWritten, auto-preview) keeps working.
      // A miss or an ambiguous match throws and lands in the catch below.
      const { oldContent, newContent } = applyEdits(tool.path, tool.edits)
      proposal = {
        id,
        kind: 'write_file',
        path: tool.path,
        oldContent,
        newContent,
        exists: true,
        ...(tool.purpose ? { purpose: tool.purpose } : {})
      }
    } else if (tool.tool === 'read_file') {
      // The window the read ACTUALLY uses is not the one the model asked for: the
      // first read of a path is always whole. A model cannot pick a useful line
      // range before it has seen the file, so a guessed `offset`/`limit` buys a
      // keyhole, a second read, and a distinct cache key that dedupes against
      // nothing — the `lines 830–889 of 1769` loop. See `gather.ts`.
      proposal = {
        id,
        kind: 'read',
        op: 'read_file',
        path: tool.path,
        ...planReadWindow(hasCompleteRead(handle.readCache, tool.path), tool.offset)
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
        glob: tool.glob,
        before: tool.before,
        after: tool.after,
        context: tool.context,
        multiline: tool.multiline,
        mode: tool.mode
      }
    } else if (tool.tool === 'find_files') {
      proposal = { id, kind: 'read', op: 'find_files', path: tool.path, glob: tool.glob }
    } else if (tool.tool === 'run_command') {
      proposal = { id, kind: 'run_command', command: tool.command }
    } else if (tool.tool === 'web_fetch') {
      proposal = { id, kind: 'web_fetch', url: tool.url }
    } else if (tool.tool === 'web_search') {
      proposal = { id, kind: 'web_search', query: tool.query }
    } else if (tool.tool === 'install_plugin') {
      proposal = { id, kind: 'install_plugin', source: tool.source, scope: tool.scope }
    } else if (tool.tool === 'mcp_call') {
      proposal = {
        id,
        kind: 'mcp_call',
        server: tool.server,
        name: tool.name,
        arguments: tool.arguments
      }
    } else if (tool.tool === 'browse') {
      // `risk` is decided HERE, not by the model: the permission gate keys off it
      // (a click that pays is refused; one that sends/deletes always asks), so the
      // classification must come from our own regexes over the target's label.
      proposal = {
        id,
        kind: 'browse',
        action: tool.action,
        url: tool.url,
        target: tool.target,
        text: tool.text,
        submit: tool.submit,
        direction: tool.direction,
        visual: tool.visual,
        selector: tool.selector,
        styles: tool.styles,
        level: tool.level,
        filter: tool.filter,
        risk: classifyBrowse(tool)
      }
    } else if (tool.tool === 'diagnostics') {
      // `scope` defaults HERE rather than in the parser: the proposal is the shape
      // the user sees in the permission bar, so it must say what will really run.
      proposal = { id, kind: 'diagnostics', scope: tool.scope ?? 'all', files: tool.files }
    } else {
      proposal = {
        id,
        kind: 'preview_inspect',
        action: tool.action,
        selector: tool.selector,
        styles: tool.styles,
        value: tool.value,
        level: tool.level,
        filter: tool.filter,
        preset: tool.preset,
        width: tool.width,
        height: tool.height,
        expression: tool.expression,
        url: tool.url
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

  // The permission decision. Everything but `browse` keys off the tool kind and the
  // run's mode. A browse keys off the RISK CLASS the step was classified as, and is
  // the only tool that can be refused OUTRIGHT instead of merely asked about —
  // which is exactly why it needs its own gate: `decideAuto` has no `block`.
  let outcome: PermissionOutcome
  if (proposal.kind === 'browse') {
    const risk = proposal.risk ?? 'read'
    const verdict = decideBrowse(
      risk,
      getSettings().browser,
      permissionMode,
      fullAccessEnabled(),
      autoSendEnabled()
    )
    if (verdict === 'block') {
      emit({ type: 'tool-request', runId, proposal, auto: false })
      const result = rejectedResult(
        proposal,
        risk === 'payment'
          ? 'Refused: Sylor never pays, orders, or subscribes on the user’s behalf. ' +
              'Tell the user what you found and let them finish this step themselves.'
          : `Refused: the user’s browser policy blocks “${risk}” actions.`
      )
      emit({ type: 'tool-result', runId, result })
      return result
    }
    outcome = verdict
  } else {
    outcome = decideAuto(permissionMode, proposal.kind, fullAccessEnabled())
    // A standing approval granted earlier in this run answers for this op, so a
    // long build stops re-asking about the same class of work. The key is
    // re-derived here rather than trusted from the renderer, so only what
    // {@link standingApprovalKey} deems escalatable can ever be covered — and the
    // browse branch above never reaches this, keeping the browser policy supreme.
    if (outcome === 'ask') {
      const standing = standingApprovalKey(proposal)
      if (standing && handle.standingApprovals.has(standing)) outcome = 'auto'
    }
  }

  // Mode gate (Cowork). A hard whitelist, checked before capabilities: Cowork is a
  // chat assistant with a browser and nothing else, so a file or terminal op is
  // refused here even though `allowsTool('read')` would wave it through.
  if (ctx.toolAllowlist && !ctx.toolAllowlist.includes(proposal.kind)) {
    emit({ type: 'tool-request', runId, proposal, auto: false })
    const result = rejectedResult(
      proposal,
      `Not available in this mode (${proposal.kind}). You have no access to the user’s ` +
        'files, folders, or terminal here — answer, or use the browser.'
    )
    emit({ type: 'tool-result', runId, result })
    return result
  }

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

  // Read-dedup (Problem 1), checked BEFORE the card is emitted. A repeat read of a
  // file nothing has changed since is not work — it is the agent forgetting what it
  // already has — so it must not look like work either: no `Read Navbar.tsx ·
  // already read (unchanged)` row for the user to scroll past, no approval prompt,
  // no hooks, no disk hit. The note still goes back to the MODEL as this call's
  // result (via `summarizeResults`), which is what actually stops the loop.
  //
  // Because `planReadWindow` makes the first read of a path whole, the whole-file
  // entry also answers a later window of the same path — the `lines 1–70 of 172`
  // third read in the report that prompted this.
  const cachedRead = servedFromReadCache(handle.readCache, proposal)
  if (cachedRead) return cachedRead

  emit({ type: 'tool-request', runId, proposal, auto: outcome === 'auto' })

  const { decision, detail } =
    outcome === 'auto'
      ? { decision: 'approve' as ToolDecision, detail: undefined }
      : await awaitDecision(handle, id, ctx.agentId)
  if (signal.aborted) return null

  // "Always" is an approval plus a standing grant for the rest of the run. Record
  // it before acting, so an op proposed while this one was waiting is covered too —
  // and record it in the conversation as well, because a grant quietly changes how
  // the rest of the run behaves and the user should be able to see they gave it.
  if (decision === 'approve-always') {
    const standing = standingApprovalKey(proposal)
    if (standing && !handle.standingApprovals.has(standing)) {
      handle.standingApprovals.add(standing)
      const note = standingApprovalNote(proposal)
      if (note) emit({ type: 'delta', runId, text: `\n\n_${note}_\n\n` })
    }
  }

  if (decision === 'reject') {
    // A user "no" is a decision to respect, not a failure to retry: record the id so
    // the retry-on-failure nudge skips it (§4d⁗′). The "Skipped by user" result still
    // goes back to the model, so it can adjust or ask — just not be pushed to re-attempt
    // the exact thing the user declined.
    handle.refused.add(proposal.id)
    // …and when they said WHY, that is the most useful sentence in the whole turn:
    // "wrong folder" turns a dead end into a correction. Quoted and bounded, so it
    // reads as the user's words and one pasted essay can't flood the context.
    const why = detail?.reason?.trim()
    const result = rejectedResult(
      proposal,
      why ? `Skipped by user — they said: “${capReason(why)}”` : undefined
    )
    emit({ type: 'tool-result', runId, result })
    return result
  }

  // Edit-then-approve: the user fixed the file in the diff before it reached disk, so
  // THEIR bytes are what gets written. Only a write_file can carry this (the renderer
  // only offers it there, and the engine refuses to honor it anywhere else rather than
  // trusting the payload), and the swap happens before the hooks below so a PreToolUse
  // hook sees the content that is actually about to land.
  let userEdited = false
  if (proposal.kind === 'write_file' && detail?.editedContent != null) {
    if (detail.editedContent !== proposal.newContent) {
      proposal = { ...proposal, newContent: detail.editedContent }
      userEdited = true
    }
  }

  // PreToolUse hooks (Phase 4). A non-zero exit BLOCKS the tool — the final
  // programmatic gate, sitting after the user's own approval so an automation can
  // veto even an auto-approved op (e.g. refuse a destructive `rm -rf` while the
  // run is autonomous). A missing/empty config skips this with no overhead.
  const hooks = getSettings().hooks
  if (hooks?.PreToolUse?.length) {
    const pre = await runHooks(
      hooks,
      'PreToolUse',
      { toolName: tool.tool, env: toolHookEnv('PreToolUse', tool) },
      hookRunner(signal)
    )
    if (signal.aborted) return null
    if (pre.blocked) {
      const result = rejectedResult(proposal, pre.reason ?? 'Blocked by a PreToolUse hook.')
      emit({ type: 'tool-result', runId, result })
      return result
    }
  }

  // A restore point, taken BEFORE the bytes change (Phase 5) — after the approval and
  // the PreToolUse gate, so nothing is recorded for an op that never happens.
  //
  // Only against the user's real project root: a worktree-isolated subagent already
  // has git's own branch as its way back, and snapshotting a directory that is about
  // to be torn down would leave the timeline pointing at nothing. `createCheckpoint`
  // dedupes by tree, so a step that changed nothing adds no row and emits nothing;
  // it also resolves null rather than throwing, so a project git can't reach cannot
  // stop the write.
  if (proposal.kind === 'write_file' || proposal.kind === 'run_command') {
    const root = contextManager.getRoot()
    if (root === contextManager.getProjectRoot()) {
      // The no-git fallback can only copy files it is told about: everything this run
      // has written so far, plus the one about to be overwritten.
      const files = new Set(ctx.filesWritten ?? [])
      if (proposal.kind === 'write_file') files.add(proposal.path)
      const snapshot = await createCheckpoint(root, checkpointLabel(proposal), {
        runId,
        files: [...files],
        signal
      })
      if (snapshot?.created) {
        emit({ type: 'checkpoint', runId, checkpoint: snapshot.checkpoint })
      }
    }
  }

  // The op actually runs, and the per-run read cache + the persistent `.sylor` index
  // record what it did: a read is remembered by window (with whether it reached the
  // end of the file), a write evicts every cached window of that path, and a command
  // clears the cache outright since it could have touched anything. The dedup
  // short-circuit above is the only reader of that state.
  const result = await applyTool(proposal, onTerminal, signal)
  updateReadCache(handle.readCache, proposal, result)
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
    // Say so when the bytes on disk are the user's edit rather than the model's own
    // text, so the next step works from what is really there instead of quietly
    // diverging from it. `summarizeResults` puts this in front of the model.
    if (userEdited) result.edited = true
  }
  // PostToolUse hooks (Phase 4): fired for side effects (a formatter, a notifier,
  // a log) after the op ran. They CANNOT block — the tool already happened — so
  // exit codes are ignored. Skipped on a cancelled run. Reuses the same config
  // read above so a mid-run settings edit can't split Pre/Post.
  if (hooks?.PostToolUse?.length && !signal.aborted) {
    const env = toolHookEnv('PostToolUse', tool)
    env.SYLOR_TOOL_OK = String('ok' in result ? result.ok !== false : true)
    await runHooks(hooks, 'PostToolUse', { toolName: tool.tool, env }, hookRunner(signal))
  }
  emit({ type: 'tool-result', runId, result })
  return result
}

/**
 * Blocks until the renderer resolves the decision for `toolId` (or the run/agent
 * aborts). Resolves with the verb AND whatever the user attached to it — the file
 * they edited first, the reason they said no.
 */
function awaitDecision(
  handle: RunHandle,
  toolId: string,
  agentId?: string
): Promise<{ decision: ToolDecision; detail?: ToolDecisionDetail }> {
  return new Promise((resolve) => {
    handle.pending.set(toolId, {
      agentId,
      resolve: (decision, detail) => {
        handle.pending.delete(toolId)
        resolve({ decision, detail })
      }
    })
  })
}

/** Blocks until the renderer answers `questionId` (or the run aborts/cancels). */
function awaitAnswer(handle: RunHandle, questionId: string): Promise<string> {
  return new Promise((resolve) => {
    handle.pendingQuestions.set(questionId, {
      resolve: (answer) => {
        handle.pendingQuestions.delete(questionId)
        resolve(answer)
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
  if (
    tool.tool === 'read_file' ||
    tool.tool === 'list_files' ||
    tool.tool === 'search_files' ||
    tool.tool === 'find_files'
  ) {
    return {
      proposal: {
        id,
        kind: 'read',
        op: tool.tool,
        path: tool.path,
        query: tool.tool === 'search_files' ? tool.query : undefined,
        glob: tool.tool === 'find_files' ? tool.glob : undefined
      },
      result: {
        id,
        kind: 'read',
        ok: false,
        output: '',
        truncated: false,
        summary: 'failed',
        error
      }
    }
  }
  if (tool.tool === 'web_fetch') {
    return {
      proposal: { id, kind: 'web_fetch', url: tool.url },
      result: { id, kind: 'web_fetch', ok: false, output: '', truncated: false, error }
    }
  }
  if (tool.tool === 'web_search') {
    return {
      proposal: { id, kind: 'web_search', query: tool.query },
      result: { id, kind: 'web_search', ok: false, output: '', truncated: false, error }
    }
  }
  if (tool.tool === 'install_plugin') {
    return {
      proposal: { id, kind: 'install_plugin', source: tool.source, scope: tool.scope },
      result: { id, kind: 'install_plugin', ok: false, output: '', error }
    }
  }
  if (tool.tool === 'preview_inspect') {
    return {
      proposal: {
        id,
        kind: 'preview_inspect',
        action: tool.action,
        selector: tool.selector,
        styles: tool.styles,
        value: tool.value,
        level: tool.level,
        filter: tool.filter,
        preset: tool.preset,
        width: tool.width,
        height: tool.height,
        expression: tool.expression,
        url: tool.url
      },
      result: {
        id,
        kind: 'preview_inspect',
        ok: false,
        action: tool.action,
        output: '',
        truncated: false,
        summary: 'failed',
        error
      }
    }
  }
  if (tool.tool === 'browse') {
    return {
      proposal: {
        id,
        kind: 'browse',
        action: tool.action,
        url: tool.url,
        target: tool.target,
        text: tool.text,
        submit: tool.submit,
        direction: tool.direction,
        visual: tool.visual,
        selector: tool.selector,
        styles: tool.styles,
        level: tool.level,
        filter: tool.filter,
        risk: classifyBrowse(tool)
      },
      result: {
        id,
        kind: 'browse',
        ok: false,
        action: tool.action,
        output: '',
        truncated: false,
        summary: 'failed',
        error
      }
    }
  }
  if (tool.tool === 'diagnostics') {
    return {
      proposal: { id, kind: 'diagnostics', scope: tool.scope ?? 'all', files: tool.files },
      result: {
        id,
        kind: 'diagnostics',
        ok: false,
        entries: [],
        errors: 0,
        warnings: 0,
        truncated: false,
        ran: [],
        skipped: [],
        output: '',
        summary: 'failed',
        error
      }
    }
  }
  const path = tool.tool === 'write_file' || tool.tool === 'edit_file' ? tool.path : ''
  return {
    proposal: { id, kind: 'write_file', path, oldContent: '', newContent: '', exists: false },
    result: { id, kind: 'write_file', ok: false, error }
  }
}

/**
 * Longest rejection reason carried back to the model. The reason is the user's own
 * words typed at the permission bar, so it is normally a phrase — the cap only
 * exists so a pasted stack trace can't take a slice of every later prompt.
 */
const REJECT_REASON_CHARS = 400

/** The user's reason, bounded and marked when it had to be cut. */
function capReason(text: string): string {
  return text.length <= REJECT_REASON_CHARS ? text : `${text.slice(0, REJECT_REASON_CHARS)}…`
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
  if (proposal.kind === 'web_fetch') {
    return {
      id: proposal.id,
      kind: 'web_fetch',
      ok: false,
      output: '',
      truncated: false,
      error: reason
    }
  }
  if (proposal.kind === 'web_search') {
    return {
      id: proposal.id,
      kind: 'web_search',
      ok: false,
      output: '',
      truncated: false,
      error: reason
    }
  }
  if (proposal.kind === 'install_plugin') {
    return { id: proposal.id, kind: 'install_plugin', ok: false, output: '', error: reason }
  }
  if (proposal.kind === 'preview_inspect') {
    return {
      id: proposal.id,
      kind: 'preview_inspect',
      ok: false,
      action: proposal.action,
      output: '',
      truncated: false,
      summary: 'skipped',
      error: reason
    }
  }
  if (proposal.kind === 'browse') {
    return {
      id: proposal.id,
      kind: 'browse',
      ok: false,
      action: proposal.action,
      output: '',
      truncated: false,
      summary: 'skipped',
      error: reason
    }
  }
  if (proposal.kind === 'diagnostics') {
    return {
      id: proposal.id,
      kind: 'diagnostics',
      ok: false,
      entries: [],
      errors: 0,
      warnings: 0,
      truncated: false,
      ran: [],
      skipped: [],
      output: '',
      summary: 'skipped',
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
      // read_file first checks whether the target is an image to VIEW rather than
      // text to read; readMediaFile returns null for an ordinary file, so text
      // reads fall straight through to the line-windowed reader. Capturing the
      // media outcome in its own binding keeps `.media` precisely typed (a `??`
      // union with ReadOutcome would collapse it away).
      const media = proposal.op === 'read_file' ? readMediaFile(proposal.path) : null
      const outcome =
        media ??
        (proposal.op === 'read_file'
          ? readFileSlice(proposal.path, proposal.offset, proposal.limit)
          : proposal.op === 'list_files'
            ? listDirectory(proposal.path)
            : proposal.op === 'find_files'
              ? findFiles(proposal.glob ?? '', proposal.path)
              : searchProject(proposal.query ?? '', proposal.path, proposal.glob, {
                  before: proposal.before,
                  after: proposal.after,
                  context: proposal.context,
                  multiline: proposal.multiline,
                  mode: proposal.mode
                }))
      return {
        id: proposal.id,
        kind: 'read',
        ok: true,
        output: outcome.output,
        truncated: outcome.truncated,
        summary: outcome.summary,
        media: media?.media
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

  // web_fetch — reach the network for a page's text. fetchUrl never throws (bad
  // URL, blocked host, timeout, and network error all come back as an outcome),
  // and honours the abort signal, so no extra plumbing here.
  if (proposal.kind === 'web_fetch') {
    onTerminal(`\r\n\x1b[38;5;39m🌐 ${proposal.url}\x1b[0m\r\n`)
    const outcome = await fetchUrl(proposal.url, signal)
    if (outcome.ok) {
      onTerminal(`\x1b[32m✓ fetched ${proposal.url}\x1b[0m\r\n`)
    } else {
      onTerminal(`\x1b[31m${outcome.error ?? 'Fetch failed.'}\x1b[0m\r\n`)
    }
    return {
      id: proposal.id,
      kind: 'web_fetch',
      ok: outcome.ok,
      output: outcome.output,
      truncated: outcome.truncated,
      error: outcome.error
    }
  }

  // web_search — reach the network for a ranked result list. searchWeb never throws
  // (network error, timeout, or empty result all come back as an outcome) and honours
  // the abort signal, mirroring web_fetch, so no extra plumbing here.
  if (proposal.kind === 'web_search') {
    onTerminal(`\r\n\x1b[38;5;39m🔎 ${proposal.query}\x1b[0m\r\n`)
    const outcome = await searchWeb(proposal.query, signal)
    if (outcome.ok) {
      onTerminal(`\x1b[32m✓ searched\x1b[0m\r\n`)
    } else {
      onTerminal(`\x1b[31m${outcome.error ?? 'Search failed.'}\x1b[0m\r\n`)
    }
    return {
      id: proposal.id,
      kind: 'web_search',
      ok: outcome.ok,
      output: outcome.output,
      truncated: outcome.truncated,
      error: outcome.error
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

  // install_plugin — clone (git) or read (local) a plugin source and add every
  // skill/command/connector it bundles. installPlugin never throws — a bad source,
  // a missing Git, an empty repo, or a write error all return as a result — and
  // honours the abort signal during the clone.
  if (proposal.kind === 'install_plugin') {
    onTerminal(`\r\n\x1b[38;5;39m📦 installing ${proposal.source}\x1b[0m\r\n`)
    const outcome = await installPlugin(
      { source: proposal.source, scope: proposal.scope },
      contextManager.getRoot(),
      signal
    )
    if (!outcome.ok || !outcome.plugin) {
      onTerminal(`\x1b[31m${outcome.error ?? 'Install failed.'}\x1b[0m\r\n`)
      return {
        id: proposal.id,
        kind: 'install_plugin',
        ok: false,
        output: '',
        error: outcome.error ?? 'Install failed.'
      }
    }
    const c = outcome.plugin.contents
    const count = (n: number, one: string): string => (n ? `${n} ${one}${n > 1 ? 's' : ''}` : '')
    const parts = [
      count(c.skills.length, 'skill'),
      count(c.commands.length, 'command'),
      count(c.connectors.length, 'connector')
    ].filter(Boolean)
    const detail = [
      c.skills.length ? `skills: ${c.skills.join(', ')}` : '',
      c.commands.length ? `commands: ${c.commands.join(', ')}` : '',
      c.connectors.length ? `connectors: ${c.connectors.join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    // Refresh the cached registries so the new skills/commands are usable at once;
    // MCP connectors are read from disk on the next connect.
    skillsRegistry.reload(contextManager.getRoot())
    commandsRegistry.reload(contextManager.getRoot())
    onTerminal(`\x1b[32m✓ installed ${outcome.plugin.name}\x1b[0m\r\n`)
    return {
      id: proposal.id,
      kind: 'install_plugin',
      ok: true,
      plugin: outcome.plugin.name,
      output: `Installed ${outcome.plugin.name}${parts.length ? ` — ${parts.join(', ')}` : ''}.${detail ? `\n${detail}` : ''}`
    }
  }

  // preview_inspect — verify the live preview. The preview is a RENDERER-owned
  // <webview>, so the engine can't touch it directly: requestPreviewInspect does
  // a main→renderer→main round-trip (or resolves an actionable failure when no
  // preview/window is available). It never throws, so no try/catch here. A
  // "screenshot" comes back with `media` bytes that ride the vision path (step 4h).
  if (proposal.kind === 'preview_inspect') {
    onTerminal(`\r\n\x1b[38;5;39m🔍 preview: ${proposal.action}\x1b[0m\r\n`)
    // server_logs is the one action answered HERE: the dev server's output belongs
    // to the main process, so a round-trip to the renderer would ask the wrong
    // process — and it works even when no page ever loaded, which is exactly when a
    // compile error needs reading.
    const res =
      proposal.action === 'server_logs'
        ? readDevServerLogs(proposal.level)
        : await requestPreviewInspect({
            action: proposal.action,
            selector: proposal.selector,
            styles: proposal.styles,
            value: proposal.value,
            level: proposal.level,
            filter: proposal.filter,
            preset: proposal.preset,
            width: proposal.width,
            height: proposal.height,
            expression: proposal.expression,
            url: proposal.url
          })
    if (res.ok) {
      onTerminal(`\x1b[32m✓ ${res.summary}\x1b[0m\r\n`)
    } else {
      onTerminal(`\x1b[31m${res.error ?? 'Preview inspection failed.'}\x1b[0m\r\n`)
    }
    // A console read is the one inspection that says whether the served page is
    // actually healthy, so it feeds the preview health signal STATE.md records
    // (§23): `[error]` lines mean it compiled and served but is throwing.
    if (res.ok && proposal.action === 'console_logs') {
      notePreviewRuntimeError(res.output.includes('[error]'))
    }
    return {
      id: proposal.id,
      kind: 'preview_inspect',
      ok: res.ok,
      action: proposal.action,
      output: res.output,
      truncated: res.truncated,
      summary: res.summary,
      media: res.media,
      error: res.error
    }
  }

  // browse — USE the web in a real browser. Unlike preview_inspect there is no
  // round-trip: the page view is main-owned (or the user's own Chrome over CDP),
  // so runBrowserAction drives it directly. It never throws — every failure is a
  // value — and after a non-`read` action it settles and re-perceives, so one step
  // returns both what happened and the page it landed on. A visual read comes back
  // with `media` bytes that ride the vision path (step 4h).
  if (proposal.kind === 'browse') {
    onTerminal(`\r\n\x1b[38;5;39m🌐 ${describeBrowse(proposal)}\x1b[0m\r\n`)
    const res = await runBrowserAction({
      action: proposal.action,
      url: proposal.url,
      target: proposal.target,
      text: proposal.text,
      submit: proposal.submit,
      direction: proposal.direction,
      visual: proposal.visual,
      selector: proposal.selector,
      styles: proposal.styles,
      level: proposal.level,
      filter: proposal.filter
    })
    if (res.ok) {
      onTerminal(`\x1b[32m✓ ${res.summary}\x1b[0m\r\n`)
    } else {
      onTerminal(`\x1b[31m${res.error ?? 'Browsing failed.'}\x1b[0m\r\n`)
    }
    return {
      id: proposal.id,
      kind: 'browse',
      ok: res.ok,
      action: proposal.action,
      output: res.output,
      truncated: res.truncated,
      summary: res.summary,
      url: res.url,
      media: res.media,
      error: res.error
    }
  }

  // diagnostics — run the project's own checkers and read the problems back as
  // structured data. runDiagnostics never throws (a missing checker, a crashed one,
  // and a cancelled one are all values) and honours the abort signal through its
  // injected exec, so no extra plumbing here. Note `ok` means the checkers RAN:
  // a project where nothing could be checked comes back ok:false, never "clean".
  if (proposal.kind === 'diagnostics') {
    onTerminal(`\r\n\x1b[38;5;208m🩺 diagnostics (${proposal.scope})\x1b[0m\r\n`)
    const report = await runDiagnostics(
      { scope: proposal.scope, files: proposal.files, signal },
      realDiagnosticsDeps(contextManager.getRoot())
    )
    if (report.ok) {
      onTerminal(`\x1b[32m✓ ${report.summary}\x1b[0m\r\n`)
    } else {
      onTerminal(`\x1b[31m${report.error ?? 'No checker could be run.'}\x1b[0m\r\n`)
    }
    return { id: proposal.id, kind: 'diagnostics', ...report }
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
    (
      t
    ): t is Extract<
      ExecutableTool,
      { tool: 'read_file' | 'list_files' | 'search_files' | 'find_files' }
    > =>
      t.tool === 'read_file' ||
      t.tool === 'list_files' ||
      t.tool === 'search_files' ||
      t.tool === 'find_files'
  )
  const fetches = tools.filter(
    (t): t is Extract<ExecutableTool, { tool: 'web_fetch' }> => t.tool === 'web_fetch'
  )
  const searches = tools.filter(
    (t): t is Extract<ExecutableTool, { tool: 'web_search' }> => t.tool === 'web_search'
  )
  const installs = tools.filter(
    (t): t is Extract<ExecutableTool, { tool: 'install_plugin' }> => t.tool === 'install_plugin'
  )
  const previews = tools.filter(
    (t): t is Extract<ExecutableTool, { tool: 'preview_inspect' }> => t.tool === 'preview_inspect'
  )
  const browses = tools.filter(
    (t): t is Extract<ExecutableTool, { tool: 'browse' }> => t.tool === 'browse'
  )
  const checks = tools.filter(
    (t): t is Extract<ExecutableTool, { tool: 'diagnostics' }> => t.tool === 'diagnostics'
  )
  const firstCmd = (): string => commands[0].command.trim().split(/\s+/).slice(0, 3).join(' ')

  // A plugin install → the executing phase, naming the source.
  if (installs.length > 0) {
    return { stage: 'executing', message: `Installing ${installs[0].source}` }
  }

  // A browse (no files, no commands) → the scanning phase, describing the step the
  // way the user would say it ("Opening example.com", "Clicking Compose").
  if (browses.length > 0 && commands.length === 0 && writes.length === 0 && reads.length === 0) {
    const said = describeBrowse(browses[0])
    return { stage: 'scanning', message: said.charAt(0).toUpperCase() + said.slice(1) }
  }

  // A preview inspection → the verifying phase, naming the action.
  if (previews.length > 0 && commands.length === 0 && writes.length === 0 && reads.length === 0) {
    return {
      stage: 'verifying',
      message:
        previews.length === 1
          ? `Checking the preview · ${previews[0].action}`
          : `Checking the preview · ${previews.length} looks`
    }
  }

  // A diagnostics read → the verifying phase. It IS a check, so it reads the same
  // as "Verifying · npm run typecheck" would, naming the checker rather than a
  // command line the user never typed.
  if (checks.length > 0 && commands.length === 0 && writes.length === 0 && reads.length === 0) {
    const scope = checks[0].scope ?? 'all'
    return {
      stage: 'verifying',
      message: scope === 'all' ? 'Checking for problems' : `Checking for problems · ${scope}`
    }
  }

  // A web_fetch batch (no files, no commands) → the scanning phase, naming the host.
  if (fetches.length > 0 && commands.length === 0 && writes.length === 0 && reads.length === 0) {
    let host = ''
    try {
      host = new URL(fetches[0].url).hostname
    } catch {
      host = ''
    }
    return {
      stage: 'scanning',
      message:
        fetches.length === 1 ? `Fetching ${host || 'the web'}` : `Fetching ${fetches.length} pages`
    }
  }

  // A web_search batch (no files, no commands, no fetches) → the scanning phase.
  if (
    searches.length > 0 &&
    commands.length === 0 &&
    writes.length === 0 &&
    reads.length === 0 &&
    fetches.length === 0
  ) {
    return {
      stage: 'scanning',
      message:
        searches.length === 1 ? 'Searching the web' : `Running ${searches.length} web searches`
    }
  }

  // Pure inspection → the reading phase. Live look-only batches are narrated file by
  // file in the execute loop (one `Reading <filename>` each, replacing the last); this
  // branch stays only as a defensive fallback and never leaks a grep query, glob,
  // purpose, or count — just the file being opened, or a neutral note for a search/list.
  if (reads.length > 0 && commands.length === 0 && writes.length === 0) {
    const files = reads.filter((r) => r.tool === 'read_file').map((r) => baseName(r.path))
    if (files.length > 0) return { stage: 'reading', message: `Reading ${files[0]}` }
    return { stage: 'scanning', message: 'Reading the project…' }
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
      const applied = result.edited ? 'applied with the user’s own edits' : 'applied'
      const head = `${verb} ${path} → ${result.ok ? applied : (result.error ?? 'failed')}`
      // A successful write that failed its static check reports both: the file IS
      // on disk, and here is what's wrong with it. Silence means nothing was
      // detected — never a claim that the file is correct.
      const check = describeIssues(result.issues ?? [])
      if (check) broken = true
      // An edited write means the file no longer matches what the model composed, so
      // saying so is not politeness — it is the difference between the next step
      // building on the file and building on a memory of it.
      const edited = result.edited
        ? 'The user changed your content before it was written; the file holds THEIR version. Read it again before editing it further.'
        : ''
      return [head, check, edited].filter(Boolean).join('\n')
    }
    if (result.kind === 'read') {
      const label =
        tool.tool === 'search_files'
          ? `search_files "${tool.query}" in ${tool.path}`
          : tool.tool === 'find_files'
            ? `find_files "${tool.glob}" in ${tool.path}`
            : tool.tool === 'read_file' || tool.tool === 'list_files'
              ? `${tool.tool} ${tool.path}`
              : 'read'
      if (!result.ok) return `${label} → error: ${result.error ?? 'failed'}`
      // A clipped read already carries its own tail note naming the exact `offset` to
      // continue from (see `readFileSlice`). The old note here said "ask for a
      // narrower range if you need more", which invited precisely the keyhole reads
      // this change exists to end — a narrower range is never what was needed.
      const truncNote = result.truncated ? ' — see the note at the end for the rest' : ''
      return `${label} → ${result.summary}${truncNote}\n${result.output}`
    }
    if (result.kind === 'mcp_call') {
      const label = tool.tool === 'mcp_call' ? `${tool.server}/${tool.name}` : ''
      if (!result.ok) return `mcp_call ${label} → error: ${result.error ?? 'failed'}`
      const truncNote = result.truncated ? ' (output truncated)' : ''
      return `mcp_call ${label} → ok${truncNote}\noutput:\n${result.output.trim()}`
    }
    if (result.kind === 'web_fetch') {
      const label = tool.tool === 'web_fetch' ? tool.url : ''
      if (!result.ok) return `web_fetch ${label} → error: ${result.error ?? 'failed'}`
      const truncNote = result.truncated ? ' (content truncated)' : ''
      return `web_fetch ${label} → ok${truncNote}\n${result.output.trim()}`
    }
    if (result.kind === 'web_search') {
      const label = tool.tool === 'web_search' ? tool.query : ''
      if (!result.ok) return `web_search "${label}" → error: ${result.error ?? 'failed'}`
      const truncNote = result.truncated ? ' (results truncated)' : ''
      return `web_search "${label}" → ok${truncNote}\n${result.output.trim()}`
    }
    if (result.kind === 'install_plugin') {
      const label = tool.tool === 'install_plugin' ? tool.source : ''
      if (!result.ok) return `install_plugin ${label} → error: ${result.error ?? 'failed'}`
      return `install_plugin ${label} → ok\n${result.output.trim()}`
    }
    if (result.kind === 'preview_inspect') {
      const label = `preview_inspect ${result.action}`
      if (!result.ok) return `${label} → error: ${result.error ?? 'failed'}`
      const truncNote = result.truncated ? ' (output truncated)' : ''
      // A screenshot's bytes are attached to this turn as a real image (step 4h);
      // the text just tells the model to look at it.
      const shot = result.media ? '\n(the screenshot is attached to this message — look at it)' : ''
      return `${label} → ${result.summary}${truncNote}\n${result.output.trim()}${shot}`
    }
    if (result.kind === 'browse') {
      const label = `browse ${result.action}`
      if (!result.ok) return `${label} → error: ${result.error ?? 'failed'}`
      const truncNote = result.truncated ? ' (page truncated — scroll for more)' : ''
      const where = result.url ? `\nurl: ${result.url}` : ''
      const shot = result.media ? '\n(the page screenshot is attached — look at it)' : ''
      return `${label} → ${result.summary}${truncNote}${where}\n${result.output.trim()}${shot}`
    }
    if (result.kind === 'diagnostics') {
      // `ok: false` here means NO checker ran — the one outcome that must never be
      // reported as a clean project, so it is stated as an error, not as a result.
      if (!result.ok) return `diagnostics → error: ${result.error ?? 'nothing was checked'}`
      const truncNote = result.truncated ? ' (list truncated)' : ''
      const clean =
        result.errors === 0 && result.warnings === 0
          ? '\nNothing to fix from these checkers. Do not re-run them to confirm.'
          : ''
      return `diagnostics → ${result.summary}${truncNote}\n${result.output.trim()}${clean}`
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
 * is unknown (e.g. a late click after cancel). `detail` carries edit-then-approve
 * content and the user's reason for a refusal; both are optional and the engine
 * validates them itself (see {@link executeTool}).
 */
export function resolveToolDecision(
  runId: string,
  toolId: string,
  decision: ToolDecision,
  detail?: ToolDecisionDetail
): void {
  activeRuns.get(runId)?.pending.get(toolId)?.resolve(decision, detail)
}

/**
 * Stops ONE subagent, leaving the run and its sibling lanes running. Aborts that
 * agent's own controller and unblocks only the approvals IT was parked on, so its
 * loop unwinds promptly; `runSubagent` then reports the cancellation to the lead,
 * which decides what to do without that slice. No-op for an unknown run/agent, or
 * for one that has already finished (its entry is gone by then).
 */
export function cancelAgent(runId: string, agentId: string): void {
  const handle = activeRuns.get(runId)
  const ctl = handle?.agents.get(agentId)
  if (!handle || !ctl) return
  ctl.abort()
  for (const [toolId, p] of handle.pending) {
    if (p.agentId === agentId) {
      handle.pending.delete(toolId)
      p.resolve('reject')
    }
  }
}

/**
 * Withdraws a run-scoped standing approval ("Always"), so the next op of that class
 * asks again. Keys come from `standingApprovalKey`; an unknown key or run is a no-op,
 * which is exactly right for a late click after the run ended.
 */
export function revokeStandingApproval(runId: string, key: string): void {
  activeRuns.get(runId)?.standingApprovals.delete(key)
}

/**
 * Resolves a pending clarifying question (the `ask_user` tool) with the user's
 * answer. No-op if the run or question is unknown (e.g. a late submit after the
 * run was cancelled). Mirrors {@link resolveToolDecision}.
 */
export function resolveQuestion(runId: string, questionId: string, answer: string): void {
  activeRuns.get(runId)?.pendingQuestions.get(questionId)?.resolve(answer)
}

/** Cancels an in-flight run by id (no-op if unknown). */
export function cancelWorkflow(runId: string): void {
  const handle = activeRuns.get(runId)
  if (!handle) return
  handle.controller.abort()
  // Unblock any awaiting tool decisions so the run can unwind promptly.
  for (const p of handle.pending.values()) p.resolve('reject')
  handle.pending.clear()
  // Unblock any awaiting clarifying question the same way — the loop checks
  // `signal.aborted` right after the await, so the empty answer is never used.
  for (const q of handle.pendingQuestions.values()) q.resolve('')
  handle.pendingQuestions.clear()
  activeRuns.delete(runId)
}

/** Aborts every in-flight run. Called on app shutdown. */
export function cancelAllWorkflows(): void {
  for (const handle of activeRuns.values()) {
    handle.controller.abort()
    for (const p of handle.pending.values()) p.resolve('reject')
    handle.pending.clear()
    for (const q of handle.pendingQuestions.values()) q.resolve('')
    handle.pendingQuestions.clear()
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
  mcpTools: McpToolInfo[],
  skills: SkillInfo[]
): ChatMessage[] {
  let system =
    SYSTEM_PROMPT +
    shellDirective() +
    mcpDirective(mcpTools) +
    skillsDirective(skills) +
    spawnDirective() +
    todosDirective() +
    askDirective() +
    followupDirective() +
    effortDirective(effort) +
    intentDirective(intentKind)
  const lastUser = [...history].reverse().find((m) => m.role === 'user')?.content ?? ''
  const userProfile = buildUserProfilePreamble(lastUser)
  if (userProfile) system += `\n\n${userProfile}`
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

/**
 * Builds the GLOBAL user-profile preamble — what Sylor has learned about the
 * person across every project (name, working style, the kind of sites they
 * build, their look/typography taste). Returns '' when nothing's been learned,
 * so a fresh install adds no section. Injected into every run's system prompt
 * (Code and Cowork) so preferences carry over without the user repeating them.
 *
 * `query` (the current turn's text) narrows a large profile to the most relevant
 * facts via {@link getUserProfileForPrompt}; a small profile is injected whole.
 * Reads only the local profile store; never throws.
 */
function buildUserProfilePreamble(query = ''): string {
  try {
    const profile = getUserProfileForPrompt(query)
    if (!profile) return ''
    return (
      '## About this user (remembered across all their projects)\n' +
      profile +
      '\n\nMatch these preferences by default — their name, how they like to work, the ' +
      'kind of sites they build, and their style/typography taste — instead of asking ' +
      'again. If a new instruction clearly supersedes something here, follow the new one.'
    )
  } catch (err) {
    console.error('[sylor] failed to load user profile:', err)
    return ''
  }
}

/**
 * Persists Sylor's `remember_user` notes to the global user profile and confirms
 * each newly-saved one as a `delta`. Unlike {@link recordMemory} this is NOT
 * project-scoped — it follows the user everywhere — so it needs no projectId and
 * saves even in an unfiled chat. DB/file-only and best-effort: a duplicate is a
 * silent no-op, and a persistence failure is logged, never thrown.
 */
function recordUserProfile(
  notes: Array<Extract<ParsedTool, { tool: 'remember_user' }>>,
  runId: string,
  emit: EventSink
): void {
  for (const note of notes) {
    try {
      if (appendUserProfile(note.note)) {
        emit({ type: 'delta', runId, text: `\n\n🧠 Remembered about you: ${note.note.trim()}` })
      }
    } catch (err) {
      console.error('[sylor] failed to append user profile:', err)
    }
  }
}

/**
 * How many follow-ups one model message may flag. A turn that "notices" nine
 * unrelated problems has stopped doing the work it was asked to do, and nine chips
 * are nine things the user now has to triage — so the extras are dropped.
 */
const MAX_FOLLOWUPS_PER_MESSAGE = 3

/**
 * Records `flag_followup` notices — out-of-scope work the agent spotted and left
 * undone — to the project's `FOLLOWUPS.md`, and surfaces each as a `followup` event
 * the UI turns into a one-click chip.
 *
 * Three deliberate choices:
 *
 *  - **A duplicate is silent.** {@link appendFollowup} dedupes on the title, and a
 *    finding already on the list is not re-chipped: agents re-notice the same loose
 *    end on every pass, and a chip row that repeats itself is one the user ignores.
 *  - **An unwritable file still flags.** A read-only checkout (or a chat with no
 *    folder) loses the durable record, not the finding — the chip still appears, and
 *    `recordedIn` is left absent so nothing claims a file that isn't there.
 *  - **Best-effort, never fatal.** Like {@link recordMemory}, a failure is logged and
 *    the turn carries on: flagging is bookkeeping, not a gate.
 */
function recordFollowups(
  notices: Array<Extract<ParsedTool, { tool: 'flag_followup' }>>,
  runId: string,
  emit: EventSink
): void {
  for (const notice of notices.slice(0, MAX_FOLLOWUPS_PER_MESSAGE)) {
    try {
      const outcome = appendFollowup(notice)
      if (outcome === 'duplicate') continue
      const recordedIn = outcome === 'recorded' ? memoryDocPath('followups') : undefined
      emit({
        type: 'followup',
        runId,
        followup: {
          id: nextFollowupId(),
          title: notice.title,
          ...(notice.note ? { note: notice.note } : {}),
          ...(notice.files ? { files: notice.files } : {}),
          ...(recordedIn ? { recordedIn } : {})
        }
      })
      emit({
        type: 'delta',
        runId,
        text: recordedIn
          ? `\n\n📌 Follow-up noted in ${recordedIn}: ${notice.title}`
          : `\n\n📌 Follow-up (this session only — nothing could be written): ${notice.title}`
      })
    } catch (err) {
      console.error('[sylor] failed to record follow-up:', err)
    }
  }
}
