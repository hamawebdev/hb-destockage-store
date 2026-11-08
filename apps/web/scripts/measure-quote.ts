// Local latency of POST /api/quote (WEB-2). Runs the real Worker in workerd with a local D1
// (wrangler test harness, env "test", fixture catalogue) and prints p50/p90/p99 per scenario.
// Usage: node apps/web/scripts/measure-quote.ts [N]   (Node ≥ 24 strips the types)
// Local D1 is an in-process SQLite: this measures Worker + query cost, NOT the production
// Worker→D1 network round trip (see artifacts/WEB-2/latency.md for that figure and its source).
import { cpus, loadavg } from 'node:os';
import { postJson, startSeeded } from '../test/support/harness.ts';

const N = Number(process.argv[2] ?? 300);
const WARMUP = 30;

function pct(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)] ?? NaN;
}

async function measure(label: string, run: () => Promise<Response>): Promise<string> {
  for (let i = 0; i < WARMUP; i++) await (await run()).arrayBuffer();
  const ms: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const res = await run();
    await res.arrayBuffer();
    ms.push(performance.now() - t0);
    if (!res.ok && res.status !== 409) throw new Error(`${label}: HTTP ${res.status}`);
  }
  ms.sort((a, b) => a - b);
  const f = (x: number) => x.toFixed(2).padStart(7);
  return `| ${label.padEnd(44)} | ${String(N).padStart(4)} | ${f(pct(ms, 50))} | ${f(pct(ms, 90))} | ${f(pct(ms, 99))} |`;
}

const load = () => loadavg().map((x) => x.toFixed(2)).join(' / ');
const loadBefore = load();
const { server } = await startSeeded();
try {
  const rows = [
    await measure('GET /api/health (no D1, baseline)', () => server.fetch('/api/health')),
    await measure('GET /api/health?db=1 (one D1 read)', () => server.fetch('/api/health?db=1')),
    await measure('POST /api/quote 1 line, wilaya only', () =>
      postJson(server, '/api/quote', { items: [{ variantId: 11, qty: 1 }], wilayaCode: 16 }),
    ),
    await measure('POST /api/quote 1 line + commune (batch)', () =>
      postJson(server, '/api/quote', { items: [{ variantId: 11, qty: 1 }], wilayaCode: 16, communeId: 1601 }),
    ),
    await measure('POST /api/quote 2 lines + commune', () =>
      postJson(server, '/api/quote', {
        items: [{ variantId: 11, qty: 1 }, { variantId: 21, qty: 2 }],
        wilayaCode: 16,
        communeId: 1601,
      }),
    ),
    await measure('POST /api/quote wilaya not served', () =>
      postJson(server, '/api/quote', { items: [{ variantId: 11, qty: 1 }], wilayaCode: 31, communeId: 3101 }),
    ),
  ];
  console.log('| Scenario | N | p50 ms | p90 ms | p99 ms |\n|---|---|---|---|---|');
  for (const r of rows) console.log(r);
  console.log(`\nload average (1/5/15 min) on ${cpus().length} CPUs: before ${loadBefore}, after ${load()}; ${new Date().toISOString()}`);
} finally {
  await server.close();
}
