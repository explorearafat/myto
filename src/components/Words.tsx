import { Fragment } from 'react';

interface WordsProps {
  text: string;
  /** Milliseconds between one word landing and the next. */
  step?: number;
  /** Delay before the first word, for lines that follow another reveal. */
  base?: number;
}

/**
 * Splits a line into words that fade up one after another once the parent
 * scrolls into view. The parent carries `data-reveal="words"`, which opts it out
 * of the block-level reveal so the two effects never stack.
 *
 * Only used on headings — a page of word-split body copy would mean thousands of
 * spans for no gain.
 */
export function Words({ text, step = 45, base = 0 }: WordsProps) {
  const words = text.split(' ');
  return (
    <>
      {words.map((word, i) => (
        <Fragment key={`${word}-${i}`}>
          <span className="reveal-word" style={{ transitionDelay: `${base + i * step}ms` }}>
            {word}
          </span>
          {i < words.length - 1 ? ' ' : null}
        </Fragment>
      ))}
    </>
  );
}
