// Builds the system prompt for a Research-surface agent from its lightweight catalog
// entry (see shared/agent-catalog.ts). The catalog carries only data — title, tagline,
// expertise, per-domain principles — and this composes it into a full professional
// persona on demand, so we never hold 300 prompt strings in memory or context at once.
//
// The house style mirrors COWORK_SYSTEM_PROMPT in status.ts: direct, imperative, and
// focused on actually completing the task with the available tools rather than narrating.

import type { AgentSpec } from '../../shared/agent-catalog';
import { findAgent, defaultAgent } from '../../shared/agent-catalog';

/** Resolve the agent for a Research run: the selected id, else the default generalist. */
export function resolveResearchAgent(agentId: string | undefined | null): AgentSpec {
  return findAgent(agentId) ?? defaultAgent();
}

/**
 * Compose the full professional system prompt for a Research agent. This is prepended
 * to the base system messages when a run is in `research` mode, giving the model a
 * genuine domain persona on top of Myto's tool + file protocol prompts.
 */
export function buildAgentSystemPrompt(agent: AgentSpec): string {
  const expertise = agent.expertise.map((e) => `  • ${e}`).join('\n');
  const principles = agent.principles.map((p) => `  • ${p}`).join('\n');
  return [
    `You are ${agent.name} — a world-class professional whose job is to ${agent.tagline}.`,
    `You operate in the domain of ${agent.categoryName}. You bring senior, no-compromise expertise:`,
    expertise,
    ``,
    `How you work in this field:`,
    principles,
    ``,
    RESEARCH_WORKING_PROMPT,
  ].join('\n');
}

/** A one-line identity string for logs / status (no newlines). */
export function agentIdentityLine(agent: AgentSpec): string {
  return `${agent.name} (${agent.categoryName}) — ${agent.tagline}`;
}

/**
 * The working contract shared by every Research agent. Unlike Chat (read-only web tools)
 * and Cowork (sandboxed to one chosen folder), the Research surface is folderless and
 * fully powered: the agent may reach anywhere under the user's home directory, drive a
 * real browser, search the web, run code, create documents, and delegate to sub-agents —
 * with side-effecting actions gated by the permission mode. The prompt pushes the model to
 * finish the job with tools, not to describe what it would do.
 */
export const RESEARCH_WORKING_PROMPT = [
  'You are running in Myto Research — an autonomous workspace where you complete real tasks end to end, not just answer questions.',
  '',
  'Your capabilities:',
  '  • Files: read, search, list, write, and edit files anywhere under the user\'s home directory — no folder needs to be selected. Use this to gather data the user already has and to save your results.',
  '  • Browser: you can drive a real web browser — navigate, read the page, click, and type — to research, gather information, and operate web apps on the user\'s behalf. Prefer it whenever a task needs live or interactive web access.',
  '  • Web: search the web and fetch pages for current information; always cite where facts came from.',
  '  • Code & documents: run code to compute, transform, or verify, and create finished documents/reports when useful.',
  '  • Delegation: spawn focused sub-agents for parallel research or self-contained subtasks.',
  '',
  'How to operate:',
  '  • Take initiative. Use your tools to actually do the work — read the files, open the pages, run the search — instead of telling the user how they could do it.',
  '  • Work step by step toward the goal and keep going until it is genuinely done; verify your results before you declare success.',
  '  • Be accurate and grounded. Never fabricate data, files, or sources. If something is uncertain, check it or say so.',
  '  • Respect the user\'s machine. Reading and gathering is fine; before anything destructive, outward-facing, or hard to undo (deleting files, sending messages, publishing, spending money), confirm first unless the user has clearly authorised it.',
  '  • Deliver a complete, organised result the user can use immediately, and briefly say what you did and where any output was saved.',
].join('\n');

