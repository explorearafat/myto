import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `node:fs` is mocked so loadMcpConfigs can be exercised without touching real
// files. `fsState` is hoisted (a vi.mock factory runs before top-level `let`s
// initialize), letting each test stage a path→contents map; an unstaged path
// throws, which the loader swallows into {} — exactly like a missing file. A
// `default` export is provided alongside the named one to satisfy Vitest's ESM
// interop (it probes for a default even though config.ts imports only the named).
const { fsState } = vi.hoisted(() => ({ fsState: { files: {} as Record<string, string> } }))
vi.mock('node:fs', () => {
  const readFileSync = (path: string): string => {
    const hit = fsState.files[path]
    if (hit === undefined) throw new Error(`ENOENT: ${path}`)
    return hit
  }
  return { readFileSync, default: { readFileSync } }
})

import {
  expandEnv,
  globalMcpConfigPath,
  loadMcpConfigs,
  parseMcpConfig,
  projectMcpConfigPath,
  transportOf
} from '@main/mcp/config'

describe('parseMcpConfig', () => {
  it('parses a stdio server (command + args + env)', () => {
    const out = parseMcpConfig({
      mcpServers: {
        fs: { command: 'npx', args: ['-y', 'server-filesystem', '.'], env: { TOKEN: 'x' } }
      }
    })
    expect(out).toEqual({
      fs: { command: 'npx', args: ['-y', 'server-filesystem', '.'], env: { TOKEN: 'x' } }
    })
  })

  it('parses a remote http server (url + headers)', () => {
    const out = parseMcpConfig({
      mcpServers: { remote: { url: 'https://e.com/mcp', headers: { Authorization: 'Bearer t' } } }
    })
    expect(out).toEqual({
      remote: { url: 'https://e.com/mcp', headers: { Authorization: 'Bearer t' } }
    })
  })

  it('treats a config carrying both url and command as remote (url wins)', () => {
    const out = parseMcpConfig({ mcpServers: { x: { url: 'https://e.com', command: 'npx' } } })
    expect(out.x).toEqual({ url: 'https://e.com' })
  })

  it('drops non-string args, and omits args entirely when none remain', () => {
    const kept = parseMcpConfig({ mcpServers: { a: { command: 'x', args: [1, 'ok', null] } } })
    expect(kept.a).toEqual({ command: 'x', args: ['ok'] })
    const none = parseMcpConfig({ mcpServers: { b: { command: 'x', args: [1, 2] } } })
    expect(none.b).toEqual({ command: 'x' })
  })

  it('omits env when it holds no string values', () => {
    const out = parseMcpConfig({ mcpServers: { a: { command: 'x', env: { N: 5 } } } })
    expect(out.a).toEqual({ command: 'x' })
  })

  it('drops invalid entries (no command/url) and blank names', () => {
    const out = parseMcpConfig({
      mcpServers: { good: { command: 'x' }, bad: { foo: 1 }, '   ': { command: 'y' } }
    })
    expect(Object.keys(out)).toEqual(['good'])
  })

  it('returns {} for non-object input or a missing/invalid mcpServers map', () => {
    expect(parseMcpConfig(null)).toEqual({})
    expect(parseMcpConfig('nope')).toEqual({})
    expect(parseMcpConfig({})).toEqual({})
    expect(parseMcpConfig({ mcpServers: 'x' })).toEqual({})
  })

  it('never throws on garbage entries', () => {
    expect(() => parseMcpConfig({ mcpServers: { a: 42, b: [], c: null } })).not.toThrow()
    expect(parseMcpConfig({ mcpServers: { a: 42, b: [], c: null } })).toEqual({})
  })
})

describe('parseMcpConfig — explicit transport type', () => {
  it('keeps a pinned remote type alongside the url', () => {
    const sse = parseMcpConfig({ mcpServers: { a: { type: 'sse', url: 'https://e.com/sse' } } })
    expect(sse.a).toEqual({ url: 'https://e.com/sse', type: 'sse' })
    const stream = parseMcpConfig({
      mcpServers: { a: { type: 'streamable-http', url: 'https://e.com/mcp' } }
    })
    expect(stream.a).toEqual({ url: 'https://e.com/mcp', type: 'streamable-http' })
    const http = parseMcpConfig({ mcpServers: { a: { type: 'http', url: 'https://e.com/mcp' } } })
    expect(http.a).toEqual({ url: 'https://e.com/mcp', type: 'http' })
  })

  it('lets a pinned stdio type win over a stray url', () => {
    const bare = parseMcpConfig({ mcpServers: { a: { type: 'stdio', command: 'npx' } } })
    expect(bare.a).toEqual({ command: 'npx', type: 'stdio' })
    const both = parseMcpConfig({
      mcpServers: { a: { type: 'stdio', command: 'npx', url: 'https://e.com' } }
    })
    expect(both.a).toEqual({ command: 'npx', type: 'stdio' })
  })

  it('drops a remote type with no url instead of falling back to stdio', () => {
    expect(parseMcpConfig({ mcpServers: { a: { type: 'sse', command: 'npx' } } })).toEqual({})
  })

  it('ignores an unrecognized type', () => {
    const out = parseMcpConfig({ mcpServers: { a: { type: 'grpc', url: 'https://e.com' } } })
    expect(out.a).toEqual({ url: 'https://e.com' })
  })

  it('keeps oauth only when it is exactly true', () => {
    const on = parseMcpConfig({ mcpServers: { a: { url: 'https://e.com', oauth: true } } })
    expect(on.a).toEqual({ url: 'https://e.com', oauth: true })
    const off = parseMcpConfig({ mcpServers: { a: { url: 'https://e.com', oauth: 'yes' } } })
    expect(off.a).toEqual({ url: 'https://e.com' })
  })
})

describe('expandEnv', () => {
  it('substitutes ${VAR} from the environment', () => {
    expect(expandEnv('Bearer ${T}', { T: 'secret' })).toBe('Bearer secret')
  })

  it('uses ${VAR:-fallback} when the variable is unset or empty', () => {
    expect(expandEnv('${T:-http://localhost}', {})).toBe('http://localhost')
    expect(expandEnv('${T:-fb}', { T: '' })).toBe('fb')
    expect(expandEnv('${T:-fb}', { T: 'real' })).toBe('real')
  })

  it('leaves an unset ${VAR} in place so the failure stays visible', () => {
    expect(expandEnv('Bearer ${MISSING}', {})).toBe('Bearer ${MISSING}')
  })

  it('expands every occurrence and leaves non-placeholder text alone', () => {
    expect(expandEnv('${A}/${A}-$B-{C}', { A: 'x', B: 'y' })).toBe('x/x-$B-{C}')
  })
})

describe('parseMcpConfig — env expansion', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('expands placeholders in url, headers, command, args and env', () => {
    vi.stubEnv('MCP_TOKEN', 'sekret')
    vi.stubEnv('MCP_HOST', 'example.com')
    const out = parseMcpConfig({
      mcpServers: {
        remote: {
          url: 'https://${MCP_HOST}/mcp',
          headers: { Authorization: 'Bearer ${MCP_TOKEN}' }
        },
        local: {
          command: '${MCP_BIN:-npx}',
          args: ['-y', 'srv', '--token=${MCP_TOKEN}'],
          env: { KEY: '${MCP_TOKEN}' }
        }
      }
    })
    expect(out.remote).toEqual({
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer sekret' }
    })
    expect(out.local).toEqual({
      command: 'npx',
      args: ['-y', 'srv', '--token=sekret'],
      env: { KEY: 'sekret' }
    })
  })

  it('drops a server whose command expands to nothing', () => {
    expect(parseMcpConfig({ mcpServers: { a: { command: '${NOPE:-}' } } })).toEqual({})
  })
})

describe('transportOf', () => {
  it('classifies stdio vs http by shape', () => {
    expect(transportOf({ command: 'npx' })).toBe('stdio')
    expect(transportOf({ url: 'https://e.com' })).toBe('http')
  })

  it('reports sse only when the config pins it', () => {
    expect(transportOf({ url: 'https://e.com', type: 'sse' })).toBe('sse')
    expect(transportOf({ url: 'https://e.com', type: 'streamable-http' })).toBe('http')
    expect(transportOf({ command: 'npx', type: 'stdio' })).toBe('stdio')
  })
})

describe('config paths', () => {
  it('derive from ~/.sylor and <root>/.sylor', () => {
    // Normalize separators so the assertion holds on Windows and POSIX alike.
    expect(globalMcpConfigPath().replace(/\\/g, '/')).toMatch(/\.sylor\/mcp\.json$/)
    expect(projectMcpConfigPath('/proj').replace(/\\/g, '/')).toBe('/proj/.sylor/mcp.json')
  })
})

describe('loadMcpConfigs', () => {
  beforeEach(() => {
    fsState.files = {}
  })

  it('merges global + project, with project shadowing a same-named global server', () => {
    fsState.files = {
      [globalMcpConfigPath()]: JSON.stringify({
        mcpServers: { g: { command: 'g' }, shared: { command: 'from-global' } }
      }),
      [projectMcpConfigPath('/proj')]: JSON.stringify({
        mcpServers: { p: { url: 'https://e.com' }, shared: { command: 'from-project' } }
      })
    }
    const byName = Object.fromEntries(loadMcpConfigs('/proj').map((s) => [s.name, s]))
    expect(byName.g.source).toBe('global')
    expect(byName.p.source).toBe('project')
    expect(byName.shared.source).toBe('project')
    expect(byName.shared.config).toEqual({ command: 'from-project' })
  })

  it('ignores the project file when projectRoot is null', () => {
    fsState.files = {
      [globalMcpConfigPath()]: JSON.stringify({ mcpServers: { g: { command: 'g' } } })
    }
    expect(loadMcpConfigs(null).map((s) => s.name)).toEqual(['g'])
  })

  it('yields [] when no config files exist (missing files are swallowed)', () => {
    expect(loadMcpConfigs('/proj')).toEqual([])
  })

  it('yields [] when a config file is malformed JSON', () => {
    fsState.files = { [globalMcpConfigPath()]: '{ not json' }
    expect(loadMcpConfigs(null)).toEqual([])
  })
})
