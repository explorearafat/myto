/**
 * Curated built-in MCP catalog.
 *
 * A small, deliberately-curated set of FREE, open-source MCP servers — quality
 * over quantity. Every entry is a real, currently-maintained package (verified
 * against npm / PyPI); nothing here is invented. Servers are the official MCP
 * reference servers plus Microsoft's Playwright server and GitHub's own hosted
 * remote server.
 *
 * Opt-in by design: EVERY catalog server defaults OFF (`defaultOn: false`). Sylor
 * already ships native file/search/run tools, runs offline-first, and depends on
 * `npx`/`uvx` being present — so auto-spawning servers on launch would be noisy
 * and contrary to the "don't enable everything" requirement. Instead each entry
 * carries a `recommended` flag to guide the user's choice, and enabling one
 * connects it hot. Nothing dangerous (broad shell/system control) is included.
 *
 * `build(root)` produces the live {@link McpServerConfig} when a server is
 * enabled. Filesystem/Git are scoped to the active workspace root, mirroring
 * Sylor's sandbox; if there's no workspace yet, {@link needsWorkspace} marks them
 * "requires configuration" rather than silently falling back to the cwd.
 */
import type {
  McpCategory,
  McpRisk,
  McpServerConfig,
  McpTransport
} from '../../shared/types'
import { transportOf } from './config'

/** One curated built-in server. `build`/`needs*` are code, never persisted. */
export interface McpCatalogEntry {
  /** Stable id used as the server name + override key. */
  name: string
  /** Human-facing display name. */
  title: string
  /** One-line description of what the server adds. */
  description: string
  category: McpCategory
  /** Always false for the catalog — every built-in is opt-in. */
  defaultOn: boolean
  /** Whether Sylor suggests enabling this (guides opt-in). */
  recommended: boolean
  /** True when it runs locally; false when it reaches the network. */
  local: boolean
  /** Coarse risk/scope, so the UI is honest about what enabling exposes. */
  risk: McpRisk
  /** Documentation/homepage URL. */
  homepage: string
  /** When set, enabling needs this credential (shown as "Requires API Key"). */
  requiresApiKey?: string
  /** True when this server must be scoped to a workspace folder to run. */
  needsWorkspace?: boolean
  /** Builds the live config for connecting (root scopes filesystem/git). */
  build: (root: string | null) => McpServerConfig
}

/** Transport a catalog entry uses (for the UI badge, without building the config). */
export function catalogTransport(entry: McpCatalogEntry): McpTransport {
  return transportOf(entry.build(null))
}

/**
 * The curated catalog. Categories span the recommended set (Core, Files, Git,
 * Web, Browser, Productivity, Development, External). All free + open-source.
 */
export const MCP_CATALOG: readonly McpCatalogEntry[] = [
  {
    name: 'sequential-thinking',
    title: 'Sequential Thinking',
    description:
      'A structured step-by-step reasoning tool for breaking hard problems into ordered thoughts. Pure computation — no file, network, or system access.',
    category: 'core',
    defaultOn: false,
    recommended: true,
    local: true,
    risk: 'read-only',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    build: () => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] })
  },
  {
    name: 'memory',
    title: 'Knowledge Graph Memory',
    description:
      'A persistent knowledge-graph memory (entities, relations, observations) stored in a local file, so facts survive across turns.',
    category: 'core',
    defaultOn: false,
    recommended: true,
    local: true,
    risk: 'local',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
    build: () => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] })
  },
  {
    name: 'filesystem',
    title: 'Filesystem',
    description:
      'Read, write, search, and manage files — scoped to your current workspace folder. Complements Sylor’s built-in file tools with richer directory operations.',
    category: 'files',
    defaultOn: false,
    recommended: true,
    local: true,
    risk: 'local',
    needsWorkspace: true,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    build: (root) => ({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', root ?? '.']
    })
  },
  {
    name: 'git',
    title: 'Git',
    description:
      'Read, search, and manipulate the workspace’s Git repository — status, diffs, log, branches, and commits. Requires Python’s uvx on PATH.',
    category: 'git',
    defaultOn: false,
    recommended: true,
    local: true,
    risk: 'local',
    needsWorkspace: true,
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git',
    build: (root) => ({ command: 'uvx', args: ['mcp-server-git', '--repository', root ?? '.'] })
  },
  {
    name: 'fetch',
    title: 'Web Fetch',
    description:
      'Fetch a URL and convert the page to clean Markdown for the model to read. Reaches the network. Requires Python’s uvx on PATH.',
    category: 'web',
    defaultOn: false,
    recommended: false,
    local: false,
    risk: 'network',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    build: () => ({ command: 'uvx', args: ['mcp-server-fetch'] })
  },
  {
    name: 'time',
    title: 'Time & Timezone',
    description:
      'Current time and timezone conversions. Small, local, read-only utility. Requires Python’s uvx on PATH.',
    category: 'productivity',
    defaultOn: false,
    recommended: false,
    local: true,
    risk: 'read-only',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
    build: () => ({ command: 'uvx', args: ['mcp-server-time'] })
  },
  {
    name: 'playwright',
    title: 'Playwright Browser',
    description:
      'Drive a real browser — navigate, click, type, and read pages via accessibility snapshots. Launches a local browser (system-level automation).',
    category: 'browser',
    defaultOn: false,
    recommended: false,
    local: false,
    risk: 'system',
    homepage: 'https://github.com/microsoft/playwright-mcp',
    build: () => ({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] })
  },
  {
    name: 'everything',
    title: 'MCP Everything (Test)',
    description:
      'A reference server exercising every MCP feature (tools, prompts, resources). Handy for testing that MCP integration works end-to-end.',
    category: 'development',
    defaultOn: false,
    recommended: false,
    local: true,
    risk: 'local',
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/everything',
    build: () => ({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] })
  },
  {
    name: 'github',
    title: 'GitHub',
    description:
      'GitHub’s official hosted MCP server: repositories, issues, and pull requests. Remote + external; needs a GitHub token supplied in mcp.json.',
    category: 'external',
    defaultOn: false,
    recommended: false,
    local: false,
    risk: 'network',
    requiresApiKey: 'GitHub personal access token',
    homepage: 'https://github.com/github/github-mcp-server',
    build: () => ({ url: 'https://api.githubcopilot.com/mcp/' })
  }
]

/** Looks up a catalog entry by name (undefined for a custom/disk server). */
export function mcpCatalogEntry(name: string): McpCatalogEntry | undefined {
  return MCP_CATALOG.find((e) => e.name === name)
}
