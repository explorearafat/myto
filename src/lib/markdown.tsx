// A tiny, dependency-free Markdown renderer that parses to React nodes — never to HTML. There is
// no dangerouslySetInnerHTML anywhere here, so untrusted model output cannot inject markup; the
// worst a model can do is produce plain text. It covers the subset a chat reply actually uses:
// fenced and inline code, bold, italics, links (http/https/mailto/relative only), and unordered
// and ordered lists, with blank-line paragraph breaks.

import { useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { copyToClipboard } from './clipboard';

const SAFE_HREF = /^(https?:\/\/|mailto:|\/)/i;

// Split a line into inline nodes: `code`, **bold**, _italic_ / *italic*, and [text](href).
function inline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: code first (so ** inside code stays literal), then links, then emphasis.
  const pattern =
    /(`[^`]+`)|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (tok.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-[#f0eee6] px-1.5 py-0.5 font-mono text-[0.85em] text-[#141413]"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('[')) {
      const cut = tok.indexOf('](');
      const label = tok.slice(1, cut);
      const href = tok.slice(cut + 2, -1);
      if (SAFE_HREF.test(href)) {
        const external = /^https?:/i.test(href);
        nodes.push(
          <a
            key={key}
            href={href}
            target={external ? '_blank' : undefined}
            rel={external ? 'noopener noreferrer' : undefined}
            className="text-[#141413] underline underline-offset-2 hover:text-[#2b2a27]"
          >
            {label}
          </a>,
        );
      } else {
        nodes.push(label);
      }
    } else if (tok.startsWith('**') || tok.startsWith('__')) {
      nodes.push(
        <strong key={key} className="font-semibold text-[#141413]">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(<em key={key}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

type Block =
  | { kind: 'p'; lines: string[] }
  | { kind: 'h'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'code'; lang?: string; lines: string[] };

function parse(text: string): Block[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim() || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence
      blocks.push({ kind: 'code', lang, lines: body });
      continue;
    }

    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'h', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ul', items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push({ kind: 'ol', items });
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s{0,3}#{1,6}\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      para.push(lines[i]);
      i++;
    }
    blocks.push({ kind: 'p', lines: para });
  }
  return blocks;
}

/**
 * A fenced code block, ChatGPT-style: a header strip naming the language with a Copy button on the
 * right, over the code body. The button copies the raw code and flips to a confirmation for a beat.
 */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await copyToClipboard(code)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };
  return (
    <div className="overflow-hidden rounded-lg border border-[#e4e1d8]">
      <div className="flex items-center justify-between border-b border-[#e4e1d8] bg-[#f0eee6] py-1.5 pl-3 pr-2">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[#9c988e]">
          {lang || 'code'}
        </span>
        <button
          type="button"
          onClick={onCopy}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors duration-150 hover:bg-[#e7e3d9] hover:text-[#141413]"
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-[#141413]" aria-hidden="true" />
          ) : (
            <Copy className="h-3.5 w-3.5 text-[#6b675e]" aria-hidden="true" />
          )}
          <span className={copied ? 'text-[#141413]' : 'text-[#6b675e]'}>
            {copied ? 'Copied' : 'Copy'}
          </span>
        </button>
      </div>
      <pre className="overflow-x-auto bg-[#f7f5ef] p-3 font-mono text-[13px] leading-relaxed text-[#141413]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = parse(text);
  return (
    <div className="space-y-3 text-[15px] leading-relaxed text-[#141413]">
      {blocks.map((b, bi) => {
        if (b.kind === 'code') {
          // Wrapped in a keyed element rather than keying <CodeBlock> directly: this project has no
          // @types/react, so custom components don't get the implicit `key` prop that intrinsic
          // elements do.
          return (
            <div key={bi}>
              <CodeBlock code={b.lines.join('\n')} lang={b.lang} />
            </div>
          );
        }
        if (b.kind === 'h') {
          const size = b.level <= 1 ? 'text-[17px]' : b.level === 2 ? 'text-[15px]' : 'text-[14px]';
          const Tag = (b.level <= 1 ? 'h3' : b.level === 2 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5';
          return (
            <Tag key={bi} className={`mt-1 font-semibold leading-snug text-[#141413] ${size}`}>
              {inline(b.text, `${bi}`)}
            </Tag>
          );
        }
        if (b.kind === 'ul') {
          return (
            <ul key={bi} className="space-y-1.5">
              {b.items.map((it, ii) => (
                <li key={ii} className="flex gap-2.5 text-[14px] text-[#544f46]">
                  <span
                    className="mt-[0.5em] h-1 w-1 shrink-0 rounded-full bg-[#141413]"
                    aria-hidden="true"
                  />
                  <span>{inline(it, `${bi}-${ii}`)}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (b.kind === 'ol') {
          return (
            <ol key={bi} className="space-y-1.5">
              {b.items.map((it, ii) => (
                <li key={ii} className="flex gap-2.5 text-[14px] text-[#544f46]">
                  <span className="shrink-0 font-medium text-[#141413]">{ii + 1}.</span>
                  <span>{inline(it, `${bi}-${ii}`)}</span>
                </li>
              ))}
            </ol>
          );
        }
        return (
          <p key={bi}>{inline(b.lines.join(' '), `${bi}`)}</p>
        );
      })}
    </div>
  );
}
