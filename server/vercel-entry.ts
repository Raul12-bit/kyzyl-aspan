/**
 * Entry of every Vercel function (bundled by scripts/build-vercel.mjs into .vercel/output/functions/api/…).
 * Vercel routes each /api/* path to its own function; all of them run the same router as `pnpm server`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleApi, send } from './handlers';

export default function handler(req: IncomingMessage, res: ServerResponse) {
  if (!handleApi(req, res)) send(res, 404, { error: 'Not found' });
}
