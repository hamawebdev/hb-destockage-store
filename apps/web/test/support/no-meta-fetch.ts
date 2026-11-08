// Fails a unit test when code tries the real Meta through the global fetch. Attempts are recorded
// and asserted after the test, because the sender catches its own errors by design.
import { afterEach, beforeEach, expect, vi } from 'vitest';

export const META_HOSTS = ['connect.facebook.net', 'www.facebook.com', 'graph.facebook.com'];

export function blockMetaFetch(): void {
  const real = globalThis.fetch;
  let attempts: string[] = [];
  beforeEach(() => {
    attempts = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
      if (META_HOSTS.includes(host)) {
        attempts.push(host);
        throw new Error(`test attempted to reach the real Meta: ${host}`);
      }
      return real(input, init);
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    expect(attempts, 'a test attempted to reach the real Meta').toEqual([]);
  });
}
