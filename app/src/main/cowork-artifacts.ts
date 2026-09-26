/**
 * Deliverable-validity checks for Cowork (Track-1 #4). Pure, dependency-light byte
 * inspection: given a file's path (for its declared type) and its raw bytes, decide
 * whether it is a *real* file of that type — a valid OOXML package (xlsx/pptx/docx),
 * a PDF, or a zip — rather than an empty stub or a script's error output saved under
 * that name. This exists because the weak BYOK models Cowork runs will cheerfully
 * report "created report.xlsx" after the generating script errored and wrote its
 * traceback (or nothing) into the file. Kept out of provider-ipc.ts and the fs tool
 * so it is unit-testable in isolation — same reason as cowork-guards.ts /
 * cowork-runtimes.ts.
 */

export type ArtifactKind = 'xlsx' | 'pptx' | 'docx' | 'pdf' | 'zip' | 'unknown'

export interface ArtifactCheck {
  /** True only when the bytes are a genuine file of the path's declared type. */
  ok: boolean
  /** The type inferred from the path's extension. */
  kind: ArtifactKind
  /** One line for the model: why it passed, or exactly what is wrong. */
  detail: string
}

/** The declared type of a deliverable, from its file extension. */
export function kindFromPath(path: string): ArtifactKind {
  const m = /\.([a-z0-9]+)\s*$/i.exec(path)
  switch ((m ? m[1] : '').toLowerCase()) {
    case 'xlsx':
      return 'xlsx'
    case 'pptx':
      return 'pptx'
    case 'docx':
      return 'docx'
    case 'pdf':
      return 'pdf'
    case 'zip':
      return 'zip'
    default:
      return 'unknown'
  }
}

/** First index of a raw byte sequence in a buffer, or -1. */
function indexOfBytes(buf: Uint8Array, needle: readonly number[], from = 0): number {
  const n = needle.length
  if (n === 0) return Math.max(0, from)
  const last = buf.length - n
  for (let i = Math.max(0, from); i <= last; i++) {
    let j = 0
    while (j < n && buf[i + j] === needle[j]) j++
    if (j === n) return i
  }
  return -1
}

/** ASCII substring search over raw bytes (the part names inside a zip are ASCII). */
function indexOfAscii(buf: Uint8Array, needle: string, from = 0): number {
  return indexOfBytes(buf, Array.from(needle, (c) => c.charCodeAt(0) & 0xff), from)
}

/** Does the buffer contain this ASCII string anywhere? */
function has(buf: Uint8Array, needle: string): boolean {
  return indexOfAscii(buf, needle) !== -1
}

/** Do the first bytes match this signature? */
function startsWith(buf: Uint8Array, sig: readonly number[]): boolean {
  if (buf.length < sig.length) return false
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false
  return true
}

/** A rough human size, for the "valid" note. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

// Text a failed generating step tends to leave in the file instead of the artifact —
// a Python traceback, a missing-module error, or the Windows Store python stub piped
// into the output. Detecting these lets verify_file say *why* it isn't a real file.
const ERROR_MARKERS = [
  'Traceback (most recent call last)',
  'ModuleNotFoundError',
  'SyntaxError',
  'was not found', // Windows Store python alias stub
  'is not recognized',
  'command not found'
]

/**
 * If the head of the file is mostly printable text carrying a known error marker,
 * return that marker — a strong signal the generating step failed and saved its
 * output here. Returns null for binary content (a real OOXML/PDF file).
 */
function errorTextMarker(buf: Uint8Array): string | null {
  const head = buf.subarray(0, Math.min(buf.length, 400))
  if (head.length === 0) return null
  let printable = 0
  for (const b of head) if (b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127)) printable++
  if (printable / head.length < 0.85) return null
  const text = String.fromCharCode(...head)
  for (const marker of ERROR_MARKERS) if (text.includes(marker)) return marker
  return null
}

const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"
const ZIP_LOCAL = [0x50, 0x4b, 0x03, 0x04] // "PK\x03\x04" — a zip with entries
const ZIP_EOCD = [0x50, 0x4b, 0x05, 0x06] // "PK\x05\x06" — end-of-central-directory

/** The main OOXML part that a valid file of each Office type must contain. */
const OOXML_MAIN: Record<'xlsx' | 'pptx' | 'docx', string> = {
  xlsx: 'xl/workbook.xml',
  pptx: 'ppt/presentation.xml',
  docx: 'word/document.xml'
}
const OOXML_KINDS = ['xlsx', 'pptx', 'docx'] as const

/** Validate a PDF: the "%PDF-" header plus a "%%EOF" trailer. */
function checkPdf(bytes: Uint8Array): ArtifactCheck {
  if (!startsWith(bytes, PDF_HEADER)) {
    const marker = errorTextMarker(bytes)
    return {
      ok: false,
      kind: 'pdf',
      detail: marker
        ? `Not a PDF — the file holds text ("${marker}…"), so the generating step failed and saved its output instead of a PDF.`
        : 'Not a PDF — missing the "%PDF-" signature.'
    }
  }
  // The trailer lives at the very end; scan the tail, then fall back to the whole file.
  if (indexOfAscii(bytes, '%%EOF', Math.max(0, bytes.length - 4096)) === -1 && !has(bytes, '%%EOF')) {
    return {
      ok: false,
      kind: 'pdf',
      detail: 'Truncated PDF — it has the "%PDF-" header but no "%%EOF" trailer, so it was cut off before finishing.'
    }
  }
  return { ok: true, kind: 'pdf', detail: `Valid PDF (${fmtBytes(bytes.length)}).` }
}

/** Validate a zip container, and for the OOXML kinds the required internal parts. */
function checkZip(kind: 'xlsx' | 'pptx' | 'docx' | 'zip', bytes: Uint8Array): ArtifactCheck {
  if (!startsWith(bytes, ZIP_LOCAL)) {
    if (startsWith(bytes, ZIP_EOCD)) {
      return { ok: false, kind, detail: `Empty ${kind} — a zip container with no entries, so nothing was written into it.` }
    }
    const marker = errorTextMarker(bytes)
    return {
      ok: false,
      kind,
      detail: marker
        ? `Not a ${kind} — the file holds text ("${marker}…"), not a ZIP package, so the generating script failed.`
        : `Not a ${kind} — missing the ZIP signature every ${kind === 'zip' ? 'zip' : 'Office (OOXML)'} file starts with.`
    }
  }
  if (indexOfBytes(bytes, ZIP_EOCD) === -1) {
    return {
      ok: false,
      kind,
      detail: `Truncated ${kind} — the ZIP central-directory end record is missing, so the file was cut off before it finished writing.`
    }
  }
  if (kind === 'zip') return { ok: true, kind, detail: `Valid ZIP archive (${fmtBytes(bytes.length)}).` }
  if (!has(bytes, '[Content_Types].xml')) {
    return { ok: false, kind, detail: `Not a valid ${kind} — it is a ZIP but has no [Content_Types].xml, so it is not an Office (OOXML) package.` }
  }
  if (!has(bytes, OOXML_MAIN[kind])) {
    const actual = OOXML_KINDS.find((k) => has(bytes, OOXML_MAIN[k]))
    return {
      ok: false,
      kind,
      detail: actual
        ? `Wrong type — this file is named .${kind} but is actually a ${actual} (found ${OOXML_MAIN[actual]}). Regenerate it as a real ${kind}, or save it with the .${actual} extension.`
        : `Not a valid ${kind} — the OOXML package is missing its main part (${OOXML_MAIN[kind]}).`
    }
  }
  return { ok: true, kind, detail: `Valid ${kind} (${fmtBytes(bytes.length)}).` }
}

/**
 * Decide whether `bytes` is a genuine file of the type `path`'s extension declares.
 * Deep-checks xlsx/pptx/docx (OOXML), pdf, and zip; for any other extension it only
 * confirms the file is present and non-empty (ok: true, kind: 'unknown').
 */
export function checkArtifact(path: string, bytes: Uint8Array): ArtifactCheck {
  const kind = kindFromPath(path)
  if (bytes.length === 0) {
    return { ok: false, kind, detail: 'The file is empty (0 bytes) — the step that should have written it produced nothing.' }
  }
  if (kind === 'pdf') return checkPdf(bytes)
  if (kind === 'xlsx' || kind === 'pptx' || kind === 'docx' || kind === 'zip') return checkZip(kind, bytes)
  return {
    ok: true,
    kind: 'unknown',
    detail: `Exists, ${fmtBytes(bytes.length)}. verify_file only deep-checks xlsx/pptx/docx/pdf/zip — for this type it confirmed the file is present and non-empty.`
  }
}
