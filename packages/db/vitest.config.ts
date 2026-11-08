// @hb/db tests: several files start a fresh workerd D1 per test through wrangler getPlatformProxy.
// Running files one at a time keeps the number of concurrent workerd instances (and their loopback
// RPC) low on the shared machine; parallel files made the proxy drop connections under load.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
