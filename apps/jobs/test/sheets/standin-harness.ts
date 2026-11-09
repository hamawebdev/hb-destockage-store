// Spawns the real Google stand-in as its own process and drives its control API.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../../../tools/standins/sheets/server.mjs', import.meta.url).href);

export interface StandinCall {
  at: number;
  method: string;
  path: string;
  query: string;
  body: unknown;
  status: number | null;
  dropped: boolean;
}

export interface SheetDump {
  id: string;
  name: string;
  trashed: boolean;
  tab: string;
  sheetId: number;
  rowCount: number;
  columnCount: number;
  frozenRowCount: number;
  rightToLeft: boolean;
  hiddenRows: number[];
  rows: (string | number | boolean | { formula: string } | null)[][];
}

export interface Standin {
  url: string;
  post(path: string, body?: unknown): Promise<Response>;
  mode(m: Record<string, unknown>): Promise<void>;
  action(a: Record<string, unknown>): Promise<void>;
  calls(): Promise<StandinCall[]>;
  sheet(query?: string): Promise<SheetDump>;
  state(): Promise<{ files: { id: string; name: string; trashed: boolean; visibleToApp: boolean; appProperties: Record<string, string>; tabs: string[] }[]; liveRefreshTokens: number }>;
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startStandin(): Promise<Standin> {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [SERVER, '--port', '0'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(out);
      if (m?.[1]) resolve(m[1]);
    });
    child.on('exit', (code) => reject(new Error(`stand-in exited: ${String(code)}`)));
  });
  const post = (path: string, body?: unknown): Promise<Response> =>
    fetch(`${url}/__control${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const must = async (r: Promise<Response>): Promise<void> => {
    const res = await r;
    if (!res.ok) throw new Error(`control call failed: ${res.status} ${await res.text()}`);
  };
  return {
    url,
    post,
    mode: (m) => must(post('/mode', m)),
    action: (a) => must(post('/action', a)),
    calls: async () => ((await (await fetch(`${url}/__control/calls`)).json()) as { calls: StandinCall[] }).calls,
    sheet: async (query = '') => (await (await fetch(`${url}/__control/sheet${query}`)).json()) as SheetDump,
    state: async () => (await (await fetch(`${url}/__control/state`)).json()) as Awaited<ReturnType<Standin['state']>>,
    reset: () => must(post('/reset')),
    stop: () =>
      new Promise<void>((resolve) => {
        child.removeAllListeners('exit');
        child.on('exit', () => resolve());
        child.kill();
      }),
  };
}
