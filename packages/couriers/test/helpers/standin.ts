/** Spawns the real stand-in server as a child process on an ephemeral port. */
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../../../tools/standins/couriers/server.mjs', import.meta.url));

export interface Standin {
  readonly url: string;
  readonly port: number;
  reset(): Promise<void>;
  scenario(courier: string, settings: Record<string, unknown>): Promise<void>;
  state(courier: string): Promise<StandinState>;
  control(path: string, body?: unknown): Promise<unknown>;
  stop(): Promise<void>;
}

export interface StandinState {
  createCount: number;
  readCount: number;
  lastCreateBody: unknown;
  lastUrl: string | null;
  parcels: Array<Record<string, unknown>>;
}

export async function startStandin(): Promise<Standin> {
  const child: ChildProcess = spawn(process.execPath, [SERVER, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stand-in did not start')), 10_000);
    child.once('exit', (code) => reject(new Error(`stand-in exited with ${String(code)}`)));
    child.stdout?.on('data', (chunk: Buffer) => {
      const match = /127\.0\.0\.1:(\d+)/.exec(String(chunk));
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  const url = `http://127.0.0.1:${port}`;

  async function control(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${url}/__control/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return response.json();
  }

  return {
    url,
    port,
    control,
    reset: async () => {
      await control('reset', {});
    },
    scenario: async (courier, settings) => {
      await control(`${courier}/scenario`, settings);
    },
    state: async (courier) => (await control(`${courier}/state`)) as StandinState,
    stop: async () => {
      child.removeAllListeners('exit');
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await gone;
    },
  };
}
