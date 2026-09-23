// The per-user profile Myto keeps so its answers fit the person it's talking to. Stored in
// Firestore at users/{uid} (client-side, guarded by the rules in firestore.rules) and fed into the
// chat as lightweight context. Nothing here is secret — it is the user's own descriptive data.
//
// Imported by both the client (the onboarding form + chat) and, later, the desktop app, so it stays
// dependency-free.

export interface UserProfile {
  /** Firebase Auth uid — also the Firestore document id. */
  uid: string;
  /** Full name, seeded from the auth provider then editable in onboarding. */
  name: string;
  /** What Myto should call them (defaults to the first name). */
  nickname: string;
  /** Their role, e.g. "Frontend engineer", "Founder", "Student". */
  role: string;
  /** Company or team (optional; empty string when unknown). */
  company: string;
  /** Anything else they want Myto to keep in mind (optional). */
  about: string;
  /** Sign-in email, for the account chip. */
  email: string;
  /** Provider avatar URL, if any. */
  photoURL: string;
  /** Epoch ms. */
  createdAt: number;
  updatedAt: number;
}

/** The fields the onboarding form collects; the rest is derived from the auth user. */
export type ProfileDraft = Pick<UserProfile, 'name' | 'nickname' | 'role' | 'company' | 'about'>;

/**
 * A compact, one-line description fed to the model so replies fit the person. Returns '' when there
 * is nothing useful to say, so callers can skip the context message entirely.
 */
export function profileSummary(p: UserProfile | null | undefined): string {
  if (!p) return '';
  const bits: string[] = [];
  if (p.name) bits.push(`name: ${p.name}`);
  if (p.nickname && p.nickname !== p.name) bits.push(`prefers to be called ${p.nickname}`);
  if (p.role) bits.push(`role: ${p.role}`);
  if (p.company) bits.push(`company: ${p.company}`);
  if (p.about) bits.push(`notes: ${p.about}`);
  return bits.join('; ');
}
