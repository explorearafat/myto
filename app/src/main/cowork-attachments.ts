import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { listAttachmentsBySession } from './db/attachments'
import { resolveInWorkspace } from './tools/fs'
import type { Attachment } from '../shared/types'

/**
 * Bridge uploaded attachments into the Cowork working folder.
 *
 * The problem this solves: a user attaches a file (a PDF, a CSV, an image) and asks
 * the Cowork agent to work with it — but the bytes live under
 * `userData/attachments/<sessionId>/…`, which the filesystem tools deliberately
 * CANNOT see (they are sandboxed to the working folder via {@link resolveInWorkspace}).
 * So the agent would look for the file, fail to find it, and give up ("I couldn't
 * find the uploaded PDF"). Vision images reach the model inline, but every other
 * kind — and even an image the agent needs to process rather than look at — was
 * unreachable.
 *
 * The fix: at the start of a Cowork turn, copy THIS turn's attachments into an
 * `uploads/` subfolder of the working folder and tell the model their paths, so it
 * opens them directly with `read_file` (or runs code over them) instead of hunting.
 */

/** Subfolder of the working folder that this-turn attachments are copied into. */
const UPLOADS_DIR = 'uploads'

/** One attachment now sitting inside the working folder, with its relative path. */
export interface MaterializedAttachment {
  /** Original (already-sanitized) file name. */
  name: string
  /** Path relative to the working folder (forward-slashed) — what the model uses. */
  rel: string
  mime: string
  size: number
}

/**
 * Copy the given attachments into `<workspace>/uploads/` and return the ones now
 * available there, each with its workspace-relative path. Does only filesystem work
 * (no DB access), so it is unit-testable against a temp dir. Never clobbers an
 * existing file: the `uploads/` namespace keeps it clear of the user's own tree, and
 * skip-if-exists makes a repeated upload of the same name a no-op rather than an
 * overwrite. An attachment whose source bytes are gone, or whose name somehow
 * escapes the sandbox, is dropped from the result rather than failing the whole turn.
 */
export async function materializeAttachmentFiles(
  atts: Attachment[],
  workspaceDir: string
): Promise<MaterializedAttachment[]> {
  const out: MaterializedAttachment[] = []
  for (const a of atts) {
    const rel = `${UPLOADS_DIR}/${a.name}`
    const dest = resolveInWorkspace(workspaceDir, rel)
    if (!dest) continue // a name that somehow climbs out of the sandbox — skip it
    try {
      await mkdir(dirname(dest), { recursive: true })
      const exists = await stat(dest).then(
        () => true,
        () => false
      )
      if (!exists) await copyFile(a.path, dest)
      out.push({ name: a.name, rel, mime: a.mime, size: a.size })
    } catch {
      // Source missing/unreadable or the copy failed — omit this one; a bad
      // attachment must never sink the reply.
    }
  }
  return out
}

/**
 * Find THIS turn's attachments for a Cowork session and copy them into the working
 * folder. "This turn's" = rows already bound to the sending user message
 * (`messageId === afterMsgId`) plus any still-pending rows (`messageId === null`)
 * whose bind IPC hasn't landed yet — both belong to the turn being sent, because
 * `send()` binds every staged composer attachment to this user message (a fire-and-
 * forget update that can race this read). Prior turns' uploads keep their own
 * message ids and are excluded (they already sit in `uploads/` from when they were
 * sent). Best-effort: returns `[]` when there are none, or on any DB error — an
 * attachment hiccup must never block the reply.
 */
export async function materializeAttachments(
  sessionId: string,
  afterMsgId: string | null,
  workspaceDir: string
): Promise<MaterializedAttachment[]> {
  let mine: Attachment[]
  try {
    const all = listAttachmentsBySession(sessionId)
    mine = all.filter((a) => a.messageId === afterMsgId || a.messageId === null)
  } catch {
    return []
  }
  if (mine.length === 0) return []
  return materializeAttachmentFiles(mine, workspaceDir)
}
