
import { handleModels } from '../src/server/gateway';

export const config = { runtime: 'edge' };

export default function handler(req: Request): Promise<Response> {
  return handleModels(req);
}
