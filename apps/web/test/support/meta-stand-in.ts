// Local stand-in for Meta's Graph API. A real HTTP server, used by the workerd and browser tests:
// no test reaches the real Meta. The token is redacted to a boolean in everything it records.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type StandInMode = 'ok' | '500' | '400' | 'hang';

export interface StandInEvent {
  readonly event_name: string;
  readonly event_id: string;
  readonly event_time: number;
  readonly event_source_url: string;
  readonly action_source: string;
  readonly user_data: Record<string, unknown>;
  readonly custom_data: Record<string, unknown>;
}

export interface StandInHit {
  readonly path: string;
  readonly hasToken: boolean;
  readonly tokenInUrl: boolean;
  readonly testEventCode?: string;
  readonly events: readonly StandInEvent[];
}

export interface MetaStandIn {
  readonly url: string;
  readonly port: number;
  hits(): readonly StandInHit[];
  /** Every event from every hit, in arrival order. */
  events(): readonly StandInEvent[];
  /** Number of requests the stand-in has received and not answered yet (mode `hang`). */
  held(): number;
  setMode(mode: StandInMode): void;
  reset(): void;
  /** Answers anything still held, then stops listening: from here on the stand-in is down. */
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((done, fail) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (body += c));
    req.on('end', () => done(body));
    req.on('error', fail);
  });

export async function startMetaStandIn(port = 0): Promise<MetaStandIn> {
  let mode: StandInMode = 'ok';
  let hits: StandInHit[] = [];
  const held = new Set<ServerResponse>();

  const server: Server = createServer((req, res) => {
    void readBody(req).then((text) => {
      const url = req.url ?? '';
      let parsed: { data?: StandInEvent[]; access_token?: unknown; test_event_code?: string } = {};
      try {
        parsed = JSON.parse(text) as typeof parsed;
      } catch {
        // Recorded as a hit with no events.
      }
      hits.push({
        path: url.split('?')[0] ?? url,
        hasToken: typeof parsed.access_token === 'string' && parsed.access_token !== '',
        tokenInUrl: url.includes('access_token'),
        ...(parsed.test_event_code === undefined ? {} : { testEventCode: parsed.test_event_code }),
        events: parsed.data ?? [],
      });
      if (mode === 'hang') {
        held.add(res);
        res.on('close', () => held.delete(res));
        return;
      }
      const status = mode === '500' ? 500 : mode === '400' ? 400 : 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(status === 200 ? JSON.stringify({ events_received: 1, messages: [], fbtrace_id: 'standin' }) : '{"error":{"message":"stand-in"}}');
    });
  });
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done));
  const actual = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    hits: () => hits,
    events: () => hits.flatMap((h) => h.events),
    held: () => held.size,
    setMode: (m) => {
      mode = m;
    },
    reset: () => {
      for (const r of held) r.destroy();
      held.clear();
      hits = [];
      mode = 'ok';
    },
    close: async () => {
      for (const r of held) r.destroy();
      held.clear();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
