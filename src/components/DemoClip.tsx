import { useEffect, useState } from 'react';

/* An auto-playing product clip, drawn entirely in CSS — no video file, no
   loading spinner, crisp at every size. It cycles the four workflow beats on a
   loop, which reads as a video clip of the agent at work. */
const BEATS = [
  { label: 'Describing the task', text: 'Add dark mode to the settings page', tag: 'PROMPT' },
  { label: 'Planning the work', text: 'Plan: tokens, toggle, save — 4 steps', tag: 'PLAN' },
  { label: 'Writing the diff', text: '+ .dark { color-scheme: dark }', tag: 'DIFF' },
  { label: 'Verifying the build', text: '✓ tests 24 passed — done', tag: 'VERIFY' },
];

const BEAT_MS = 2200;

export function DemoClip() {
  const [beat, setBeat] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setBeat((b) => (b + 1) % BEATS.length), BEAT_MS);
    return () => window.clearInterval(timer);
  }, []);

  const current = BEATS[beat];

  return (
    <div className="w-full max-w-[420px] overflow-hidden rounded-xl border border-[#d9d5ca] bg-[#1a1917] shadow-[0_40px_90px_-40px_rgba(20,20,19,0.5)]">
      <div className="flex items-center gap-1.5 border-b border-[#2d2b27] bg-[#232119] px-3.5 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-[#4a463d]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#4a463d]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[#4a463d]" />
        <span className="ml-2 text-[11px] text-[#8a857a]">Myto — live</span>
        <span className="ml-auto flex gap-0.5">
          {BEATS.map((_, i) => (
            <span
              key={i}
              className={
                'h-1 w-4 rounded-full transition-colors duration-300 ' +
                (i === beat ? 'bg-[#e8e5dd]' : 'bg-[#3a362e]')
              }
            />
          ))}
        </span>
      </div>
      <div className="p-5 text-left">
        <p className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-[#8a857a]">{current.tag}</p>
        <p key={beat} className="chat-in mt-2.5 font-mono text-[14px] leading-relaxed text-[#e8e5dd]">
          {current.text}
        </p>
        <div className="mt-4 flex items-center gap-2 text-[11.5px] text-[#8a857a]">
          <span className="thinking-dot" />
          {current.label}…
        </div>
      </div>
    </div>
  );
}
