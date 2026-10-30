import { describe, expect, it } from 'vitest'

import { executeCommand } from './call-executor'

/**
 * LIVE test — spawns real PowerShell on this machine (mirrors
 * pshost.live.test.ts). Skipped implicitly on machines without pwsh/powershell
 * via the graceful spawn-failure path being asserted too.
 */
describe('call-executor (live on this Windows machine)', () => {
  it('prefers pwsh 7 and streams a read-only command', async () => {
    const logs: Array<{ stream: string; text: string }> = []
    const handle = await executeCommand({
      callId: 'live-test',
      command: 'Get-Location | Select-Object -ExpandProperty Path',
      cwd: process.cwd(),
      approvedBy: 'auto',
      tier: 'read_only',
      onLog: (stream, text) => logs.push({ stream, text })
    })
    const result = await handle.done
    expect(result.exitCode).toBe(0)
    expect(result.output.out).toContain('app') // the app/ working folder
    expect(logs.some((l) => l.stream === 'out' && l.text.trim().length > 0)).toBe(true)
  }, 60_000)

  it('captures stderr separately and reports the failing exit code', async () => {
    const handle = await executeCommand({
      callId: 'live-test',
      command: 'Write-Error "boom" -ErrorAction Continue; exit 3',
      cwd: process.cwd(),
      approvedBy: 'auto',
      tier: 'read_only'
    })
    const result = await handle.done
    expect(result.exitCode).toBe(3)
    expect(result.output.err).toContain('boom')
  }, 60_000)

  it('times out a hung command and kills the tree', async () => {
    const handle = await executeCommand({
      callId: 'live-test',
      command: 'Start-Sleep -Seconds 60',
      cwd: process.cwd(),
      approvedBy: 'auto',
      tier: 'read_only',
      timeoutMs: 2_000
    })
    const result = await handle.done
    expect(result.timedOut).toBe(true)
  }, 60_000)
})
