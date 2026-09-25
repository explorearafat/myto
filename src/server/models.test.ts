import { describe, it, expect } from 'vitest';
import { pickWebAdapter, openAiWebAdapter, anthropicWebAdapter } from './adapters';

// Focused unit coverage for the model-listing surface the /models proxy (handleModels) delegates to.
// Pure adapter methods, mirroring adapters.test.ts — no fetch, no I/O.

describe('openAiWebAdapter model listing', () => {
  const a = openAiWebAdapter;

  it('builds the OpenAI /models URL', () => {
    expect(a.modelsUrl('https://api.example.com/v1')).toBe('https://api.example.com/v1/models');
  });

  it('parses ids from an OpenAI-shaped { data: [{ id }] } body', () => {
    expect(a.parseModels({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }] })).toEqual([
      'gpt-4o',
      'gpt-4o-mini',
    ]);
  });

  it('trims ids and drops blank/non-string/missing entries', () => {
    expect(a.parseModels({ data: [{ id: '  m-1  ' }, { id: '' }, { id: 7 }, {}, null] })).toEqual([
      'm-1',
    ]);
  });

  it('returns [] for a non-array or missing data field', () => {
    expect(a.parseModels({ data: 'nope' })).toEqual([]);
    expect(a.parseModels({})).toEqual([]);
    expect(a.parseModels(null)).toEqual([]);
  });
});

describe('anthropicWebAdapter model listing', () => {
  const a = anthropicWebAdapter;

  it('builds the Anthropic /v1/models URL without doubling /v1', () => {
    expect(a.modelsUrl('https://api.anthropic.com')).toBe('https://api.anthropic.com/v1/models');
    expect(a.modelsUrl('https://api.anthropic.com/v1')).toBe('https://api.anthropic.com/v1/models');
  });

  it('parses ids from Anthropic’s { data: [{ id }] } body', () => {
    expect(
      a.parseModels({ data: [{ id: 'claude-3-5-sonnet' }, { id: 'claude-3-5-haiku' }] }),
    ).toEqual(['claude-3-5-sonnet', 'claude-3-5-haiku']);
  });
});

describe('pickWebAdapter drives modelsUrl to the right shape', () => {
  it('uses /models for OpenAI hosts and /v1/models for Anthropic', () => {
    expect(pickWebAdapter('https://api.openai.com/v1').modelsUrl('https://api.openai.com/v1')).toBe(
      'https://api.openai.com/v1/models',
    );
    expect(
      pickWebAdapter('https://api.anthropic.com').modelsUrl('https://api.anthropic.com'),
    ).toBe('https://api.anthropic.com/v1/models');
  });
});
