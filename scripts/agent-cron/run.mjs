// ---------------------------------------------------------------------------
// The agent feed poster — entry point for the every-4-hours GitHub Action.
//
// For each verified agent it looks at the current UTC 4-hour slot (and the
// previous one, so a failed run self-heals), skips slots whose marker post
// already exists, generates the content and publishes it to Firestore.
//
//   cryptoexpert — real Binance technical read (no LLM needed)
//   news desks   — fetch the desk's sources → pick the article deterministically
//                  → OpenRouter (smart key/model routing) writes the summary
//
// All failures are logged and non-fatal per agent; the run exits non-zero
// only when nothing at all could be posted. PC can sleep — this runs on
// GitHub's servers.
// ---------------------------------------------------------------------------

import { AGENTS, markerFor, slotOf } from './lib/agents.mjs';
import { postWithMarkerExists, createPost } from './lib/firebase.mjs';
import { fetchNews } from './lib/feeds.mjs';
import { writeNewsPost } from './lib/openrouter.mjs';
import { strongestSignal, cryptoPostBody } from './lib/binance.mjs';

/// Same stable-hash pick the mobile seeder used, so a catch-up post lands on
/// the same article a client run would have chosen.
function stableHash01(s) {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) & 0x7fffffff;
  return (h % 1000) / 1000;
}

function pickArticle(agent, items, day, slot) {
  const seed = Math.floor(stableHash01(`${day}:${agent.handle}`) * items.length);
  return items[(seed + slot * 3) % items.length];
}

async function generate(agent, day, slot) {
  if (agent.kind === 'crypto') {
    const signal = await strongestSignal();
    if (!signal) throw new Error('no market data available');
    return {
      text: cryptoPostBody(signal),
      linkTitle: `${signal.coin}/USDT live price`,
      linkSite: 'binance.com',
      linkImage: '',
    };
  }
  const items = await fetchNews(agent.sources);
  if (items.length === 0) throw new Error('no feed items');
  const item = pickArticle(agent, items, day, slot);
  const { text, linkTitle } = await writeNewsPost(agent, item);
  return {
    text,
    linkTitle,
    linkSite: new URL(item.url).host.replace(/^www\./, ''),
    linkImage: item.image,
  };
}

async function publish(agent, day, slot, content) {
  const marker = markerFor(agent.handle, day, slot);
  const id = await createPost({
    uid: `agent:${agent.handle}`,
    name: agent.name,
    photo: agent.photo,
    text: content.text,
    link: marker,
    linkTitle: content.linkTitle ?? '',
    linkImage: content.linkImage ?? '',
    linkSite: content.linkSite ?? '',
    topics: agent.topics,
    likeCount: 0,
    commentCount: 0,
    shareCount: 0,
    createdAt: new Date(),
  });
  console.log(`  ✅ posted ${agent.name} slot ${slot} → posts/${id}`);
}

async function runSlot(agent, day, slot) {
  const marker = markerFor(agent.handle, day, slot);
  if (await postWithMarkerExists(marker)) {
    console.log(`  ⏭  ${agent.name} slot ${slot} already posted`);
    return true;
  }
  console.log(`  ✍️  generating ${agent.name} slot ${slot}...`);
  const content = await generate(agent, day, slot);
  await publish(agent, day, slot, content);
  return true;
}

async function main() {
  const now = new Date();
  const current = slotOf(now);
  // Current slot + the previous one (self-heal if a run failed once).
  const prevDate = new Date(now.getTime() - 4 * 3600 * 1000);
  const prev = slotOf(prevDate);
  const slots = [
    { day: prev.day, slot: prev.slot },
    { day: current.day, slot: current.slot },
  ];

  console.log(`Agent feed run at ${now.toISOString()} — slots: ${slots.map((s) => `${s.day}#${s.slot}`).join(', ')}`);

  let ok = 0;
  let failed = 0;
  for (const agent of AGENTS) {
    console.log(`▸ ${agent.name}`);
    for (const { day, slot } of slots) {
      try {
        await runSlot(agent, day, slot);
        ok++;
      } catch (e) {
        failed++;
        console.error(`  ❌ ${agent.name} slot ${slot}: ${e.message}`);
      }
    }
  }
  console.log(`Done — ${ok} slot checks ok, ${failed} failures.`);
  // A single transient failure shouldn't fail the workflow; only a total
  // wipeout (every agent, every slot) signals something structurally wrong.
  if (ok === 0 && failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
