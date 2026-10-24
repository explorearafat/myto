import { describe, expect, it } from 'vitest';
import { absoluteUrl, parseOgMeta } from './link-preview';

describe('absoluteUrl', () => {
  it('resolves relative image paths against the page URL', () => {
    expect(absoluteUrl('https://example.com/a/b', '/img/og.png')).toBe('https://example.com/img/og.png');
    expect(absoluteUrl('https://example.com/a/b', 'cover.jpg')).toBe('https://example.com/a/cover.jpg');
    expect(absoluteUrl('https://example.com', 'https://cdn.example.com/x.png')).toBe(
      'https://cdn.example.com/x.png'
    );
  });

  it('rejects junk and non-http schemes', () => {
    expect(absoluteUrl('https://example.com', '')).toBe('');
    expect(absoluteUrl('https://example.com', '   ')).toBe('');
    expect(absoluteUrl('https://example.com', 'javascript:alert(1)')).toBe('');
    expect(absoluteUrl('https://example.com', 'data:image/png;base64,x')).toBe('');
  });
});

describe('parseOgMeta', () => {
  it('extracts og:title, og:image and og:site_name', () => {
    const html = `
      <html><head>
        <meta property="og:title" content="The Future of AI Agents">
        <meta property="og:image" content="https://example.com/cover.png">
        <meta property="og:site_name" content="Example News">
      </head></html>`;
    expect(parseOgMeta(html, 'https://example.com/post')).toEqual({
      title: 'The Future of AI Agents',
      image: 'https://example.com/cover.png',
      site: 'Example News',
    });
  });

  it('tolerates name= attributes, single quotes and reversed attribute order', () => {
    const html = `<meta content='Quoted Title' name='twitter:title'><META NAME="og:image" CONTENT='/x y.png'>`;
    const meta = parseOgMeta(html, 'https://example.com');
    expect(meta?.title).toBe('Quoted Title');
    expect(meta?.image).toBe('https://example.com/x%20y.png');
    expect(meta?.site).toBe('example.com');
  });

  it('falls back to <title> and decodes entities', () => {
    const html = '<title>Myto &amp; the Art of Code — blog</title>';
    const meta = parseOgMeta(html, 'https://blog.example.org');
    expect(meta?.title).toBe('Myto & the Art of Code — blog');
    expect(meta?.image).toBe('');
    expect(meta?.site).toBe('blog.example.org');
  });

  it('returns null when nothing usable exists', () => {
    expect(parseOgMeta('<html><body>plain</body></html>', 'https://example.com')).toBeNull();
  });

  it('drops html tags that leak into og:title', () => {
    const meta = parseOgMeta('<meta property="og:title" content="<b>Bold</b> title">', 'https://e.com');
    expect(meta?.title).toBe('Bold title');
  });
});
