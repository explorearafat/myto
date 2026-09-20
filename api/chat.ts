
import { handleChat } from '../src/server/gateway';

export const config = { runtime: 'edge' };

export default function handler(req: Request): Promise<Response> {
  return handleChat(req);
}
