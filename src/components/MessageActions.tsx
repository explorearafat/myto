// The row of actions under a finished assistant reply, modeled on ChatGPT: copy the message, rate
// it up or down, regenerate it, or report it. Copy and regenerate do real work; the rating and
// report are client-side only (this is a preview chat with no feedback backend), so they simply
// acknowledge the input rather than pretend to send it anywhere.

import { useState } from 'react';
import { Check, Copy, Flag, RefreshCw, ThumbsDown, ThumbsUp } from 'lucide-react';
import { copyToClipboard } from '../lib/clipboard';

const BTN =
  'flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-150 hover:bg-[#f0eee6]';
const IDLE = 'text-[#9c988e] hover:text-[#141413]';
const ACTIVE = 'text-[#cf5535]';

export function MessageActions({
  text,
  onRegenerate,
}: {
  text: string;
  onRegenerate?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState<null | 'up' | 'down'>(null);
  const [reported, setReported] = useState(false);

  const copy = async () => {
    if (await copyToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  };

  return (
    <div className="mt-2 flex items-center gap-0.5">
      <button
        type="button"
        onClick={copy}
        className={BTN + ' ' + IDLE}
        title="Copy"
        aria-label={copied ? 'Copied' : 'Copy'}
      >
        {copied ? (
          <Check className="h-[15px] w-[15px] text-[#cf5535]" aria-hidden="true" />
        ) : (
          <Copy className="h-[15px] w-[15px]" aria-hidden="true" />
        )}
      </button>

      <button
        type="button"
        onClick={() => setVote((v) => (v === 'up' ? null : 'up'))}
        className={BTN + ' ' + (vote === 'up' ? ACTIVE : IDLE)}
        title="Good response"
        aria-label="Good response"
        aria-pressed={vote === 'up'}
      >
        <ThumbsUp className="h-[15px] w-[15px]" aria-hidden="true" />
      </button>

      <button
        type="button"
        onClick={() => setVote((v) => (v === 'down' ? null : 'down'))}
        className={BTN + ' ' + (vote === 'down' ? ACTIVE : IDLE)}
        title="Bad response"
        aria-label="Bad response"
        aria-pressed={vote === 'down'}
      >
        <ThumbsDown className="h-[15px] w-[15px]" aria-hidden="true" />
      </button>

      {onRegenerate ? (
        <button
          type="button"
          onClick={onRegenerate}
          className={BTN + ' ' + IDLE}
          title="Regenerate"
          aria-label="Regenerate"
        >
          <RefreshCw className="h-[15px] w-[15px]" aria-hidden="true" />
        </button>
      ) : null}

      <button
        type="button"
        onClick={() => setReported(true)}
        className={BTN + ' ' + (reported ? ACTIVE : IDLE)}
        title="Report"
        aria-label="Report"
        aria-pressed={reported}
      >
        <Flag className="h-[15px] w-[15px]" aria-hidden="true" />
      </button>

      {reported ? (
        <span className="ml-1.5 text-[12px] text-[#9c988e]">Thanks for the feedback</span>
      ) : null}
    </div>
  );
}
