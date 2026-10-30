import { describe, expect, it } from 'vitest'

import {
  fromFirestoreFields,
  toFirestoreValue,
  fromFirestoreValue,
  uidFromToken
} from './firestore-rest'

describe('Firestore REST value codec', () => {
  it('round-trips scalars', () => {
    const doc = { s: 'hello', n: 42, f: 1.5, b: true, z: null }
    const fields = Object.fromEntries(
      Object.entries(doc).map(([k, v]) => [k, toFirestoreValue(v)])
    )
    expect(fromFirestoreFields(fields)).toEqual(doc)
  })

  it('round-trips nested maps and arrays', () => {
    const doc = { turn: { urls: ['turn:a:80', 'turn:b:443'], username: 'u' }, list: [1, 'x'] }
    const fields = Object.fromEntries(
      Object.entries(doc).map(([k, v]) => [k, toFirestoreValue(v)])
    )
    expect(fromFirestoreFields(fields)).toEqual(doc)
  })

  it('decodes missing values as null', () => {
    expect(fromFirestoreValue(undefined)).toBeNull()
  })
})

describe('uidFromToken', () => {
  it('extracts the uid from a JWT payload', () => {
    const payload = Buffer.from(JSON.stringify({ user_id: 'abc123', sub: 'abc123' })).toString('base64url')
    expect(uidFromToken(`header.${payload}.sig`)).toBe('abc123')
  })
  it('returns null for garbage', () => {
    expect(uidFromToken('not-a-token')).toBeNull()
  })
})
