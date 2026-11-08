// Fails a unit test the moment code tries the real Meta through the global fetch.
import { afterEach, beforeEach, vi } from 'vitest';

export const META_HOSTS = ['connect.facebook.net', 'www.facebook.com', 'graph.facebook.com'];

export function blockMetaFetch(): void {
  const real = globalThis.fetch;
  beforeEach(() => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
      if (META_HOSTS.includes(host)) throw new Error(`test attempted to reach the real Meta: ${host}`);
      return real(input);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
}
