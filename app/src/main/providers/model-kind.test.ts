import { describe, it, expect } from 'vitest'
import { detectModelKind, isMediaModel } from './model-kind'

describe('detectModelKind', () => {
  it('an explicit setting always wins over the id', () => {
    expect(detectModelKind('claude-opus-4-8', 'image')).toBe('image')
    expect(detectModelKind('dall-e-3', 'chat')).toBe('chat')
    expect(detectModelKind('sora', 'image')).toBe('image')
  })

  it('treats every ordinary chat model as chat (no false positives)', () => {
    for (const id of [
      'claude-opus-4-8',
      'claude-sonnet-5-5',
      'gpt-4o',
      'gpt-4o-mini',
      'o3',
      'llama3.1:8b',
      'deepseek-chat',
      'deepseek-reasoner',
      'mistral-large',
      'qwen2.5-coder',
      'gemini-2.5-pro',
    ]) {
      expect(detectModelKind(id), id).toBe('chat')
    }
  })

  it('detects image-generation models from the id', () => {
    for (const id of [
      'dall-e-3',
      'dalle3',
      'gpt-image-1',
      'stable-diffusion-3.5',
      'sdxl-turbo',
      'flux.1-dev',
      'imagen-3.0',
      'ideogram-v2',
      'recraft-v3',
    ]) {
      expect(detectModelKind(id), id).toBe('image')
    }
  })

  it('detects video-generation models from the id', () => {
    for (const id of ['sora', 'veo-3', 'runway-gen-3', 'kling-1.5', 'luma-dream-machine', 'hunyuan-video', 'ltx-video']) {
      expect(detectModelKind(id), id).toBe('video')
    }
  })

  it('prefers video when an id mentions both (image-to-video)', () => {
    expect(detectModelKind('image-to-video-01')).toBe('video')
  })

  it('handles empty / missing ids as chat', () => {
    expect(detectModelKind('')).toBe('chat')
    expect(detectModelKind(undefined)).toBe('chat')
    expect(detectModelKind(null)).toBe('chat')
  })

  it('is case-insensitive', () => {
    expect(detectModelKind('DALL-E-3')).toBe('image')
    expect(detectModelKind('Sora')).toBe('video')
  })

  it('isMediaModel is true only for image/video', () => {
    expect(isMediaModel('gpt-4o')).toBe(false)
    expect(isMediaModel('dall-e-3')).toBe(true)
    expect(isMediaModel('sora')).toBe(true)
    expect(isMediaModel('claude-opus-4-8', 'video')).toBe(true)
  })
})
