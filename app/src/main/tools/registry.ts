import type { ChatImage, ChatMode, CommandRun, CredentialInput, CredentialMeta, EditorEvent, FileSnapshot, GeneratedMedia, NativeToolSchema, PreviewTarget, ProviderSettings, TodoItem, ToolSideEffect } from '../../shared/types'
import type { FfmpegProgress } from './ffmpeg-core'
import { toErrorMessage } from '../providers/http'
import type { ToolCall } from './toolParser'
import { webFetchTool, webSearchTool, wikiSearchTool } from './web'
import { runCodeTool } from './runCode'
import { fsTools } from './fs'
import { editNotebookTool } from './notebook'
import { previewTool } from './preview'
import { updatePlanTool } from './plan'
import { presentPlanTool } from './present-plan'
import { searchTools } from './search'
import { runCommandTool } from './command'
import { runDevServerTool } from './devServer'
import { detectRuntimesTool } from './runtimes'
import { verifyFileTool } from './verify'
import { scaffoldDeployTool } from './scaffold'
import { createDocumentTool } from './document'
import { createFileTool } from './create-file'
import { documentReadTools } from './document-read'
import { renderDocumentTool } from './document-raster'
import { browserTools } from './browser'
import type { BrowserSession } from '../cowork-browser-cdp'
import { gitTools } from './git'
import { gitPublishTool } from './publish'
import { spawnAgentTool, spawnAgentsTool } from './agent'
import { askUserTool } from './ask'
import { installConnectorTool, installSkillTool } from './install'
import { rememberTool } from './remember'
import { thinkTool } from './think'
import { mediaEditTools } from './media-edit'
import { visualEditTools } from './visual-edit'
import { credentialTools } from './credentials'

/**
 * The tool registry: the catalogue of tools the chat can use, the dispatcher that
 * runs one ({@link runTool}), and the builder for the system prompt that teaches
 * the model the call protocol ({@link toolsSystemPrompt}).
 *
 * Availability is layered around a {@link ToolGate}. `settings.tools.enabled` is
 * the master switch — off means no tool is advertised or runnable at all. On top
 * of that each tool's own {@link ToolDef.available} gate applies against the gate:
 * that is how `run_code` stays hidden until the `codeExecution` opt-in is on, and
 * how the filesystem tools stay dormant outside Cowork mode (see ./fs.ts).
 */

/**
 * Everything a tool's availability decision depends on: the live settings, the
 * mode this turn runs in, and (for Cowork) the working folder. Passed to
 * {@link ToolDef.available}; extended by {@link ToolContext} at run time.
 */
export interface ToolGate {
  /** The live settings — read for gating (e.g. run_code) and endpoints. */
  settings: ProviderSettings
  /** How this turn runs — the filesystem tools require `cowork`. */
  mode: ChatMode
  /** The Cowork working folder, or null when none is chosen / not in Cowork. */
  workspaceDir: string | null
  /**
   * Full-computer access (the CLI's `--full-access` / the REPL's `full`
   * permission mode): when true the filesystem tools resolve paths ANYWHERE on
   * the machine instead of confining them to workspaceDir — relative paths
   * still anchor to the workspace so bare filenames keep working. The desktop
   * app never sets it; its containment stays on.
   */
  fullAccess?: boolean
}

/** Ambient state a tool needs while running: the gate plus the cancel signal. */
export interface ToolContext extends ToolGate {
  /** Cancels the tool when the user hits Stop (chained to the stream's controller). */
  signal: AbortSignal
  /**
   * Show something in Myto's preview pane (Cowork). The `preview` tool calls this
   * to open/point the side pane; the stream loop turns it into a
   * {@link CompletionChunk.preview}. Optional — absent outside the streaming loop
   * (e.g. in unit tests), in which case the preview tool degrades to a plain note.
   */
  onPreview?: (target: PreviewTarget) => void
  /**
   * Publish the agent's working plan (Cowork). The `update_plan` tool calls this to
   * push the current checklist; the stream loop turns it into a
   * {@link CompletionChunk.todos}. Optional — absent outside the streaming loop.
   */
  onPlan?: (todos: TodoItem[]) => void
  /**
   * Report a shell command the `run_command` tool just ran, plus its output. The
   * stream loop turns it into a {@link CompletionChunk.command} so the renderer can
   * show it in the Terminal pane. Optional — absent outside the streaming loop, where
   * the tool still returns its formatted result to the model as usual.
   */
  onCommand?: (run: CommandRun) => void
  /**
   * Run a focused read-only sub-task in a nested agent and resolve to its digest.
   * The `spawn_agent` tool calls this; the nested loop lives in provider-ipc.ts
   * (it needs the provider + model). Optional — absent outside the streaming loop,
   * where the tool degrades to a plain "not available" note.
   */
  delegate?: (task: string) => Promise<string>
  /**
   * Ask the user one or more clarifying questions and resolve to their answers (the
   * `ask_user` tool). Blocks the loop until the user answers. Optional — absent outside
   * the streaming loop, where the tool degrades to a note telling the model to proceed
   * with its best judgement.
   */
  askUser?: (questions: import('../../shared/types').AskQuestion[]) => Promise<string[]>
  /**
   * Record a before/after capture of a file a mutation tool touched (#1 checkpoints).
   * The write/edit/delete tools call this so the stream loop can persist a
   * `file_snapshots` row for rewind + the diff viewer. Optional — absent outside the
   * streaming loop, where mutation tools simply skip the capture.
   */
  onFileSnapshot?: (snapshot: FileSnapshot) => void
  /**
   * Lifecycle hook run BEFORE a tool executes (#9). Returning `{ block }` with a
   * non-empty string short-circuits the tool: the string is fed back to the model
   * as the tool result (like a permission denial) and the tool never runs. Resolving
   * with nothing lets the call proceed. Optional — absent outside the streaming loop
   * and when the user configured no pre-hook.
   */
  preToolUse?: (call: ToolCall) => Promise<{ block?: string } | void>
  /**
   * Lifecycle hook run AFTER a tool completes (#9), given the call and its result
   * string. Best-effort/observational — its own output is surfaced as a status line,
   * never fed back as the tool result. Optional — absent outside the streaming loop
   * and when the user configured no post-hook.
   */
  postToolUse?: (call: ToolCall, result: string) => Promise<void>
  /**
   * Obtain this run's browser session (Track 2), lazily created and memoized so the
   * first `browser_*` call spins up the chosen target (in-app WebContentsView or the
   * user's system Chrome) and later calls reuse it; provider-ipc disposes it when the
   * run ends. Optional — absent outside the streaming loop (e.g. unit tests), where the
   * browser tools degrade to a "not available" note.
   */
  getBrowser?: () => Promise<BrowserSession>
  /**
   * Render a finished HTML page to a PDF byte buffer (the `create_document` tool's PDF
   * path). Backed by Chromium's own `webContents.printToPDF` in an offscreen window
   * (cowork-docgen-runtime.ts) — the one PDF engine the app already ships, so no external
   * library or headless-chrome download. Optional — absent outside the streaming loop and
   * in unit tests, where `create_document` falls back to writing the HTML and says so.
   */
  renderDocument?: (html: string, kind: import('../cowork-docgen').DocKind) => Promise<Uint8Array>
  /**
   * Feed image(s) a tool produced back to the MODEL as vision input for the next turn
   * (A2b — a scanned PDF page rasterized to a picture the model can read, since it has no
   * text layer to extract). The stream loop attaches them to the tool-result turn it sends
   * back and also shows them to the user as {@link CompletionChunk.media}. `caption` is a
   * short human note (e.g. "document.pdf pages 3–4"). Optional — absent outside the streaming
   * loop and in unit tests, where a rasterizing tool degrades to a plain text note.
   */
  emitToolImages?: (images: ChatImage[], caption?: string) => void
  /**
   * Rasterize a PDF's pages to PNG data-URLs on a real Chromium canvas (A2b — the
   * Electron-backed half of `render_document`, in document-raster-runtime.ts). Returns the
   * doc's true page count, the pages actually rendered, and their data-URLs. `pages` is the
   * tool's raw page field (a number, `"3-5"`, or absent → the first window) and `scale` its
   * raw scale field, both interpreted by the pure raster-core. Optional — absent outside the
   * streaming loop and in unit tests, where `render_document` degrades to a "needs the app
   * runtime" note.
   */
  rasterizeDocument?: (
    bytes: Uint8Array,
    pages: unknown,
    scale: unknown,
    signal?: AbortSignal
  ) => Promise<{ total: number; pages: number[]; dataUrls: string[] }>
  /**
   * Push a human status line to the rolling activity indicator while a long media render
   * runs (the FFmpeg tools call this with "Rendering 42% (3.1x)"). The stream loop turns it
   * into a {@link CompletionChunk.status}. Optional — absent outside the streaming loop, where
   * the media tools simply run without live progress.
   */
  onStatus?: (status: string) => void
  /**
   * Spawn the bundled ffmpeg with an argument ARRAY (never a shell) — the Electron half in
   * ../ffmpeg-runtime.ts. `onProgress` streams `-progress` ticks (wired to {@link onStatus} by
   * the tool), `cwd` sandboxes the escape-hatch `run_ffmpeg` to the working folder, and `signal`
   * chains to the user's Stop. Optional — absent in unit tests, where the media tools degrade to
   * a "needs the app runtime" note.
   */
  runFfmpeg?: (
    args: string[],
    opts?: {
      onProgress?: (p: FfmpegProgress) => void
      totalDurationSec?: number
      signal?: AbortSignal
      captureStdout?: boolean
      cwd?: string
    }
  ) => Promise<{ exitCode: number | null; stderr: string; stdout: string }>
  /** Probe a media file with the bundled ffprobe → raw ffprobe JSON stdout (the core parses it). */
  probeMedia?: (absPath: string, signal?: AbortSignal) => Promise<string>
  /** Transcribe an audio/video file → raw transcript JSON (local whisper.cpp or an API). */
  transcribeAudio?: (absPath: string, signal?: AbortSignal) => Promise<string>
  /**
   * Surface finished output media (an edited video or image) to the user inline. The media tools
   * call this with a small base64-encoded result; the stream loop turns it into a
   * {@link CompletionChunk.media} chunk. Optional — absent outside the streaming loop, where the
   * tool still returns the output path in its result text.
   */
  emitMedia?: (media: GeneratedMedia[]) => void
  /**
   * Drive the live "watch Myto edit" Editor pane (Build mode). The `edit_photo`/`edit_video`
   * tools call this through an edit: open (source still) → script (the choreography the
   * renderer animates) → progress (bake render bar) → baked (the real result). The stream
   * loop turns each into a {@link CompletionChunk.editor} chunk. Optional — absent outside the
   * streaming loop, where the tool still bakes the file and returns its path in the result.
   */
  onEditorEvent?: (event: EditorEvent) => void
  /**
   * Resolve the env a shell command should run with: the values of every stored credential whose
   * scopes match a program in the command (credential-vault.ts). `run_command`, `git`, and
   * `git_publish` spread it over `process.env` so a matching command (e.g. `git push`) carries the
   * user's saved token with no secret ever in argv. Returns undefined when nothing matches. Optional
   * — absent outside the streaming loop and in the read-only sub-agent, where no injection happens.
   */
  resolveCredentialEnv?: (command: string) => NodeJS.ProcessEnv | undefined
  /**
   * Scrub every secret value injected so far this run out of model-facing text (replacing it, and
   * its url-encoded form, with a mask). The stream loop builds this from the accumulating set of
   * injected secrets; {@link runTool} applies it to EVERY tool's result centrally, and command.ts /
   * git.ts / publish.ts additionally apply it to their separate terminal-mirror channel. Optional —
   * absent outside the streaming loop, where there is nothing to redact.
   */
  redactSecrets?: (text: string) => string
  /**
   * Store (or replace) a credential and resolve the updated metadata list — the `save_credential`
   * tool's backend (credential-vault.ts). Throws when secure storage is unavailable or the input is
   * invalid. Optional — absent outside the streaming loop and in unit tests, where the tool degrades
   * to a note.
   */
  saveCredential?: (input: CredentialInput) => CredentialMeta[]
  /** List saved credentials as metadata (names + scopes, never values) — the `list_credentials` backend. */
  listCredentialMeta?: () => CredentialMeta[]
  /** Delete one site's credential and resolve the updated metadata list — the `delete_credential` backend. */
  deleteCredential?: (site: string) => CredentialMeta[]
}

/** One tool the model can call through the text protocol. */
export interface ToolDef {
  /** The `"tool"` value the model writes; must be unique. */
  name: string
  /** One sentence shown to the model in the system prompt. */
  description: string
  /** A compact example `input` object, shown in the prompt. */
  usage: string
  /**
   * What this tool changes, if anything: 'write' (touches the filesystem), 'exec'
   * (runs code), or undefined for a read-only tool. Drives the Cowork permission
   * prompt — read-only tools never ask (see main/tools/approvals.ts).
   */
  sideEffect?: ToolSideEffect
  /**
   * JSON-Schema for this tool's `input`, advertised to a native function-calling
   * backend (#15) via {@link toolSchemas}. Optional: a tool that declares none
   * falls back to a permissive object schema, and the field is consulted ONLY when
   * native tools are on — the text protocol ignores it and teaches shape via
   * {@link usage}. Keep it in sync with what {@link run} accepts.
   */
  schema?: Record<string, unknown>
  /** Whether this tool may be advertised/run under the given gate. */
  available(gate: ToolGate): boolean
  /** Execute the call; always resolves to a string (errors become messages). */
  run(input: unknown, ctx: ToolContext): Promise<string>
}

const ALL_TOOLS: readonly ToolDef[] = [
  webFetchTool,
  webSearchTool,
  wikiSearchTool,
  runCodeTool,
  runCommandTool,
  runDevServerTool,
  detectRuntimesTool,
  ...fsTools,
  verifyFileTool,
  scaffoldDeployTool,
  createDocumentTool,
  createFileTool,
  ...documentReadTools,
  renderDocumentTool,
  ...browserTools,
  editNotebookTool,
  ...searchTools,
  ...gitTools,
  gitPublishTool,
  previewTool,
  updatePlanTool,
  presentPlanTool,
  thinkTool,
  spawnAgentTool,
  spawnAgentsTool,
  askUserTool,
  installConnectorTool,
  installSkillTool,
  rememberTool,
  ...mediaEditTools,
  ...visualEditTools,
  ...credentialTools
]

/** Lookup by name. Mutable only so tests can inject a fake tool; not written at runtime. */
export const TOOLS: Record<string, ToolDef> = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]))

/**
 * Runtime-registered tools — the ones that come and go while the app runs: tools
 * exposed by a connected MCP server, an enabled skill, or an installed plugin. Kept
 * in a SEPARATE map from the built-in {@link TOOLS} catalogue on purpose: the
 * built-in surface is a fixed, snapshot-tested set, and a connector appearing must
 * never change it. These are merged into {@link availableTools} and {@link lookupTool}
 * at call time. Names are expected to be namespaced (e.g. `mcp__github__create_issue`)
 * so a connector can't shadow a built-in or another connector.
 */
const extensionTools = new Map<string, ToolDef>()

/** Register (or replace) a runtime tool. Called by the MCP manager as servers connect. */
export function registerExtensionTool(tool: ToolDef): void {
  extensionTools.set(tool.name, tool)
}

/** Remove runtime tools by name (a server disconnecting, a skill/plugin being disabled). */
export function unregisterExtensionTools(names: Iterable<string>): void {
  for (const name of names) extensionTools.delete(name)
}

/** Drop every runtime tool. Called on shutdown and when tests need a clean slate. */
export function clearExtensionTools(): void {
  extensionTools.clear()
}

/** The names of every currently-registered runtime tool. */
export function extensionToolNames(): string[] {
  return [...extensionTools.keys()]
}

/**
 * Look up a tool by name across the built-in catalogue and the runtime extensions.
 * The single resolution point so dispatch, side-effect gating, and the sub-agent
 * loop all see connectors, not just the built-ins.
 */
export function lookupTool(name: string): ToolDef | undefined {
  return TOOLS[name] ?? extensionTools.get(name)
}

/** The tools usable under `gate`: none when tool use is off, else each tool's own gate. */
export function availableTools(gate: ToolGate): ToolDef[] {
  if (!gate.settings.tools.enabled) return []
  const built = ALL_TOOLS.filter((t) => t.available(gate))
  if (extensionTools.size === 0) return built
  const ext = [...extensionTools.values()].filter((t) => t.available(gate))
  return [...built, ...ext]
}

/**
 * Dispatch a parsed {@link ToolCall}. Never throws: a parse error, unknown name,
 * gated-off tool, or a failure inside the tool all resolve to a short message the
 * model reads back and can recover from — that is what keeps the agentic loop from
 * wedging on a bad call.
 */
export async function runTool(call: ToolCall, ctx: ToolContext): Promise<string> {
  if (!ctx.settings.tools.enabled) return 'Tool use is turned off (Settings › Tools).'
  if (call.error || !call.name) {
    return `That tool call did not parse (${call.error ?? 'unknown error'}). Re-issue it as one compact JSON object {"tool": "name", "input": { ... }} inside a myto:tool block.`
  }
  const tool = lookupTool(call.name)
  if (!tool) {
    return `Unknown tool "${call.name}". Available tools: ${availableTools(ctx).map((t) => t.name).join(', ') || '(none)'}.`
  }
  if (!tool.available(ctx)) {
    return `The "${call.name}" tool is not available right now — check Settings › Tools${
      ctx.mode !== 'cowork' ? ', or switch to Cowork and pick a working folder for the file tools' : ''
    }.`
  }
  try {
    // PreToolUse hook (#9): a non-empty `block` string vetoes the call — it becomes
    // the tool result the model reads back, and the tool never runs. Hook failures
    // must never wedge the loop, so a throwing hook is swallowed and the call proceeds.
    if (ctx.preToolUse) {
      try {
        const verdict = await ctx.preToolUse(call)
        if (verdict && typeof verdict.block === 'string' && verdict.block.trim()) {
          return verdict.block
        }
      } catch {
        // A broken pre-hook shouldn't block work; fall through and run the tool.
      }
    }
    const result = await tool.run(call.input, ctx)
    // Central redaction (defence-in-depth): scrub any injected secret value out of EVERY
    // tool's model-facing output at the one dispatch chokepoint, so no individual tool can
    // forget to. The per-run redactor masks only values actually injected this run.
    const safe = ctx.redactSecrets ? ctx.redactSecrets(result) : result
    // PostToolUse hook (#9): observational only — its output is surfaced as a status
    // line by the loop, never merged into the result. Errors are ignored.
    if (ctx.postToolUse) {
      try {
        await ctx.postToolUse(call, safe)
      } catch {
        // ignore — a post-hook is best-effort.
      }
    }
    return safe
  } catch (err) {
    return `The "${call.name}" tool failed: ${toErrorMessage(err)}`
  }
}

/**
 * Build the system prompt that teaches the call protocol and lists the currently
 * available tools. Returns null when no tools are available, so the caller can
 * omit the message entirely and leave plain-chat behaviour untouched.
 */
export function toolsSystemPrompt(gate: ToolGate): string | null {
  const tools = availableTools(gate)
  if (!tools.length) return null
  return [
    'You can call tools to get real information before you answer. To call a tool, write ONE fenced block and then STOP — do not write the result yourself:',
    '',
    '```myto:tool',
    '{"tool": "<name>", "input": { ... }}',
    '```',
    '',
    'Rules:',
    '- Put the call on a single line of compact JSON between the fences.',
    '- Use EXACTLY this fenced `myto:tool` format — it is the only syntax that runs. Do NOT emit native tool markup such as `<invoke name="...">` / `<parameter name="...">`; that is not a tool call here, it will be shown to the user as raw text and nothing will happen.',
    '- After the block, output nothing and wait. The result comes back to you as a ```myto:tool_result block.',
    '- Read the result, then either call another tool or write your final answer to the user.',
    '- Call a tool only when it genuinely helps: a fact you are unsure of, something current or time-sensitive, a page or source the user named, or code to run. Otherwise just answer directly.',
    '- To RUN a project (start its dev server, build, install deps, run tests) use `run_command` or `run_dev_server`, not `run_code`. `run_code` is for a short throwaway snippet, not for running the user\'s project.',
    '- Never invent a tool result or claim you used a tool you did not.',
    '',
    'Available tools:',
    ...tools.map((t) => `- ${t.name} — ${t.description} Input example: ${t.usage}`)
  ].join('\n')
}

/**
 * Build the native-function-calling tool schema array (#15) for the tools usable
 * under `gate` — the native-path counterpart of {@link toolsSystemPrompt}. Each
 * tool contributes its {@link ToolDef.schema} (or a permissive object schema when it
 * declares none); the `usage` example is folded into the description so a model on
 * the native path still gets the shape hint the text prompt gives. Empty when no
 * tools are available, so the caller advertises none and the backend stays in plain
 * chat.
 */
export function toolSchemas(gate: ToolGate): NativeToolSchema[] {
  return availableTools(gate).map((t) => ({
    name: t.name,
    description: `${t.description} Input example: ${t.usage}`,
    parameters: t.schema ?? { type: 'object', additionalProperties: true }
  }))
}
