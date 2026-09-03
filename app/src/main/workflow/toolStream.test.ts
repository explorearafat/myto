import { describe, expect, it, vi } from 'vitest'
import { ToolStreamParser, parseToolBlock, type ParsedTool } from '@main/workflow/toolStream'

// Fence literals (single-quoted so backticks are literal, \n is a real newline).
const OPEN = '```sylor-tool\n'
const CLOSE = '\n```\n'

/** Wraps a tool payload object in a full sylor-tool block. */
function block(payload: unknown): string {
  return OPEN + JSON.stringify(payload) + CLOSE
}

/** Feeds a whole string through a fresh parser and returns emitted prose + tools. */
function run(input: string): { prose: string; tools: ParsedTool[] } {
  const parser = new ToolStreamParser()
  const prose = parser.push(input) + parser.flush()
  return { prose, tools: parser.tools }
}

describe('parseToolBlock', () => {
  it('parses a valid write_file block', () => {
    expect(parseToolBlock('{ "tool": "write_file", "path": "a.ts", "content": "x" }')).toEqual({
      tool: 'write_file',
      path: 'a.ts',
      content: 'x'
    })
  })

  it('parses a valid run_command block', () => {
    expect(parseToolBlock('{ "tool": "run_command", "command": "npm test" }')).toEqual({
      tool: 'run_command',
      command: 'npm test'
    })
  })

  it('rejects malformed JSON', () => {
    expect(parseToolBlock('{ not json')).toBeNull()
  })

  it('rejects a write_file missing content', () => {
    expect(parseToolBlock('{ "tool": "write_file", "path": "a.ts" }')).toBeNull()
  })

  it('rejects a write_file with an empty path', () => {
    expect(parseToolBlock('{ "tool": "write_file", "path": "  ", "content": "x" }')).toBeNull()
  })

  it('rejects a run_command with an empty command', () => {
    expect(parseToolBlock('{ "tool": "run_command", "command": "" }')).toBeNull()
  })

  it('rejects an unknown tool', () => {
    expect(parseToolBlock('{ "tool": "delete_everything" }')).toBeNull()
  })

  it('parses a valid mcp_call block with arguments', () => {
    expect(
      parseToolBlock(
        '{ "tool": "mcp_call", "server": "fs", "name": "read", "arguments": { "path": "a.txt" } }'
      )
    ).toEqual({ tool: 'mcp_call', server: 'fs', name: 'read', arguments: { path: 'a.txt' } })
  })

  it('defaults mcp_call arguments to {} when omitted or not a plain object', () => {
    expect(parseToolBlock('{ "tool": "mcp_call", "server": "fs", "name": "read" }')).toEqual({
      tool: 'mcp_call',
      server: 'fs',
      name: 'read',
      arguments: {}
    })
    // A non-object `arguments` (array/string/null) is treated as "none", not rejected.
    expect(
      parseToolBlock('{ "tool": "mcp_call", "server": "fs", "name": "read", "arguments": [1, 2] }')
    ).toEqual({ tool: 'mcp_call', server: 'fs', name: 'read', arguments: {} })
  })

  it('rejects an mcp_call missing (or blank) server or name', () => {
    expect(parseToolBlock('{ "tool": "mcp_call", "name": "read" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "mcp_call", "server": "fs" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "mcp_call", "server": "  ", "name": "read" }')).toBeNull()
  })

  it('parses a valid use_skill block', () => {
    expect(parseToolBlock('{ "tool": "use_skill", "name": "pdf-tools" }')).toEqual({
      tool: 'use_skill',
      name: 'pdf-tools'
    })
  })

  it('rejects a use_skill missing (or blank) name', () => {
    expect(parseToolBlock('{ "tool": "use_skill" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "use_skill", "name": "   " }')).toBeNull()
  })

  it('parses a project-scoped remember block', () => {
    expect(parseToolBlock('{ "tool": "remember", "note": "uses pnpm, not npm" }')).toEqual({
      tool: 'remember',
      note: 'uses pnpm, not npm'
    })
  })

  it('parses a global remember_user block (cross-project user memory)', () => {
    expect(
      parseToolBlock('{ "tool": "remember_user", "note": "likes clean minimal sites" }')
    ).toEqual({ tool: 'remember_user', note: 'likes clean minimal sites' })
  })

  it('rejects a remember / remember_user with a blank or missing note', () => {
    expect(parseToolBlock('{ "tool": "remember" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "remember", "note": "   " }')).toBeNull()
    expect(parseToolBlock('{ "tool": "remember_user" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "remember_user", "note": "" }')).toBeNull()
  })

  it('parses a valid spawn_agent block', () => {
    expect(
      parseToolBlock('{ "tool": "spawn_agent", "role": "builder", "task": "scaffold the app" }')
    ).toEqual({ tool: 'spawn_agent', role: 'builder', task: 'scaffold the app' })
  })

  it('rejects a spawn_agent with an un-spawnable role or blank/missing task', () => {
    // `lead` is the run itself — never spawnable.
    expect(parseToolBlock('{ "tool": "spawn_agent", "role": "lead", "task": "x" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "spawn_agent", "role": "nope", "task": "x" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "spawn_agent", "role": "builder", "task": "  " }')).toBeNull()
    expect(parseToolBlock('{ "tool": "spawn_agent", "role": "builder" }')).toBeNull()
  })

  it('parses an edit_file block, mapping the wire snake_case to camelCase', () => {
    expect(
      parseToolBlock(
        '{ "tool": "edit_file", "path": "a.ts", "old_string": "let x", "new_string": "const x" }'
      )
    ).toEqual({
      tool: 'edit_file',
      path: 'a.ts',
      oldString: 'let x',
      newString: 'const x',
      replaceAll: false
    })
  })

  it('parses edit_file with replace_all, and treats an empty new_string as a deletion', () => {
    expect(
      parseToolBlock(
        '{ "tool": "edit_file", "path": "a.ts", "old_string": "debug\\n", "new_string": "", "replace_all": true }'
      )
    ).toEqual({
      tool: 'edit_file',
      path: 'a.ts',
      oldString: 'debug\n',
      newString: '',
      replaceAll: true
    })
  })

  it('rejects an edit_file that could not change anything', () => {
    // Missing halves, an empty needle, or old === new: all no-ops, so the block is
    // malformed rather than a valid write of unchanged content.
    expect(parseToolBlock('{ "tool": "edit_file", "path": "a.ts", "old_string": "x" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "edit_file", "path": "a.ts", "new_string": "x" }')).toBeNull()
    expect(
      parseToolBlock('{ "tool": "edit_file", "path": "a.ts", "old_string": "", "new_string": "x" }')
    ).toBeNull()
    expect(
      parseToolBlock('{ "tool": "edit_file", "path": "a.ts", "old_string": "x", "new_string": "x" }')
    ).toBeNull()
    expect(
      parseToolBlock('{ "tool": "edit_file", "path": " ", "old_string": "x", "new_string": "y" }')
    ).toBeNull()
  })

  it('parses a read_file block with and without a line window', () => {
    expect(parseToolBlock('{ "tool": "read_file", "path": "src/a.ts" }')).toEqual({
      tool: 'read_file',
      path: 'src/a.ts'
    })
    expect(
      parseToolBlock('{ "tool": "read_file", "path": "src/a.ts", "offset": 40, "limit": 20 }')
    ).toEqual({ tool: 'read_file', path: 'src/a.ts', offset: 40, limit: 20 })
  })

  it('drops a nonsensical offset/limit rather than failing the whole read', () => {
    // Reading the whole file is a fine fallback; refusing to read at all is not.
    expect(
      parseToolBlock(
        '{ "tool": "read_file", "path": "a.ts", "offset": 0, "limit": "lots" }'
      )
    ).toEqual({ tool: 'read_file', path: 'a.ts' })
  })

  it('rejects a read_file with no path', () => {
    expect(parseToolBlock('{ "tool": "read_file" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "read_file", "path": "  " }')).toBeNull()
  })

  it('defaults list_files to the project root', () => {
    expect(parseToolBlock('{ "tool": "list_files" }')).toEqual({ tool: 'list_files', path: '.' })
    expect(parseToolBlock('{ "tool": "list_files", "path": "src" }')).toEqual({
      tool: 'list_files',
      path: 'src'
    })
  })

  it('parses a search_files block, defaulting the search root and keeping the glob', () => {
    expect(parseToolBlock('{ "tool": "search_files", "query": "useAuth" }')).toEqual({
      tool: 'search_files',
      query: 'useAuth',
      path: '.'
    })
    expect(
      parseToolBlock(
        '{ "tool": "search_files", "query": "useAuth", "path": "src", "glob": "*.tsx" }'
      )
    ).toEqual({ tool: 'search_files', query: 'useAuth', path: 'src', glob: '*.tsx' })
  })

  it('rejects a search_files with no query', () => {
    expect(parseToolBlock('{ "tool": "search_files", "path": "src" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "search_files", "query": "" }')).toBeNull()
  })

  it('parses the richer search_files options: context lines, multiline, and mode', () => {
    expect(
      parseToolBlock(
        '{ "tool": "search_files", "query": "foo", "before": 2, "after": 3, "context": 1, "multiline": true, "mode": "count" }'
      )
    ).toEqual({
      tool: 'search_files',
      query: 'foo',
      path: '.',
      before: 2,
      after: 3,
      context: 1,
      multiline: true,
      mode: 'count'
    })
  })

  it('drops invalid search_files options rather than failing the whole block', () => {
    // Negative/non-numeric context, an unknown mode, and a non-boolean multiline all
    // fall back to undefined — the grep still runs, just without the bad refinement.
    expect(
      parseToolBlock(
        '{ "tool": "search_files", "query": "foo", "before": -5, "after": "x", "mode": "bogus", "multiline": "yes" }'
      )
    ).toEqual({ tool: 'search_files', query: 'foo', path: '.' })
  })

  it('parses a find_files block, defaulting the search root and keeping the glob', () => {
    expect(parseToolBlock('{ "tool": "find_files", "glob": "**/*.ts" }')).toEqual({
      tool: 'find_files',
      glob: '**/*.ts',
      path: '.'
    })
    expect(parseToolBlock('{ "tool": "find_files", "glob": "*.tsx", "path": "src" }')).toEqual({
      tool: 'find_files',
      glob: '*.tsx',
      path: 'src'
    })
  })

  it('rejects a find_files with a blank or missing glob', () => {
    expect(parseToolBlock('{ "tool": "find_files", "path": "src" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "find_files", "glob": "  " }')).toBeNull()
  })

  it('parses a web_fetch block, trimming and requiring an http(s) URL', () => {
    expect(parseToolBlock('{ "tool": "web_fetch", "url": " https://example.com/doc " }')).toEqual({
      tool: 'web_fetch',
      url: 'https://example.com/doc'
    })
    expect(parseToolBlock('{ "tool": "web_fetch", "url": "http://example.com" }')).toEqual({
      tool: 'web_fetch',
      url: 'http://example.com'
    })
  })

  it('rejects a web_fetch with a non-http(s) or missing URL', () => {
    expect(parseToolBlock('{ "tool": "web_fetch", "url": "file:///etc/passwd" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "web_fetch", "url": "ftp://host/x" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "web_fetch", "url": "example.com" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "web_fetch" }')).toBeNull()
  })

  it('parses a web_search block, trimming the query', () => {
    expect(parseToolBlock('{ "tool": "web_search", "query": "  vite base path  " }')).toEqual({
      tool: 'web_search',
      query: 'vite base path'
    })
  })

  it('rejects a web_search with an empty or missing query', () => {
    expect(parseToolBlock('{ "tool": "web_search", "query": "   " }')).toBeNull()
    expect(parseToolBlock('{ "tool": "web_search" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "web_search", "query": 42 }')).toBeNull()
  })

  it('parses an install_plugin block, trimming the source and defaulting scope to global', () => {
    expect(parseToolBlock('{ "tool": "install_plugin", "source": "  owner/repo  " }')).toEqual({
      tool: 'install_plugin',
      source: 'owner/repo',
      scope: 'global'
    })
  })

  it('honours an explicit project scope on install_plugin', () => {
    expect(
      parseToolBlock('{ "tool": "install_plugin", "source": "owner/repo", "scope": "project" }')
    ).toEqual({ tool: 'install_plugin', source: 'owner/repo', scope: 'project' })
  })

  it('coerces an unknown install_plugin scope back to global', () => {
    expect(
      parseToolBlock('{ "tool": "install_plugin", "source": "owner/repo", "scope": "weird" }')
    ).toEqual({ tool: 'install_plugin', source: 'owner/repo', scope: 'global' })
  })

  it('rejects an install_plugin with a blank or missing source', () => {
    expect(parseToolBlock('{ "tool": "install_plugin", "source": "   " }')).toBeNull()
    expect(parseToolBlock('{ "tool": "install_plugin" }')).toBeNull()
  })

  it('parses a preview_inspect screenshot (action-only)', () => {
    expect(parseToolBlock('{ "tool": "preview_inspect", "action": "screenshot" }')).toEqual({
      tool: 'preview_inspect',
      action: 'screenshot',
      selector: undefined,
      styles: undefined,
      value: undefined,
      level: undefined,
      filter: undefined,
      preset: undefined,
      width: undefined,
      height: undefined
    })
  })

  it('parses a preview_inspect inspect with a selector and styles', () => {
    expect(
      parseToolBlock(
        '{ "tool": "preview_inspect", "action": "inspect", "selector": " .cta ", "styles": ["color", "font-size"] }'
      )
    ).toMatchObject({
      tool: 'preview_inspect',
      action: 'inspect',
      selector: '.cta',
      styles: ['color', 'font-size']
    })
  })

  it('parses a preview_inspect fill, keeping the value (empty string clears the field)', () => {
    expect(
      parseToolBlock(
        '{ "tool": "preview_inspect", "action": "fill", "selector": "#email", "value": "a@b.com" }'
      )
    ).toMatchObject({ tool: 'preview_inspect', action: 'fill', selector: '#email', value: 'a@b.com' })
    expect(
      parseToolBlock('{ "tool": "preview_inspect", "action": "fill", "selector": "#q", "value": "" }')
    ).toMatchObject({ tool: 'preview_inspect', action: 'fill', selector: '#q', value: '' })
  })

  it('parses preview_inspect console_logs / network filters and resize dims', () => {
    expect(
      parseToolBlock('{ "tool": "preview_inspect", "action": "console_logs", "level": "error" }')
    ).toMatchObject({ action: 'console_logs', level: 'error' })
    expect(
      parseToolBlock('{ "tool": "preview_inspect", "action": "network", "filter": "failed" }')
    ).toMatchObject({ action: 'network', filter: 'failed' })
    expect(
      parseToolBlock('{ "tool": "preview_inspect", "action": "resize", "width": 375, "height": 812 }')
    ).toMatchObject({ action: 'resize', width: 375, height: 812 })
    expect(
      parseToolBlock('{ "tool": "preview_inspect", "action": "resize", "preset": "mobile" }')
    ).toMatchObject({ action: 'resize', preset: 'mobile' })
  })

  it('rejects preview_inspect with an unknown action', () => {
    expect(parseToolBlock('{ "tool": "preview_inspect", "action": "hack" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "preview_inspect" }')).toBeNull()
  })

  it('rejects inspect/click/fill without a selector, and fill without a value', () => {
    expect(parseToolBlock('{ "tool": "preview_inspect", "action": "inspect" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "preview_inspect", "action": "click" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "preview_inspect", "action": "fill", "selector": "#q" }')).toBeNull()
  })

  it('drops invalid preview_inspect refinements rather than failing the block', () => {
    // A bogus level/filter/preset and non-positive dims all fall back to undefined;
    // the action itself is still well-defined, so the check still runs.
    expect(
      parseToolBlock(
        '{ "tool": "preview_inspect", "action": "console_logs", "level": "loud", "filter": "weird", "preset": "watch", "width": -1 }'
      )
    ).toEqual({
      tool: 'preview_inspect',
      action: 'console_logs',
      selector: undefined,
      styles: undefined,
      value: undefined,
      level: undefined,
      filter: undefined,
      preset: undefined,
      width: undefined,
      height: undefined
    })
  })

  // ── browse ──
  // The parse is the first gate a browse step passes: a block missing the one field
  // its action cannot work without is rejected here, before it reaches a browser.

  it('parses a browse read, the simplest step there is', () => {
    expect(parseToolBlock('{ "tool": "browse", "action": "read" }')).toMatchObject({
      tool: 'browse',
      action: 'read',
      visual: undefined
    })
  })

  it('parses a visual read, which rides the vision path', () => {
    expect(
      parseToolBlock('{ "tool": "browse", "action": "read", "visual": true }')
    ).toMatchObject({ tool: 'browse', action: 'read', visual: true })
    // `visual` only means anything on a read.
    expect(
      parseToolBlock('{ "tool": "browse", "action": "scroll", "visual": true }')
    ).toMatchObject({ action: 'scroll', visual: undefined })
  })

  it('parses a navigate and trims the url', () => {
    expect(
      parseToolBlock('{ "tool": "browse", "action": "navigate", "url": "  example.com  " }')
    ).toMatchObject({ tool: 'browse', action: 'navigate', url: 'example.com' })
  })

  it('parses a click by index or by label', () => {
    expect(
      parseToolBlock('{ "tool": "browse", "action": "click", "target": "#12" }')
    ).toMatchObject({ action: 'click', target: '#12' })
    expect(
      parseToolBlock('{ "tool": "browse", "action": "click", "target": " Compose " }')
    ).toMatchObject({ action: 'click', target: 'Compose' })
  })

  it('parses a type, keeping an empty string (that is "clear the field")', () => {
    expect(
      parseToolBlock(
        '{ "tool": "browse", "action": "type", "target": "Search", "text": "electron", "submit": true }'
      )
    ).toMatchObject({ action: 'type', target: 'Search', text: 'electron', submit: true })
    expect(
      parseToolBlock('{ "tool": "browse", "action": "type", "target": "Search", "text": "" }')
    ).toMatchObject({ action: 'type', text: '', submit: undefined })
  })

  it('defaults a scroll to down, and only accepts the two directions', () => {
    expect(parseToolBlock('{ "tool": "browse", "action": "scroll" }')).toMatchObject({
      action: 'scroll',
      direction: 'down'
    })
    expect(
      parseToolBlock('{ "tool": "browse", "action": "scroll", "direction": "up" }')
    ).toMatchObject({ direction: 'up' })
    expect(
      parseToolBlock('{ "tool": "browse", "action": "scroll", "direction": "sideways" }')
    ).toMatchObject({ direction: 'down' })
  })

  it('rejects a browse block that cannot be carried out', () => {
    // Each of these is missing the one field its action is meaningless without.
    expect(parseToolBlock('{ "tool": "browse" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "browse", "action": "teleport" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "browse", "action": "navigate" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "browse", "action": "navigate", "url": "   " }')).toBeNull()
    expect(parseToolBlock('{ "tool": "browse", "action": "click" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "browse", "action": "type", "target": "q" }')).toBeNull()
  })

  it('ignores fields that belong to another action', () => {
    // A navigate carrying `text` must not silently become a type.
    expect(
      parseToolBlock(
        '{ "tool": "browse", "action": "navigate", "url": "example.com", "text": "hi", "target": "Search" }'
      )
    ).toMatchObject({ action: 'navigate', text: undefined, direction: undefined })
  })

  it('parses the three debug reads', () => {
    // level/filter are left unset when unstated; the read applies its own default.
    expect(parseToolBlock('{ "tool": "browse", "action": "console" }')).toMatchObject({
      action: 'console',
      level: undefined
    })
    expect(
      parseToolBlock('{ "tool": "browse", "action": "console", "level": "error" }')
    ).toMatchObject({ action: 'console', level: 'error' })
    expect(parseToolBlock('{ "tool": "browse", "action": "network" }')).toMatchObject({
      action: 'network',
      filter: undefined
    })
    expect(
      parseToolBlock('{ "tool": "browse", "action": "network", "filter": "failed" }')
    ).toMatchObject({ action: 'network', filter: 'failed' })
    expect(
      parseToolBlock(
        '{ "tool": "browse", "action": "inspect", "selector": " .hero h1 ", "styles": ["gap", 7] }'
      )
    ).toMatchObject({ action: 'inspect', selector: '.hero h1', styles: ['gap'] })
  })

  it('drops a debug value it does not recognize', () => {
    expect(
      parseToolBlock('{ "tool": "browse", "action": "console", "level": "loud" }')
    ).toMatchObject({ level: undefined })
    expect(
      parseToolBlock('{ "tool": "browse", "action": "network", "filter": "slow" }')
    ).toMatchObject({ filter: undefined })
    expect(
      parseToolBlock('{ "tool": "browse", "action": "inspect", "selector": "h1", "styles": [3] }')
    ).toMatchObject({ styles: undefined })
  })

  it('accepts `target` as the selector for an inspect, but requires one of them', () => {
    // The model reaches for `target` out of habit from click/type; an inspect with
    // no element at all is not a read, so it is rejected here.
    expect(
      parseToolBlock('{ "tool": "browse", "action": "inspect", "target": "#total" }')
    ).toMatchObject({ action: 'inspect', selector: '#total' })
    expect(parseToolBlock('{ "tool": "browse", "action": "inspect" }')).toBeNull()
    expect(parseToolBlock('{ "tool": "browse", "action": "inspect", "selector": "  " }')).toBeNull()
  })

  it('keeps a debug field out of an action it does not belong to', () => {
    expect(
      parseToolBlock(
        '{ "tool": "browse", "action": "click", "target": "Save", "level": "error", "filter": "failed", "selector": "h1" }'
      )
    ).toMatchObject({ action: 'click', level: undefined, filter: undefined, selector: undefined })
  })

  // ── diagnostics ──
  // Unlike browse, every field is optional: the bare block is the common case
  // ("check the whole project"), so nothing here may reject it.
  it('parses a bare diagnostics block', () => {
    expect(parseToolBlock('{ "tool": "diagnostics" }')).toEqual({
      tool: 'diagnostics',
      scope: undefined,
      files: undefined
    })
  })

  it('keeps a known scope and drops an invented one', () => {
    expect(parseToolBlock('{ "tool": "diagnostics", "scope": "typescript" }')).toMatchObject({
      scope: 'typescript'
    })
    expect(parseToolBlock('{ "tool": "diagnostics", "scope": "eslint" }')).toMatchObject({
      scope: 'eslint'
    })
    expect(parseToolBlock('{ "tool": "diagnostics", "scope": "all" }')).toMatchObject({
      scope: 'all'
    })
    // Left undefined, not defaulted here — the runner owns the default.
    expect(parseToolBlock('{ "tool": "diagnostics", "scope": "prettier" }')).toMatchObject({
      scope: undefined
    })
  })

  it('accepts `paths` as an alias for `files`', () => {
    expect(
      parseToolBlock('{ "tool": "diagnostics", "paths": ["src/main/a.ts"] }')
    ).toMatchObject({ files: ['src/main/a.ts'] })
    // `files` wins when both are present.
    expect(
      parseToolBlock('{ "tool": "diagnostics", "files": ["a.ts"], "paths": ["b.ts"] }')
    ).toMatchObject({ files: ['a.ts'] })
  })

  it('keeps the usable paths instead of losing the narrowing to one bad entry', () => {
    expect(
      parseToolBlock('{ "tool": "diagnostics", "files": ["src/a.ts", "", 7, null, "src/b.ts"] }')
    ).toMatchObject({ files: ['src/a.ts', 'src/b.ts'] })
    // No usable path at all is the same as not narrowing — never an empty check.
    expect(parseToolBlock('{ "tool": "diagnostics", "files": [] }')).toMatchObject({
      files: undefined
    })
    expect(parseToolBlock('{ "tool": "diagnostics", "files": "src/a.ts" }')).toMatchObject({
      files: undefined
    })
  })
})

describe('ToolStreamParser', () => {
  it('passes prose through untouched when there are no blocks', () => {
    const { prose, tools } = run('Just a normal explanation with no tools.')
    expect(prose).toBe('Just a normal explanation with no tools.')
    expect(tools).toHaveLength(0)
  })

  it('extracts a single block and separates surrounding prose', () => {
    const { prose, tools } = run(
      'Let me create that file.\n' +
        block({ tool: 'write_file', path: 'src/x.ts', content: 'export const x = 1' }) +
        'All set.'
    )
    expect(prose).toBe('Let me create that file.\nAll set.')
    expect(tools).toEqual([{ tool: 'write_file', path: 'src/x.ts', content: 'export const x = 1' }])
  })

  it('extracts multiple blocks in stream order', () => {
    const { tools } = run(
      block({ tool: 'write_file', path: 'a.ts', content: 'a' }) +
        'then\n' +
        block({ tool: 'run_command', command: 'npm test' })
    )
    expect(tools).toEqual([
      { tool: 'write_file', path: 'a.ts', content: 'a' },
      { tool: 'run_command', command: 'npm test' }
    ])
  })

  it('extracts an mcp_call block and separates surrounding prose', () => {
    const { prose, tools } = run(
      'Calling the tool.\n' +
        block({ tool: 'mcp_call', server: 'fs', name: 'read', arguments: { path: 'a.txt' } }) +
        'Done.'
    )
    expect(prose).toBe('Calling the tool.\nDone.')
    expect(tools).toEqual([
      { tool: 'mcp_call', server: 'fs', name: 'read', arguments: { path: 'a.txt' } }
    ])
  })

  it('extracts a use_skill block and separates surrounding prose', () => {
    const { prose, tools } = run(
      'Loading the skill.\n' + block({ tool: 'use_skill', name: 'pdf-tools' }) + 'Done.'
    )
    expect(prose).toBe('Loading the skill.\nDone.')
    expect(tools).toEqual([{ tool: 'use_skill', name: 'pdf-tools' }])
  })

  it('handles a fence marker split across chunks', () => {
    const parser = new ToolStreamParser()
    let prose = ''
    // The open fence is split mid-marker; the parser must not leak "```sylor".
    prose += parser.push('Here goes ```sylor')
    prose += parser.push('-tool\n{ "tool": "run_command", "command": "ls" }\n``')
    prose += parser.push('`\nDone')
    prose += parser.flush()
    expect(prose).toBe('Here goes Done')
    expect(parser.tools).toEqual([{ tool: 'run_command', command: 'ls' }])
  })

  it('does not treat backticks inside file content as a closing fence', () => {
    // Content holds a Markdown code fence; JSON encodes its newlines as \n, so no
    // raw-newline+``` appears until the real close fence.
    const content = '# Readme\n```\nconst y = 2\n```\n'
    const { prose, tools } = run(block({ tool: 'write_file', path: 'README.md', content }))
    expect(prose).toBe('')
    expect(tools).toEqual([{ tool: 'write_file', path: 'README.md', content }])
  })

  it('recognizes a closing fence with trailing whitespace and keeps following prose', () => {
    // A fence like "```  \n" (trailing spaces before the newline) must close the
    // block — otherwise the op AND all trailing prose get swallowed into a failed
    // JSON parse. This matches what flush() already tolerates.
    const { prose, tools } = run(
      'Before.\n' + OPEN + '{ "tool": "run_command", "command": "ls" }' + '\n```  \n' + 'After.'
    )
    expect(tools).toEqual([{ tool: 'run_command', command: 'ls' }])
    expect(prose).toBe('Before.\nAfter.')
  })

  it('does not leak a stray newline when a CRLF close fence splits at the CR', () => {
    const parser = new ToolStreamParser()
    let prose = ''
    // Chunk boundary falls exactly between '\r' and '\n' of the close fence.
    prose += parser.push(OPEN + '{ "tool": "run_command", "command": "ls" }' + '\n```\r')
    prose += parser.push('\nDone')
    prose += parser.flush()
    expect(parser.tools).toEqual([{ tool: 'run_command', command: 'ls' }])
    // The '\n' after '\r' is consumed by the fence, not leaked into the prose.
    expect(prose).toBe('Done')
  })

  it('drops a malformed block with a warning instead of throwing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { prose, tools } = run('Before\n' + OPEN + 'this is not json' + CLOSE + 'After')
    // Prose before/after the block is preserved verbatim (incl. the leading newline).
    expect(prose).toBe('Before\nAfter')
    expect(tools).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('salvages a trailing block whose close fence never arrived', () => {
    const parser = new ToolStreamParser()
    const emitted = parser.push(
      'Editing…\n' + OPEN + '{ "tool": "write_file", "path": "z.ts", "content": "z" }'
    )
    // In-block bytes are suppressed while streaming.
    expect(emitted).toBe('Editing…\n')
    // flush() salvages the unterminated block.
    parser.flush()
    expect(parser.tools).toEqual([{ tool: 'write_file', path: 'z.ts', content: 'z' }])
  })
})

describe('ToolStreamParser stop-at-action', () => {
  // The engine stops on mutating tools; reads are exempt so they can batch.
  const stopOnWrite = (t: ParsedTool): boolean => t.tool === 'write_file' || t.tool === 'edit_file'

  it('stops after the first matching block and discards the rest of the message', () => {
    const a = { tool: 'write_file' as const, path: 'a.ts', content: 'a' }
    const b = { tool: 'write_file' as const, path: 'b.ts', content: 'b' }
    const input = 'Writing a.\n' + block(a) + 'Writing b.\n' + block(b)
    const parser = new ToolStreamParser({ stopAfter: stopOnWrite })
    const prose = parser.push(input)

    expect(parser.stopped).toBe(true)
    // Only the first action ran; the second block never became a tool.
    expect(parser.tools).toEqual([a])
    // Prose *before* the block is shown; prose after it — narrating work that will
    // never happen — is suppressed, so the chat can't describe a phantom file.
    expect(prose).toBe('Writing a.\n')
    // `consumed` marks exactly the end of the executed block, so the engine can
    // truncate the replayed assistant turn to what actually ran.
    expect(input.slice(0, parser.consumed)).toBe('Writing a.\n' + block(a))
    // flush() after a stop yields nothing (and never resurrects held prose).
    expect(parser.flush()).toBe('')
  })

  it('does not stop on read-only blocks, so several reads still batch', () => {
    const r1 = { tool: 'read_file' as const, path: 'a.ts' }
    const r2 = { tool: 'list_files' as const, path: 'src' }
    const r3 = { tool: 'search_files' as const, query: 'x', path: '.' }
    const parser = new ToolStreamParser({ stopAfter: stopOnWrite })
    parser.push(block(r1) + block(r2) + block(r3))
    parser.flush()

    expect(parser.stopped).toBe(false)
    expect(parser.tools).toEqual([r1, r2, r3])
  })

  it('stops even when the matching block is split across chunks', () => {
    const parser = new ToolStreamParser({ stopAfter: stopOnWrite })
    let prose = ''
    prose += parser.push('One. ```sylor')
    prose += parser.push('-tool\n{ "tool": "write_file", "path": "a.ts", "content": "a" }\n``')
    prose += parser.push('`\nTwo.' + block({ tool: 'write_file', path: 'b.ts', content: 'b' }))

    expect(parser.stopped).toBe(true)
    expect(parser.tools).toEqual([{ tool: 'write_file', path: 'a.ts', content: 'a' }])
    expect(prose).toBe('One. ')
    // Once stopped, further deltas are ignored entirely.
    expect(parser.push('ignored')).toBe('')
  })

  it('with no stopAfter, still parses every block (unchanged default)', () => {
    const parser = new ToolStreamParser()
    parser.push(
      block({ tool: 'write_file', path: 'a.ts', content: 'a' }) +
        block({ tool: 'write_file', path: 'b.ts', content: 'b' })
    )
    parser.flush()
    expect(parser.stopped).toBe(false)
    expect(parser.tools).toHaveLength(2)
  })

  it('stops on a matching block that only flush() salvages', () => {
    const parser = new ToolStreamParser({ stopAfter: stopOnWrite })
    // Unterminated block (close fence never arrived); flush() salvages it and the
    // stop must still latch.
    parser.push('Editing…\n' + OPEN + '{ "tool": "write_file", "path": "z.ts", "content": "z" }')
    expect(parser.flush()).toBe('')
    expect(parser.stopped).toBe(true)
    expect(parser.tools).toEqual([{ tool: 'write_file', path: 'z.ts', content: 'z' }])
  })
})
