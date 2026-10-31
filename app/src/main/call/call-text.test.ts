import { describe, expect, it } from 'vitest'

import {
  buildIceServers,
  describeResult,
  looksLikeTask,
  matchQuickCommand,
  yesNo
} from './call-text'
import { parseDcMessage } from './types'

describe('yesNo', () => {
  it('maps spoken affirmatives', () => {
    expect(yesNo('yes')).toBe('allow')
    expect(yesNo('yeah go ahead')).toBe('allow')
    expect(yesNo('OK')).toBe('allow')
  })
  it('maps spoken negatives', () => {
    expect(yesNo('no')).toBe('deny')
    expect(yesNo("nope don't")).toBe('deny')
    expect(yesNo('cancel')).toBe('deny')
  })
  it('returns null for anything else', () => {
    expect(yesNo('what about tuesday')).toBeNull()
    expect(yesNo('')).toBeNull()
  })
})

describe('matchQuickCommand', () => {
  it('maps common spoken commands to PowerShell', () => {
    expect(matchQuickCommand('Open PowerShell.')?.command).toBe('Start-Process pwsh')
    expect(matchQuickCommand('open vs code')?.command).toBe('Start-Process code')
    expect(matchQuickCommand('check my current directory')?.command).toContain('Get-Location')
    expect(matchQuickCommand('list the files')?.command).toBe('Get-ChildItem -Name')
    expect(matchQuickCommand('git status')?.command).toBe('git status')
    expect(matchQuickCommand('run npm install')?.command).toBe('npm install')
  })
  it('returns null for natural language that needs the agent', () => {
    expect(matchQuickCommand('fix all the build errors in my project')).toBeNull()
    expect(matchQuickCommand('what did we talk about yesterday')).toBeNull()
    expect(matchQuickCommand('navigate to my Myto project')).toBeNull()
  })
})

describe('looksLikeTask', () => {
  it('detects project-task requests', () => {
    expect(looksLikeTask('Open my Sylor project and finish the authentication system')).toBe(true)
    expect(looksLikeTask('fix all build errors in my current project')).toBe(true)
    expect(looksLikeTask('create the required API endpoints')).toBe(true)
  })
  it('does not flag short questions', () => {
    expect(looksLikeTask('what time is it')).toBe(false)
    expect(looksLikeTask('add it')).toBe(false)
    expect(looksLikeTask('run the tests')).toBe(false)
  })
})

describe('describeResult', () => {
  it('announces success with a short first line', () => {
    expect(describeResult(0, 'C:\\work\\myto', false)).toContain('Done.')
  })
  it('reports failures with the first error line', () => {
    expect(describeResult(1, 'ERR! missing script', false)).toContain('failed')
  })
  it('reports timeouts', () => {
    expect(describeResult(null, '', true)).toContain('timed out')
  })
})

describe('buildIceServers', () => {
  it('keeps stun urls and drops a half-filled TURN (no dead peer)', () => {
    const servers = buildIceServers({
      urls: ['stun:stun.l.google.com:19302', 'turn:relay.example:3478'],
      username: 'user',
      credential: ''
    })
    expect(servers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }])
  })

  it('keeps TURN only when BOTH username and credential are present', () => {
    const servers = buildIceServers({
      urls: ['stun:stun.l.google.com:19302', 'turn:relay.example:3478', 'turns:relay.example:5349?transport=tcp'],
      username: ' user ',
      credential: 'secret'
    })
    expect(servers).toEqual([
      { urls: ['stun:stun.l.google.com:19302'] },
      {
        urls: ['turn:relay.example:3478', 'turns:relay.example:5349?transport=tcp'],
        username: 'user',
        credential: 'secret'
      }
    ])
  })

  it('falls back to Google STUN when the config is empty', () => {
    expect(buildIceServers({ urls: [], username: '', credential: '' })).toEqual([])
    const onlyTurn = buildIceServers({ urls: ['turn:relay.example:3478'], username: '', credential: '' })
    expect(onlyTurn).toEqual([])
  })
})

describe('parseDcMessage', () => {
  it('parses well-formed messages', () => {
    expect(parseDcMessage('{"t":"ping","ts":123}')).toEqual({ t: 'ping', ts: 123 })
  })
  it('rejects garbage', () => {
    expect(parseDcMessage('not json')).toBeNull()
    expect(parseDcMessage('{"noType":1}')).toBeNull()
  })
})
