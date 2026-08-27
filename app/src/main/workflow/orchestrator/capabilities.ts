/**
 * Capabilities — what a role is allowed to touch, and the scoping functions the
 * orchestrator uses to give each specialist only the tools/MCP/skills relevant
 * to its job.
 *
 * A {@link Capability} is a coarse permission (filesystem, terminal, git, …).
 * Every {@link import('./roles').AgentRoleDef} declares a set of them; from that
 * set we derive three things:
 *  - which side-effecting tool kinds the role may execute ({@link allowsTool}) —
 *    enforced in the engine's `executeTool`, so a reviewer that tries to
 *    `write_file` gets a failed tool-result instead of silently mutating files;
 *  - which MCP tools the role even *sees* in its prompt ({@link scopeMcpTools}) —
 *    a role never sees an MCP server outside its allowed categories;
 *  - which skills are relevant enough to surface ({@link scopeSkills}).
 *
 * These are relevance + safety filters, not a sandbox: the real sandbox is the
 * permission gate + workspace-root confinement already in the engine. Scoping
 * keeps each agent's context lean (fewer distractor tools → better tool use) and
 * stops, e.g., a docs writer from shelling out.
 *
 * Kept free of Electron/engine imports (pure functions over plain data) so it is
 * trivially unit-testable.
 */
import type { McpCategory, McpToolInfo, SkillCategory, SkillInfo, ToolKind } from '../../../shared/types'

/**
 * A coarse permission a role can hold. Union kept small and orthogonal:
 *  - `filesystem` → may create/edit project files (`write_file`).
 *  - `terminal`   → may run shell commands (`run_command`).
 *  - `code-exec`  → runs code/build steps (also unlocks `run_command`).
 *  - `testing`    → runs tests/typecheck (also unlocks `run_command`).
 *  - `git`        → git operations (via the git MCP category).
 *  - `web`        → web fetch/search (web MCP category).
 *  - `browser`    → drives a browser (browser MCP category).
 *  - `db`         → database/data access (database + data MCP categories).
 *  - `image`      → image generation/inspection.
 *  - `mcp`        → broad MCP access (every category) — for generalist roles.
 *  - `skills`     → may invoke disk skills.
 */
export type Capability =
  | 'filesystem'
  | 'terminal'
  | 'browser'
  | 'git'
  | 'web'
  | 'code-exec'
  | 'testing'
  | 'image'
  | 'db'
  | 'mcp'
  | 'skills'

/** Every MCP category, used when a role holds the broad `mcp` capability. */
const ALL_MCP_CATEGORIES: McpCategory[] = [
  'core',
  'files',
  'git',
  'development',
  'browser',
  'web',
  'database',
  'data',
  'productivity',
  'external'
]

/**
 * The MCP categories each capability unlocks. A capability not listed here
 * grants no MCP visibility on its own (e.g. `terminal`, `code-exec`, `testing`
 * are about `run_command`, not MCP servers).
 */
const CAPABILITY_MCP_CATEGORIES: Record<Capability, McpCategory[]> = {
  filesystem: ['files'],
  terminal: [],
  browser: ['browser'],
  git: ['git'],
  web: ['web'],
  'code-exec': ['development'],
  testing: [],
  image: [],
  db: ['database', 'data'],
  mcp: ALL_MCP_CATEGORIES,
  skills: []
}

/**
 * Resolves the set of MCP categories a role with these capabilities may see.
 * `core` servers (sequential-thinking, memory — pure reasoning aids, no side
 * effects) are added whenever the role sees *any* MCP category, so every
 * MCP-capable role gets the safe helpers without having to list them.
 */
export function mcpCategoriesFor(capabilities: readonly Capability[]): Set<McpCategory> {
  const cats = new Set<McpCategory>()
  for (const cap of capabilities) {
    for (const c of CAPABILITY_MCP_CATEGORIES[cap] ?? []) cats.add(c)
  }
  if (cats.size > 0) cats.add('core')
  return cats
}

/**
 * Builds a `server → category` lookup from the MCP manager's server list, so
 * {@link scopeMcpTools} can classify each flat tool by its owning server.
 */
export function serverCategoryMap(
  servers: readonly { name: string; category: McpCategory }[]
): Map<string, McpCategory> {
  const map = new Map<string, McpCategory>()
  for (const s of servers) map.set(s.name, s.category)
  return map
}

/**
 * Filters the flat MCP tool list down to those a role may see, by mapping each
 * tool's server to its category and keeping only categories the role's
 * capabilities unlock. An unknown server (no category) is treated as `external`
 * — visible only to roles with the broad `mcp` capability. Order is preserved.
 */
export function scopeMcpTools(
  all: readonly McpToolInfo[],
  capabilities: readonly Capability[],
  serverCategory: Map<string, McpCategory>
): McpToolInfo[] {
  const allowed = mcpCategoriesFor(capabilities)
  if (allowed.size === 0) return []
  return all.filter((t) => allowed.has(serverCategory.get(t.server) ?? 'external'))
}

/**
 * The domain-specific skill categories and the capability each one requires. A
 * skill in one of these categories is dropped for a role lacking the capability;
 * a skill in any other (or uncategorized) category is always kept — skills are
 * advisory prompt content, so we only filter the clearly off-domain ones.
 */
const SKILL_CATEGORY_CAPABILITY: Partial<Record<SkillCategory, Capability>> = {
  git: 'git',
  web: 'web',
  research: 'web',
  testing: 'testing',
  devops: 'terminal'
}

/**
 * Filters enabled skills to those relevant to a role. Drops a skill only when
 * its category maps to a capability the role lacks (see
 * {@link SKILL_CATEGORY_CAPABILITY}); everything else is kept so a generally
 * useful skill is never hidden.
 */
export function scopeSkills(
  enabled: readonly SkillInfo[],
  capabilities: readonly Capability[]
): SkillInfo[] {
  const has = new Set(capabilities)
  return enabled.filter((s) => {
    const required = s.category ? SKILL_CATEGORY_CAPABILITY[s.category] : undefined
    return !required || has.has(required)
  })
}

/**
 * Whether a role may execute a tool kind. Enforced in the engine's `executeTool`:
 * an out-of-scope tool becomes a failed tool-result fed back to the loop (the
 * model learns it can't do that), never a silent mutation.
 *  - `read`        → always. Every role must be able to look at the project it is
 *    working on; a reviewer that couldn't read files could not review, and reading
 *    is not a side effect. Scoping applies to what an agent may CHANGE.
 *  - `write_file`  → needs `filesystem`.
 *  - `run_command` → needs `terminal`, `code-exec`, or `testing`.
 *  - `mcp_call`    → needs any MCP-granting capability (finer per-server scoping
 *    already happens in {@link scopeMcpTools}, so the role only ever sees tools
 *    it may call).
 */
export function allowsTool(capabilities: readonly Capability[], toolKind: ToolKind): boolean {
  const has = new Set(capabilities)
  switch (toolKind) {
    case 'read':
      return true
    case 'write_file':
      return has.has('filesystem')
    case 'run_command':
      return has.has('terminal') || has.has('code-exec') || has.has('testing')
    case 'mcp_call':
      return has.has('mcp') || mcpCategoriesFor(capabilities).size > 0
    default:
      return false
  }
}
