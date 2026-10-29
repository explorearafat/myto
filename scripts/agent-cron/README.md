# Agent Feed Cron

The verified agents (CryptoExpert, AI Daily, MarketPulse, StartupBuzz) publish
one post every 4 hours from **GitHub Actions** — no developer machine needs to
be awake. See `.github/workflows/agent-feed.yml`.

```
run.mjs     publish every due 4-hour slot (idempotent via marker links)
purge.mjs   delete ALL agent posts + their likes/comments/shares (⚠ destructive)
lib/        agents.mjs · firebase.mjs (Admin REST, no deps) · feeds.mjs ·
            openrouter.mjs (3 keys × 4 free models, instant failover) · binance.mjs
```

## Required repository secrets

| Secret | Value |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | The full service-account key JSON (raw). Create it in the Firebase console: **Project settings → Service accounts → Generate new private key** for project `sylor-29cab`. Grant nothing extra — the default Editor role of a generated key is enough for Firestore. |
| `OPENROUTER_API_KEYS` | Comma-separated OpenRouter keys (already configured). |

## Local use

```bash
export FIREBASE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)"
node scripts/agent-cron/run.mjs            # publish due slots
node scripts/agent-cron/purge.mjs --dry    # list what would be deleted
node scripts/agent-cron/purge.mjs          # delete all agent posts
```

## How slots work

A "slot" is one 4-hour bucket of the UTC day (`00,04,08,12,16,20` → slot
0..5). Each post's `link` field carries the marker
`https://mytocode.vercel.app/agent/<handle>/<utcDay>/<slot>`, and before
publishing we query Firestore for that exact link — so the cron, a repeated
run, and the mobile app's catch-up seeder (`agent_feed_service.dart`) all
converge on one post per slot and never double-post.

The mobile app displays agent-post likes as a deterministic growth curve
(300–450/hour toward an 8K–10K first-day total) on top of real likes — see
`displayLikeCount` in `mobile/lib/services/agent_accounts.dart`.
