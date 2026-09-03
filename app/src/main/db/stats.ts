import type { UsageFacts } from '../../shared/types'
import { getDb } from './db'

/**
 * Activity aggregates for the zero-state dashboard, read straight out of SQLite.
 *
 * This module only *reads* — it does no calendar maths. It hands
 * {@link UsageFacts} to the pure `computeUsageStats` in `shared/usage.ts`, which
 * owns the day/streak/grid logic so all of it is testable without a database.
 * Everything is one pass of aggregate queries over local tables, cheap enough to
 * run on every New Chat with no cache.
 */

/** ~4 characters per token — the same rough heuristic the composer's context
 *  indicator uses. Applied in SQL as `(LENGTH(x) + 3) / 4` (integer ceil). */
const CHARS_PER_TOKEN = 4

/** Read every figure the dashboard needs. Throws only on a genuine DB fault. */
export function readUsageFacts(): UsageFacts {
  const db = getDb()

  // "Sessions" means conversations, so an empty draft row (created but never
  // sent) is not counted — it would inflate the headline number with rows the
  // user never sees in history.
  const sessions = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sessions s
       WHERE EXISTS (SELECT 1 FROM messages m WHERE m.session_id = s.id)`
    )
    .get() as { n: number }

  const messages = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get() as { n: number }

  // Token estimate over everything that crossed the model: both sides of the
  // conversation plus the tool traffic (a proposal the model wrote, and the
  // result fed back to it — file reads and command output dominate real usage,
  // so leaving them out would understate the figure badly). Summed in SQL to
  // avoid pulling every message body into JS.
  const c = CHARS_PER_TOKEN
  const tokens = db
    .prepare(
      `SELECT
         (SELECT COALESCE(SUM((LENGTH(content) + ${c - 1}) / ${c}), 0) FROM messages)
       + (SELECT COALESCE(
             SUM((LENGTH(proposal_json) + LENGTH(COALESCE(result_json, '')) + ${c - 1}) / ${c}),
             0)
           FROM tool_ops)
         AS n`
    )
    .get() as { n: number }

  // One timestamp per message. Rows written before the column existed fall back
  // to their session's creation time, so pre-upgrade history still lands on the
  // calendar (all on one day per session, which is honest — it's all we know).
  const stamps = db
    .prepare(
      `SELECT COALESCE(m.created_at, s.created_at) AS ts
       FROM messages m JOIN sessions s ON s.id = m.session_id
       ORDER BY ts`
    )
    .all() as Array<{ ts: number }>

  const models = db
    .prepare(
      `SELECT model, COUNT(*) AS n FROM messages
       WHERE role = 'assistant' AND model IS NOT NULL AND TRIM(model) <> ''
       GROUP BY model
       ORDER BY n DESC, model ASC`
    )
    .all() as Array<{ model: string; n: number }>

  return {
    sessions: sessions.n,
    messages: messages.n,
    tokens: tokens.n,
    timestamps: stamps.map((r) => r.ts),
    models: models.map((r) => ({ model: r.model, count: r.n }))
  }
}
