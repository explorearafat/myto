import { describe, it, expect } from 'vitest';
import {
  ALL_AGENTS,
  AGENT_COUNT,
  AGENT_CATEGORIES,
  findAgent,
  defaultAgent,
  searchAgents,
  listCategories,
  DEFAULT_RESEARCH_AGENT_ID,
} from '../../shared/agent-catalog';
import { buildAgentSystemPrompt, resolveResearchAgent, agentIdentityLine } from './persona';

describe('agent catalog', () => {
  it('ships 300+ agents', () => {
    expect(AGENT_COUNT).toBeGreaterThanOrEqual(300);
    expect(ALL_AGENTS).toHaveLength(AGENT_COUNT);
  });

  it('has unique agent ids and category ids', () => {
    const ids = ALL_AGENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cats = AGENT_CATEGORIES.map((c) => c.id);
    expect(new Set(cats).size).toBe(cats.length);
  });

  it('gives every agent a real professional profile', () => {
    for (const a of ALL_AGENTS) {
      expect(a.name.length).toBeGreaterThan(2);
      expect(a.tagline.length).toBeGreaterThan(5);
      expect(a.expertise.length).toBeGreaterThanOrEqual(3);
      expect(a.principles.length).toBeGreaterThanOrEqual(3);
      expect(a.categoryName.length).toBeGreaterThan(2);
    }
  });

  it('spans at least 15 professional categories', () => {
    expect(AGENT_CATEGORIES.length).toBeGreaterThanOrEqual(15);
    for (const c of listCategories()) expect(c.count).toBeGreaterThanOrEqual(8);
  });

  it('resolves the default agent', () => {
    expect(defaultAgent().id).toBe(DEFAULT_RESEARCH_AGENT_ID);
    expect(findAgent(DEFAULT_RESEARCH_AGENT_ID)).toBeDefined();
    expect(findAgent('does-not-exist')).toBeUndefined();
    expect(findAgent(undefined)).toBeUndefined();
  });

  it('finds the right specialist by search', () => {
    expect(searchAgents('frontend').some((a) => a.id === 'frontend-engineer')).toBe(true);
    expect(searchAgents('lawyer').some((a) => a.category === 'legal')).toBe(true);
    expect(searchAgents('online search').some((a) => a.id === 'online-researcher')).toBe(true);
    // A bare query returns the full list (capped), never empty.
    expect(searchAgents('').length).toBeGreaterThan(0);
    // A nonsense query returns nothing rather than everything.
    expect(searchAgents('zzznotarole').length).toBe(0);
  });
});

describe('agent persona builder', () => {
  it('composes a full professional prompt from the catalog entry', () => {
    const agent = findAgent('ip-lawyer')!;
    const prompt = buildAgentSystemPrompt(agent);
    expect(prompt).toContain(agent.name);
    expect(prompt).toContain(agent.tagline);
    expect(prompt).toContain(agent.expertise[0]);
    // The shared Research working contract is always appended.
    expect(prompt).toContain('Myto Research');
    expect(prompt.toLowerCase()).toContain('browser');
  });

  it('resolves to the default agent for a missing or unknown id', () => {
    expect(resolveResearchAgent(undefined).id).toBe(DEFAULT_RESEARCH_AGENT_ID);
    expect(resolveResearchAgent('nope').id).toBe(DEFAULT_RESEARCH_AGENT_ID);
    expect(resolveResearchAgent('frontend-engineer').id).toBe('frontend-engineer');
  });

  it('renders a one-line identity', () => {
    const line = agentIdentityLine(findAgent('data-scientist')!);
    expect(line).toContain('Data Scientist');
    expect(line).not.toContain('\n');
  });
});
