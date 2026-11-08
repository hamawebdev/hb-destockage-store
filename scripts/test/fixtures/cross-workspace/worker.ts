// Fixture (TOOL-2 r1; namespace imports since TOOL-7): proves every @hb/* library resolves by package
// name under tsc, vitest and wrangler's bundler — without depending on any particular export, so it
// holds before and after the contract branches replace the TOOL-2 placeholders. Not deployed.
import * as catalog from '@hb/catalog';
import * as db from '@hb/db';
import * as shared from '@hb/shared';
import * as tokens from '@hb/ui-tokens';

export const resolved: Readonly<Record<string, unknown>> = {
  '@hb/catalog': catalog,
  '@hb/db': db,
  '@hb/shared': shared,
  '@hb/ui-tokens': tokens,
};

export default {
  async fetch(): Promise<Response> {
    return Response.json(Object.fromEntries(Object.entries(resolved).map(([name, ns]) => [name, typeof ns])));
  },
};
