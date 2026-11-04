// Fixture (TOOL-2 r1): proves every @hb/* library resolves by package name
// under tsc, vitest and wrangler's bundler. Not deployed.
import { PACKAGE as catalog } from '@hb/catalog';
import { PACKAGE as db } from '@hb/db';
import { PACKAGE as shared } from '@hb/shared';
import { PACKAGE as tokens } from '@hb/ui-tokens';

export const packages = [catalog, db, shared, tokens];

export default {
  async fetch(): Promise<Response> {
    return Response.json(packages);
  },
};
