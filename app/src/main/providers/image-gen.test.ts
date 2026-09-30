import { describe, it, expect } from 'vitest'
import { parseMediaResponse, sniffImageMimeFromBase64, imagesUrl, videosUrl } from './image-gen'

// 1x1 PNG (base64) — used to check mime sniffing and passthrough.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

describe('parseMediaResponse', () => {
  it('parses the OpenAI images shape {data:[{b64_json}]}', () => {
    const out = parseMediaResponse({ created: 1, data: [{ b64_json: PNG_1x1 }] }, 'image', 'a cat')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'image', mediaType: 'image/png', dataBase64: PNG_1x1, prompt: 'a cat' })
    expect(out[0].url).toBeUndefined()
  })

  it('parses a URL result {data:[{url}]}', () => {
    const out = parseMediaResponse({ data: [{ url: 'https://cdn.example.com/pic.jpg' }] }, 'image')
    expect(out[0]).toMatchObject({ kind: 'image', mediaType: 'image/jpeg', url: 'https://cdn.example.com/pic.jpg' })
    expect(out[0].dataBase64).toBeUndefined()
  })

  it('parses multiple images', () => {
    const out = parseMediaResponse({ data: [{ b64_json: PNG_1x1 }, { url: 'https://x/y.webp' }] }, 'image')
    expect(out).toHaveLength(2)
    expect(out[1].mediaType).toBe('image/webp')
  })

  it('parses a bare {images:[...]} of strings (url + data-url)', () => {
    const out = parseMediaResponse(
      { images: ['https://x/a.png', `data:image/jpeg;base64,${PNG_1x1}`] },
      'image'
    )
    expect(out).toHaveLength(2)
    expect(out[0].url).toBe('https://x/a.png')
    expect(out[1]).toMatchObject({ dataBase64: PNG_1x1, mediaType: 'image/jpeg' })
  })

  it('parses stability-style {artifacts:[{base64}]}', () => {
    const out = parseMediaResponse({ artifacts: [{ base64: PNG_1x1 }] }, 'image')
    expect(out[0].dataBase64).toBe(PNG_1x1)
  })

  it('parses a video url from {output:[url]}', () => {
    const out = parseMediaResponse({ output: ['https://x/clip.mp4'] }, 'video')
    expect(out[0]).toMatchObject({ kind: 'video', mediaType: 'video/mp4', url: 'https://x/clip.mp4' })
  })

  it('defaults video mime to mp4 for inline bytes', () => {
    const out = parseMediaResponse({ data: [{ b64_json: 'AAAA' }] }, 'video')
    expect(out[0].mediaType).toBe('video/mp4')
  })

  it('parses a single top-level object with b64_json', () => {
    const out = parseMediaResponse({ b64_json: PNG_1x1 }, 'image')
    expect(out[0].dataBase64).toBe(PNG_1x1)
  })

  it('parses a JSON string body', () => {
    const out = parseMediaResponse(JSON.stringify({ data: [{ url: 'https://x/y.png' }] }), 'image')
    expect(out[0].url).toBe('https://x/y.png')
  })

  it('parses a bare url string', () => {
    const out = parseMediaResponse('https://x/y.png', 'image')
    expect(out[0].url).toBe('https://x/y.png')
  })

  it('returns [] for an unusable / empty body', () => {
    expect(parseMediaResponse({}, 'image')).toEqual([])
    expect(parseMediaResponse(null, 'image')).toEqual([])
    expect(parseMediaResponse({ data: [] }, 'image')).toEqual([])
    expect(parseMediaResponse({ data: [{}] }, 'image')).toEqual([])
  })
})

describe('sniffImageMimeFromBase64', () => {
  it('recognises common formats', () => {
    expect(sniffImageMimeFromBase64(PNG_1x1)).toBe('image/png')
    expect(sniffImageMimeFromBase64('/9j/4AAQSkZJRg')).toBe('image/jpeg')
    expect(sniffImageMimeFromBase64('R0lGODdh')).toBe('image/gif')
    expect(sniffImageMimeFromBase64('UklGRhoAAAB')).toBe('image/webp')
  })
  it('defaults unknown to png', () => {
    expect(sniffImageMimeFromBase64('ZZZZ')).toBe('image/png')
  })
})

describe('endpoint URLs', () => {
  it('derives the images endpoint from a /v1 base', () => {
    expect(imagesUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/images/generations')
    expect(imagesUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1/images/generations')
  })
  it('strips a chat/messages suffix before appending', () => {
    expect(imagesUrl('https://api.example.com/v1/chat/completions')).toBe('https://api.example.com/v1/images/generations')
    expect(imagesUrl('https://api.example.com/v1/messages')).toBe('https://api.example.com/v1/images/generations')
  })
  it('derives the videos endpoint', () => {
    expect(videosUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/videos/generations')
  })
})
