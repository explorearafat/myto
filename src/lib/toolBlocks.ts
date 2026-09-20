// Splits an assistant reply into prose runs and tool cards. The gateway writes tool use into the
// reply as two adjacent fenced blocks — a `sylor:tool` call and a `sylor:tool_result <name>` result
// (see src/server/tools.ts) — which this coalesces into one ToolSegment so the transcript can render
// a card while everything else stays ordinary Markdown. Pure; no React here.

export interface ProseSegment {
  kind: 'prose';
  text: string;
}

export interface ToolSegment {
  kind: 'tool';
  /** Tool name from the call (or the result's info line as a fallback), or null. */
  name: string | null;
  /** Parsed `input` from the call; the raw body if the JSON was malformed; undefined for result-only. */
  input: unknown;
  /** The result text, or null while only the call has streamed in (card shows "Running…"). */
  result: string | null;
  /** False while the most recent block's closing fence hasn't arrived yet. */
  complete: boolean;
}

export type ToolBlockSegment = ProseSegment | ToolSegment;

const FENCE = /^(`{3,})[ \t]*(.*)$/;

function parseToolInfo(info: string): { kind: 'call' } | { kind: 'result'; name: string | null } | null {
  const trimmed = info.trim();
  if (trimmed === 'sylor:tool') return { kind: 'call' };
  if (trimmed === 'sylor:tool_result' || trimmed.startsWith('sylor:tool_result ')) {
    const name = trimmed.slice('sylor:tool_result'.length).trim();
    return { kind: 'result', name: name || null };
  }
  return null;
}

function parseCallBody(body: string): { name: string | null; input: unknown } {
  const trimmed = body.trim();
  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const name = typeof obj.tool === 'string' && obj.tool.trim() ? obj.tool.trim() : null;
      return { name, input: 'input' in obj ? obj.input : undefined };
    }
  } catch {
    /* keep the raw text so the card can still show something */
  }
  return { name: null, input: trimmed || undefined };
}

/**
 * Parse `md` into ordered prose + tool segments. A reply with no tool blocks yields a single prose
 * segment (today's behaviour). Streaming-aware: an unclosed block is flagged incomplete.
 */
export function parseToolBlocks(md: string): ToolBlockSegment[] {
  const lines = md.split('\n');
  const segments: ToolBlockSegment[] = [];
  let prose: string[] = [];

  const flushProse = (): void => {
    const text = prose.join('\n');
    if (text.trim() !== '') segments.push({ kind: 'prose', text });
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    const open = FENCE.exec(lines[i]);
    const tool = open ? parseToolInfo(open[2]) : null;
    if (!open || !tool) {
      prose.push(lines[i]);
      i++;
      continue;
    }

    const fence = open[1];
    const body: string[] = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const close = /^(`{3,})[ \t]*$/.exec(lines[j]);
      if (close && close[1].length >= fence.length) {
        closed = true;
        break;
      }
      body.push(lines[j]);
    }

    flushProse();
    const bodyText = body.join('\n');
    if (tool.kind === 'call') {
      const { name, input } = parseCallBody(bodyText);
      segments.push({ kind: 'tool', name, input, result: null, complete: closed });
    } else {
      const last = segments[segments.length - 1];
      if (last && last.kind === 'tool' && last.result === null) {
        last.result = bodyText;
        last.complete = closed;
        if (!last.name) last.name = tool.name;
      } else {
        segments.push({ kind: 'tool', name: tool.name, input: undefined, result: bodyText, complete: closed });
      }
    }
    i = closed ? j + 1 : j;
  }

  flushProse();
  return segments;
}

/** True when a reply contains any tool block (so callers can skip the segment path otherwise). */
export function hasToolBlocks(md: string): boolean {
  return md.includes('```sylor:tool');
}
