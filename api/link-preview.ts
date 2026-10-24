import { handleLinkPreview } from '../src/server/link-preview';

export const config = { runtime: 'edge' };

export default function handler(req: Request): Promise<Response> {
  return handleLinkPreview(req);
}
