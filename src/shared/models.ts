// The two models a visitor can pick on /chat. These are *facade* identities: both route,
// server-side, across the same pool of real upstream models with smart failover — the names
// are branding only. This module is imported by BOTH the client (the dropdown) and the server
// (request validation), so it is the single source of truth and must stay free of secrets.

export interface OraculumModel {
  /** The id the client sends and the server validates against. */
  id: string;
  /** The display name shown once selected. */
  name: string;
  /** A one-line description under the name in the picker. */
  blurb: string;
}

export const ORACULUM_MODELS: OraculumModel[] = [
  {
    id: 'sylor-oraculum-aeon200B',
    name: 'Oraculum Thinking',
    blurb: 'Deliberate, step-by-step reasoning',
  },
  {
    id: 'sylor-oraculum-aeon1.0-230B',
    name: 'Oraculum Pro',
    blurb: 'Fast, capable everyday model',
  },
];

/** The default selection (first option). */
export const DEFAULT_MODEL_ID = ORACULUM_MODELS[0].id;

/** True when `id` is one of the two facade models we accept. */
export function isOraculumModel(id: unknown): id is string {
  return typeof id === 'string' && ORACULUM_MODELS.some((m) => m.id === id);
}

/** The display name for a facade id, falling back to a neutral label. */
export function modelName(id: string): string {
  return ORACULUM_MODELS.find((m) => m.id === id)?.name ?? 'Oraculum';
}
