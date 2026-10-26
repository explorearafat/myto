import { describe, it, expect, afterAll } from 'vitest'
import { PsHost } from './pshost'
import { Computer, toSendKeys } from './computer'

/**
 * LIVE on Windows: the resident host is real — spawn a powershell, warm it,
 * and assert warm round-trips land inside the 0.5s action budget. Skipped on
 * other platforms (the host itself is a no-op there).
 */
;(describe.skipIf(process.platform !== 'win32'))('PsHost (live on this Windows machine)', () => {
  const host = new PsHost({ timeoutMs: 8000 })
  afterAll(() => host.kill())

  it('spawns, warms up, and answers a trivial round-trip', async () => {
    await host.start()
    expect(host.isWarm).toBe(true)
    const r = await host.run("Write-Output 'RESULT:pong'")
    expect(r.ok).toBe(true)
    expect(r.out).toContain('pong')
    expect(r.ms).toBeLessThan(500)
  })

  it('keeps warm round-trips well under the 0.5s budget', async () => {
    const samples: number[] = []
    for (let i = 0; i < 6; i++) {
      const r = await host.run('Write-Output (2+2)')
      expect(r.out).toContain('4')
      samples.push(r.ms)
    }
    const worst = Math.max(...samples)
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length
    // Report honestly; assert the budget with headroom for CI noise.
    expect(worst).toBeLessThan(500)
    // eslint-disable-next-line no-console
    console.log(`[pshost latency] avg ${avg.toFixed(0)}ms · worst ${worst}ms (budget 500ms)`)
  })

  it('runs actions through the Computer surface', async () => {
    const computer = new Computer(host)
    const active = await computer.activeWindow()
    expect(active.ok).toBe(true)
    const clip = await computer.clipboardSet('myto-assistant-check')
    expect(clip.ok).toBe(true)
    const got = await computer.clipboardGet()
    expect(got.ok).toBe(true)
    expect(got.data ?? got.detail).toContain('myto-assistant-check')
  })

  it('serialises concurrent actions without crossing their outputs', async () => {
    const [a, b] = await Promise.all([
      host.run("Start-Sleep -Milliseconds 120; Write-Output 'RESULT:first'"),
      host.run("Write-Output 'RESULT:second'")
    ])
    expect(a.out).toContain('first')
    expect(b.out).toContain('second')
  })
})

;(describe.skipIf(process.platform !== 'win32'))('Computer key mapping sanity (live SendKeys path)', () => {
  it('builds the SendKeys string for a real combo without sending it', () => {
    expect(toSendKeys('ctrl+shift+end')).toBe('(^+{END})')
  })
})
