import { describe, it, expect } from 'vitest'
import { unsafeCommandReason } from './exec-guard'

// Step 3 (Gap A5): argument-level validation as defence-in-depth UNDER the exec
// permission tier. The guard must stop control-character injection without breaking
// the arbitrary build/test/scaffold commands Cowork legitimately runs.

describe('unsafeCommandReason — allows real Cowork commands', () => {
  it('allows a plain command', () => {
    expect(unsafeCommandReason('npm test')).toBeNull()
  })
  it('allows chained commands (&&, ;) and pipes', () => {
    expect(unsafeCommandReason('npm run build && npm test')).toBeNull()
    expect(unsafeCommandReason('npm run lint; npm run typecheck')).toBeNull()
    expect(unsafeCommandReason('cat package.json | grep version')).toBeNull()
  })
  it('allows quotes, subshells, globs and env/redirection metacharacters', () => {
    expect(unsafeCommandReason(`git commit -m "fix: it's working"`)).toBeNull()
    expect(unsafeCommandReason('echo $(date) > out.txt')).toBeNull()
    expect(unsafeCommandReason('rm -rf dist/*.map 2>/dev/null')).toBeNull()
    expect(unsafeCommandReason('VAR=1 python3 -c "print(1<2)"')).toBeNull()
  })
  it('allows a tab inside a command (the one legitimate control character)', () => {
    expect(unsafeCommandReason('grep -P "a\\tb" file')).toBeNull() // literal backslash-t, not a tab
    expect(unsafeCommandReason('echo "a\tb"')).toBeNull() // a real tab byte
  })
})

describe('unsafeCommandReason — blocks control-character injection', () => {
  it('refuses a NUL byte', () => {
    const reason = unsafeCommandReason('npm test\u0000; rm -rf /')
    expect(reason).toMatch(/NUL byte/i)
    expect(reason).toMatch(/single-line/i)
  })
  it('refuses an embedded newline (smuggled second command)', () => {
    expect(unsafeCommandReason('npm test\nrm -rf /')).toMatch(/newline/i)
  })
  it('refuses an embedded carriage return', () => {
    expect(unsafeCommandReason('npm test\rmalicious')).toMatch(/carriage return/i)
  })
  it('refuses a raw ESC / ANSI escape (Terminal-pane spoofing)', () => {
    expect(unsafeCommandReason('echo \u001b[2Jfake-prompt$ ')).toMatch(/escape/i)
  })
  it('reports the offending position so the model can fix it', () => {
    expect(unsafeCommandReason('ok\u0000')).toMatch(/position 2/)
  })
})
