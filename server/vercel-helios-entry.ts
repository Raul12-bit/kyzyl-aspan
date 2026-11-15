/**
 * Entry of the Vercel functions /v1/helios/status and /v1/helios/constellation (scripts/build-vercel.mjs):
 * the live satellites computed in TypeScript, since the Python HELIOS API does not run on Vercel.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from './handlers';
import { handleHeliosLite } from './heliosLite';

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!(await handleHeliosLite(req, res))) send(res, 404, { error: 'Not found' });
}
