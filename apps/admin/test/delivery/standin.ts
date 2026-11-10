// The real courier stand-in as a child process on an ephemeral port (tools/standins/couriers).
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../../../../tools/standins/couriers/server.mjs', import.meta.url).href);

export interface Standin {
  url: string;
  control: (path: string, body?: unknown) => Promise<unknown>;
  state: (courier: string) => Promise<{ createCount: number; readCount: number } & Record<string, unknown>>;
  reset: () => Promise<void>;
  stop: () => void;
}

export async function startStandin(): Promise<Standin> {
  const child: ChildProcess = spawn(process.execPath, [SERVER, '--port', '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const url = await new Promise<string>((resolve, reject) => {
    let out = '';
    child.stdout!.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const port = /(?:port|:)\s*(\d{2,5})/.exec(out)?.[1];
      if (port) resolve(`http://127.0.0.1:${port}`);
    });
    child.once('exit', (code) => reject(new Error(`stand-in exited with ${code}: ${out}`)));
  });
  const control = async (path: string, body?: unknown) => {
    const res = await fetch(`${url}/__control/${path}`, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return res.json() as Promise<unknown>;
  };
  return {
    url,
    control,
    state: (courier) => control(`${courier}/state`) as ReturnType<Standin['state']>,
    reset: async () => void (await control('reset', {})),
    stop: () => void child.kill(),
  };
}
