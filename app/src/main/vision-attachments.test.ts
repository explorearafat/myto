import { describe, it, expect } from 'vitest'
import { isVisionImage, toVisionImages, MAX_VISION_BYTES } from './vision-attachments'
import type { Attachment } from '../shared/types'

/** Build an Attachment fixture; only mime/path/size matter to the code under test. */
function att(over: Partial<Attachment>): Attachment {
  return {
    id: 'a1',
    sessionId: 's1',
    messageId: null,
    name: 'f',
    mime: 'image/png',
    path: '/disk/f',
    size: 10,
    createdAt: 0,
    ...over
  }
}

describe('isVisionImage', () => {
  it('accepts raster image mimes, case-insensitively and trimmed', () => {
    for (const m of ['image/png', 'IMAGE/JPEG', 'image/jpg', ' image/gif ', 'image/webp', 'image/bmp']) {
      expect(isVisionImage(m)).toBe(true)
    }
  })
  it('rejects svg and non-images', () => {
    for (const m of ['image/svg+xml', 'application/pdf', 'text/plain', 'application/json', '']) {
      expect(isVisionImage(m)).toBe(false)
    }
  })
})

describe('toVisionImages', () => {
  const read = async (path: string): Promise<Buffer> => Buffer.from(`bytes:${path}`)

  it('maps image attachments to base64 ChatImages, lowercasing the mime, preserving order', async () => {
    const out = await toVisionImages(
      [att({ path: '/a', mime: 'IMAGE/PNG' }), att({ path: '/b', mime: 'image/jpeg' })],
      read
    )
    expect(out).toEqual([
      { mediaType: 'image/png', dataBase64: Buffer.from('bytes:/a').toString('base64') },
      { mediaType: 'image/jpeg', dataBase64: Buffer.from('bytes:/b').toString('base64') }
    ])
  })

  it('drops non-image attachments', async () => {
    const out = await toVisionImages([att({ mime: 'application/pdf' }), att({ mime: 'text/csv' })], read)
    expect(out).toEqual([])
  })

  it('skips images larger than the cap but keeps the rest', async () => {
    const out = await toVisionImages(
      [att({ path: '/big', size: MAX_VISION_BYTES + 1 }), att({ path: '/ok', size: 5 })],
      read
    )
    expect(out.map((i) => i.dataBase64)).toEqual([Buffer.from('bytes:/ok').toString('base64')])
  })

  it('skips an unreadable image without failing the batch', async () => {
    const flaky = async (p: string): Promise<Buffer> => {
      if (p === '/bad') throw new Error('ENOENT')
      return Buffer.from(`bytes:${p}`)
    }
    const out = await toVisionImages([att({ path: '/bad' }), att({ path: '/good' })], flaky)
    expect(out).toEqual([
      { mediaType: 'image/png', dataBase64: Buffer.from('bytes:/good').toString('base64') }
    ])
  })

  it('returns [] for no attachments', async () => {
    expect(await toVisionImages([], read)).toEqual([])
  })
})
