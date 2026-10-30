import { describe, expect, it } from 'vitest'

import { classifyCommand, needsApproval, resolveCallCwd } from './call-executor'

describe('classifyCommand', () => {
  it('recognizes read-only operations', () => {
    expect(classifyCommand('Get-Location')).toBe('read_only')
    expect(classifyCommand('Get-ChildItem -Name')).toBe('read_only')
    expect(classifyCommand('git status')).toBe('read_only')
    expect(classifyCommand('git diff main')).toBe('read_only')
    expect(classifyCommand('npm ls')).toBe('read_only')
    expect(classifyCommand('node --version')).toBe('read_only')
    expect(classifyCommand('ls')).toBe('read_only')
  })

  it('recognizes normal development operations', () => {
    expect(classifyCommand('npm run build')).toBe('dev')
    expect(classifyCommand('npm install')).toBe('dev')
    expect(classifyCommand('git add .')).toBe('dev')
    expect(classifyCommand('git commit -m "x"')).toBe('dev')
    expect(classifyCommand('npm test')).toBe('dev')
    expect(classifyCommand('Start-Process pwsh')).toBe('dev')
    expect(classifyCommand('totally-unknown-command --flag')).toBe('dev')
  })

  it('escalates destructive operations', () => {
    expect(classifyCommand('Remove-Item -Recurse C:\\data')).toBe('destructive')
    expect(classifyCommand('rm -rf node_modules')).toBe('destructive')
    expect(classifyCommand('git reset --hard')).toBe('destructive')
    expect(classifyCommand('git push --force origin main')).toBe('destructive')
    expect(classifyCommand('git clean -fd')).toBe('destructive')
  })

  it('escalates elevation and admin operations', () => {
    expect(classifyCommand('sudo apt install x')).toBe('elevated')
    expect(classifyCommand('Set-ExecutionPolicy RemoteSigned')).toBe('elevated')
    expect(classifyCommand('shutdown /r')).toBe('elevated')
    expect(classifyCommand('npm install -g typescript')).toBe('elevated')
  })

  it('treats credential access as destructive', () => {
    expect(classifyCommand('Get-Credential')).toBe('destructive')
    expect(classifyCommand('echo $env:MYTO_API_KEY')).toBe('destructive')
    expect(classifyCommand('cmdkey /list')).toBe('destructive')
  })
})

describe('needsApproval', () => {
  it('always asks for destructive and elevated tiers', () => {
    expect(needsApproval('destructive', 'autoDev')).toBe(true)
    expect(needsApproval('elevated', 'autoDev')).toBe(true)
    expect(needsApproval('destructive', 'autoReadOnly')).toBe(true)
  })

  it('gates dev commands on the ask tier only', () => {
    expect(needsApproval('dev', 'ask')).toBe(true)
    expect(needsApproval('dev', 'autoReadOnly')).toBe(false)
    expect(needsApproval('dev', 'autoDev')).toBe(false)
  })

  it('never gates read-only commands', () => {
    expect(needsApproval('read_only', 'ask')).toBe(false)
  })
})

describe('resolveCallCwd', () => {
  it('uses the workspace when set', () => {
    expect(resolveCallCwd('C:\\work', 'C:\\home')).toBe('C:\\work')
  })
  it('falls back when the workspace is blank', () => {
    expect(resolveCallCwd('  ', 'C:\\home')).toBe('C:\\home')
  })
})
