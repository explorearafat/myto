// Renders one tool round-trip (the call the model made + the result the gateway fed back) as a
// compact card in the web transcript. The gateway writes both as fenced blocks in the reply text;
// src/lib/toolBlocks.ts coalesces them into the ToolSegment this renders. Presentational only.

import { useState } from 'react';
import { ChevronDown, Search, Globe, BookOpen, Wrench } from 'lucide-react';
import type { ToolSegment } from '../lib/toolBlocks';

function toolLabel(name: string | null): string {
  switch (name) {
    case 'web_search':
      return 'Web search';
    case 'web_fetch':
      return 'Fetch page';
    case 'wiki_search':
      return 'Wikipedia';
    default:
      return name ?? 'Tool';
  }
}

function ToolIcon({ name }: { name: string | null }) {
  const cls = 'h-3.5 w-3.5 text-[#6b675e]';
  if (name === 'web_search') return <Search className={cls} aria-hidden="true" />;
  if (name === 'wiki_search') return <BookOpen className={cls} aria-hidden="true" />;
  if (name === 'web_fetch') return <Globe className={cls} aria-hidden="true" />;
  return <Wrench className={cls} aria-hidden="true" />;
}

function formatInput(input: unknown): string {
  if (input === undefined) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export function ToolCard({ tool }: { tool: ToolSegment }) {
  const [expanded, setExpanded] = useState(false);
  const running = tool.result === null;
  const phase = running ? (tool.complete ? 'Running…' : 'Preparing…') : tool.complete ? null : 'Running…';
  const inputText = formatInput(tool.input);

  return (
    <div className="overflow-hidden rounded-lg border border-[#e4e1d8] bg-[#faf9f5]">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <ToolIcon name={tool.name} />
        <span className="text-[12.5px] font-medium text-[#141413]">{toolLabel(tool.name)}</span>
        {phase ? (
          <span className="text-[11px] font-medium text-[#141413]">{phase}</span>
        ) : (
          <span className="rounded bg-[#f0eee6] px-1.5 py-0.5 font-mono text-[9px] font-medium uppercase tracking-[0.08em] text-[#9c988e]">
            done
          </span>
        )}
        <span className="flex-1" />
        <ChevronDown
          className={'h-3.5 w-3.5 text-[#9c988e] transition-transform ' + (expanded ? 'rotate-180' : '')}
          aria-hidden="true"
        />
      </button>

      {expanded ? (
        <div className="border-t border-[#e4e1d8]">
          {inputText ? (
            <div className="px-3 py-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[#9c988e]">Request</div>
              <pre className="overflow-x-auto rounded bg-[#f7f5ef] p-2.5 font-mono text-[12px] leading-relaxed text-[#141413]">
                <code>{inputText}</code>
              </pre>
            </div>
          ) : null}
          {tool.result !== null ? (
            <div className="px-3 pb-2.5 pt-1">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[#9c988e]">Result</div>
              <pre className="max-h-72 overflow-auto rounded bg-[#f7f5ef] p-2.5 font-mono text-[12px] leading-relaxed text-[#141413]">
                <code>{tool.result}</code>
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
