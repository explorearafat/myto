// ---------------------------------------------------------------------------
// Purge every post the verified agents ever published (and their likes,
// comments, shares subcollections). Runs on the Admin identity, so it works
// regardless of which uid authored the posts.
//
//   node scripts/agent-cron/purge.mjs            # delete + summary
//   node scripts/agent-cron/purge.mjs --dry      # list only
//
// Triggered on demand via the agent-feed workflow (workflow_dispatch: mode=purge).
// ---------------------------------------------------------------------------

import { AGENTS } from './lib/agents.mjs';
import { findAgentPosts, deleteDocument } from './lib/firebase.mjs';

async function main() {
  const dry = process.argv.includes('--dry');
  const names = AGENTS.map((a) => a.name);
  const posts = await findAgentPosts(names);
  console.log(`${posts.length} agent posts found${dry ? ' (dry run)' : ''}.`);

  let deleted = 0;
  for (const doc of posts) {
    const text = doc.data?.fields?.text?.stringValue ?? '';
    const preview = text.slice(0, 70).replace(/\n/g, ' ');
    if (dry) {
      console.log(`  · ${doc.name.split('/').pop()} — ${preview}`);
      continue;
    }
    try {
      await deleteDocument(doc.name);
      deleted++;
      console.log(`  🗑  deleted ${doc.name.split('/').pop()} — ${preview}`);
    } catch (e) {
      console.error(`  ❌ ${doc.name}: ${e.message}`);
    }
  }
  console.log(`Purged ${deleted}/${posts.length} agent posts.`);
  process.exit(deleted === posts.length ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
