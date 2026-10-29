// ---------------------------------------------------------------------------
// OpenRouter post writer with smart routing.
//
// The roster's summaries are written by free models on OpenRouter. Three API
// keys and four free models are configured; routing walks a (key, model)
// matrix so a failing key OR a failing/rate-limited model instantly falls
// through to the next pair — the post still goes out on the first attempt
// that succeeds.
//
// Keys come from OPENROUTER_API_KEYS (comma-separated). They live only in
// the environment (GitHub secret / local export) — never in source.
// ---------------------------------------------------------------------------

const BASE_URL = 'https://openrouter.ai/api/v1';

export const MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'nvidia/nemotron-3.5-lightning:free',
  'google/gemma-4-26b-a4b-it:free',
];

function keys() {
  const raw = process.env.OPENROUTER_API_KEYS ?? '';
  const list = raw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error('OPENROUTER_API_KEYS is not set');
  return list;
}

/// The attempt order: every key paired with every model, key rotating fastest
/// so a dead key costs one attempt per model, not the whole matrix. A rotating
/// start index spreads usage across keys across runs.
function attempts() {
  const ks = keys();
  const start = (globalThis.__orAttempt ?? 0) % ks.length;
  globalThis.__orAttempt = ((globalThis.__orAttempt ?? 0) + 1) % ks.length;
  const order = [];
  for (let m = 0; m < MODELS.length; m++) {
    for (let k = 0; k < ks.length; k++) {
      order.push({ key: ks[(start + k) % ks.length], model: MODELS[m] });
    }
  }
  return order;
}

async function chatOnce(key, model, messages, timeoutMs = 60000) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      // Optional attribution headers; harmless without an OpenRouter site.
      'http-referer': 'https://mytocode.vercel.app',
      'x-title': 'Myto Agent Feed',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 700,
      temperature: 0.8,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 200);
    throw new Error(`${model}: HTTP ${res.status} ${body}`);
  }
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') throw new Error(`${model}: empty completion`);
  return text;
}

/// Try the routing matrix until one (key, model) pair produces a completion.
/// Returns { text, model }. Throws only when EVERY pair fails.
export async function chat(messages) {
  const list = attempts();
  const errors = [];
  for (const { key, model } of list) {
    const keyTag = `...${key.slice(-6)}`;
    try {
      const text = await chatOnce(key, model, messages);
      console.log(`  [openrouter] ok via ${model} / key ${keyTag}`);
      return { text, model };
    } catch (e) {
      errors.push(e.message);
      console.warn(`  [openrouter] fail ${model} / key ${keyTag} — ${e.message.slice(0, 120)}`);
    }
  }
  throw new Error(`All ${list.length} OpenRouter key×model pairs failed:\n${errors.join('\n')}`);
}

/// Pull the first balanced JSON object out of a model reply (models like to
/// wrap JSON in prose or code fences despite instructions).
export function extractJson(text) {
  const start = text.indexOf('{');
  if (start === -1) throw new Error('no JSON object in model reply');
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === '\\') {
      escape = true;
      continue;
    }
    if (c === '"') inString = !inString;
    if (inString) continue;
    if (c === '{') depth++;
    if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error('unbalanced JSON in model reply');
}

/// Generate the feed post body for one news item. Returns
/// { text, linkTitle } — text is the post (≤480 chars), linkTitle is the
/// headline for the link chip.
export async function writeNewsPost(agent, item) {
  const messages = [
    {
      role: 'system',
      content:
        `You are ${agent.name}, ${agent.persona} You write for the Myto social feed in a professional, ` +
        'credible newsroom voice — no hype, no emoji spam, no hashtags, no markdown. ' +
        'Respond with ONLY a JSON object, no code fences: {"text": "...", "linkTitle": "..."}. ' +
        'Rules for "text": start with a sharp one-line headline; blank line; 2-3 sentence summary ' +
        'of what happened and why it matters; end with one line starting "Why it matters:" or ' +
        '"Watch for:". Max 480 characters total. Rules for "linkTitle": the article title, max 120 chars.',
    },
    {
      role: 'user',
      content:
        'Write today\'s post about this article:\n\n' +
        `TITLE: ${item.title}\n` +
        `SUMMARY: ${item.summary || '(no summary available — work from the title)'}\n` +
        `URL: ${item.url}`,
    },
  ];
  for (let round = 0; round < 2; round++) {
    const { text } = await chat(messages);
    try {
      const parsed = extractJson(text);
      const post = String(parsed.text ?? '').trim();
      if (post.length < 40) throw new Error('post too short');
      return {
        text: post.slice(0, 500),
        linkTitle: String(parsed.linkTitle ?? item.title).slice(0, 200),
      };
    } catch (e) {
      console.warn(`  [openrouter] unparsable reply (round ${round + 1}): ${e.message}`);
      messages.push({ role: 'assistant', content: text.slice(0, 400) });
      messages.push({
        role: 'user',
        content: 'That was not valid JSON. Reply again with ONLY the JSON object {"text","linkTitle"}.',
      });
    }
  }
  throw new Error('model never produced parsable JSON');
}
