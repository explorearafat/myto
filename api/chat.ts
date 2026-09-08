// Vercel Edge Function entry for /api/chat. The logic lives in the runtime-agnostic handler so
// the same code path serves both this function and the Vite dev middleware; this file only wires
// it to Vercel's Edge runtime. Env vars (B_AI_KEYS, UPSTASH_*, …) are configured in the Vercel
// project and are never exposed to the browser.

import { handleChat } from '../src/server/gateway';

export const config = { runtime: 'edge' };

export default function handler(req: Request): Promise<Response> {
  return handleChat(req);
}
