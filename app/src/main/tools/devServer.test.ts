import { describe, it, expect } from 'vitest'
import { detectUrl } from './devServer'

/**
 * `detectUrl` is the pure heart of run_dev_server: it scans streamed dev-server
 * output for the first local http(s) URL and normalises it so the preview pane can
 * load it. Everything else in the tool is process/IPC side-effects; this is the part
 * worth unit-testing.
 */
describe('detectUrl', () => {
  it('returns null before any URL is printed', () => {
    expect(detectUrl('')).toBeNull()
    expect(detectUrl('VITE v5.0.0  ready in 300 ms\n\n  starting...')).toBeNull()
  })

  it('finds a Vite localhost URL with a port', () => {
    const out = '  ➜  Local:   http://localhost:5173/\n  ➜  Network: use --host to expose'
    expect(detectUrl(out)).toBe('http://localhost:5173/')
  })

  it('maps 127.0.0.1 to localhost', () => {
    expect(detectUrl('Server running at http://127.0.0.1:3000/')).toBe('http://localhost:3000/')
  })

  it('maps 0.0.0.0 to localhost', () => {
    expect(detectUrl('Listening on http://0.0.0.0:8080')).toBe('http://localhost:8080/')
  })

  it('maps the IPv6 loopback [::1] to localhost', () => {
    expect(detectUrl('http://[::1]:4321/app')).toBe('http://localhost:4321/app')
  })

  it('prefers a local URL over an earlier public one', () => {
    const out = 'docs at https://vitejs.dev\n  ➜  Local: http://localhost:5173/'
    expect(detectUrl(out)).toBe('http://localhost:5173/')
  })

  it('ignores non-local hosts entirely', () => {
    expect(detectUrl('deployed to https://example.com/ and https://myapp.vercel.app')).toBeNull()
  })

  it('strips ANSI colour codes Vite wraps the URL in', () => {
    const out = '  \x1b[32m➜\x1b[39m  Local: \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m'
    expect(detectUrl(out)).toBe('http://localhost:5173/')
  })

  it('keeps the path when one is present', () => {
    expect(detectUrl('open http://localhost:8000/index.html')).toBe('http://localhost:8000/index.html')
  })

  it('defaults the path to / when none is given', () => {
    expect(detectUrl('http://localhost:3000')).toBe('http://localhost:3000/')
  })

  it('preserves https', () => {
    expect(detectUrl('https://localhost:8443/')).toBe('https://localhost:8443/')
  })
})
