import { describe, it, expect } from 'vitest'
import { SmtpClient, buildDataPayload, encodeSubject, type SmtpSocket, type SmtpConfig, type MailMessage } from './mail'

/** A scripted fake server: each `read()` returns the next reply; writes are logged. */
function fakeServer(script: string[]): { socket: SmtpSocket; writes: string[] } {
  const writes: string[] = []
  let i = 0
  const socket: SmtpSocket = {
    write: (d) => {
      writes.push(d)
    },
    read: async () => script[i++] ?? '500 out of script\r\n',
    destroy: () => {}
  }
  return { socket, writes }
}

const cfg: SmtpConfig = { host: 'smtp.test', port: 465, secure: true, user: 'me@test.dev', pass: 'secret' }
const msg: MailMessage = { to: 'you@test.dev', subject: 'Ki khobor ভাই', body: 'Line one\nLine two' }

describe('buildDataPayload', () => {
  it('encodes the subject as an RFC 2047 word for non-ASCII', () => {
    const payload = buildDataPayload(msg, 'me@test.dev', '<id@myto>')
    expect(payload).toContain('Subject: =?utf-8?B?')
    expect(payload).toContain('From: me@test.dev')
    expect(payload).toContain('To: you@test.dev')
  })
  it('sends the body base64 and ends with a dot-terminated line', () => {
    const payload = buildDataPayload(msg, 'me@test.dev', '<id@myto>')
    expect(payload).toContain('Content-Transfer-Encoding: base64')
    expect(payload.trimEnd().endsWith('.')).toBe(true)
    const b64 = Buffer.from('Line one\nLine two', 'utf8').toString('base64')
    expect(payload).toContain(b64)
  })
  it('carries a dot-leading body safely: base64 never emits raw SMTP dots', () => {
    const payload = buildDataPayload({ ...msg, body: '.hidden\nok' }, 'me@test.dev', '<id>')
    // The body travels base64 (no '.' in that alphabet), so the payload's only
    // terminating dot is the DATA end marker — no stuffing ambiguity at all.
    expect(payload).not.toMatch(/^\.hidden/m)
    expect(payload).toContain(Buffer.from('.hidden\nok', 'utf8').toString('base64'))
  })
  it('keeps an ASCII subject verbatim', () => {
    expect(encodeSubject('hello')).toBe('hello')
  })
})

describe('SmtpClient (scripted server)', () => {
  it('walks the full happy path and reports the queued receipt', async () => {
    const { socket, writes } = fakeServer([
      '220 smtp.test ESMTP\r\n',
      '250-smtp.test greets you\r\n250 AUTH LOGIN\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '235 2.7.0 accepted\r\n',
      '250 OK\r\n',
      '250 OK\r\n',
      '354 go ahead\r\n',
      '250 2.0.0 Queued as ABC123\r\n'
    ])
    const client = new SmtpClient({ connect: async () => socket, now: () => new Date(0), randomId: () => 'abc' })
    const result = await client.send(cfg, msg)
    expect(result.ok).toBe(true)
    expect(result.messageId).toContain('@myto')
    expect(result.transcript).toContain('Queued as ABC123')
    expect(writes[0]).toBe('EHLO myto-assistant\r\n')
    expect(writes.join('')).toContain(`MAIL FROM:<me@test.dev>`)
    expect(writes.join('')).toContain(`RCPT TO:<you@test.dev>`)
    expect(writes.join('')).toContain('AUTH LOGIN')
    expect(writes.join('')).toContain(Buffer.from('me@test.dev', 'utf8').toString('base64'))
  })

  it('refuses honestly when the server rejects the recipient', async () => {
    const { socket } = fakeServer([
      '220 ready\r\n',
      '250 ok\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '235 ok\r\n',
      '250 ok\r\n',
      '550 5.1.1 bad recipient\r\n'
    ])
    const client = new SmtpClient({ connect: async () => socket, now: () => new Date(0), randomId: () => 'x' })
    const result = await client.send(cfg, msg)
    expect(result.ok).toBe(false)
    expect(result.transcript).toContain('550 5.1.1 bad recipient')
  })

  it('fails clearly on wrong credentials', async () => {
    const { socket } = fakeServer(['220 ready\r\n', '250 ok\r\n', '334 VXNlcm5hbWU6\r\n', '334 UGFzc3dvcmQ6\r\n', '535 5.7.8 wrong pass\r\n'])
    const client = new SmtpClient({ connect: async () => socket, now: () => new Date(0), randomId: () => 'x' })
    const result = await client.send(cfg, msg)
    expect(result.ok).toBe(false)
    expect(result.transcript).toContain('535 5.7.8')
  })
})
