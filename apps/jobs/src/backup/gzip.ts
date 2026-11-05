// Streams SQL text through gzip; only compressed bytes are kept in memory.
import { createHash } from 'node:crypto';

export interface GzipResult {
  gz: Uint8Array;
  rawBytes: number;
  rawSha256: string;
  sha256: string;
}

export class GzipSink {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #out: Promise<ArrayBuffer>;
  readonly #rawHash = createHash('sha256');
  readonly #enc = new TextEncoder();
  #rawBytes = 0;

  constructor() {
    const cs = new CompressionStream('gzip');
    this.#writer = cs.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    this.#out = new Response(cs.readable).arrayBuffer();
  }

  async write(text: string): Promise<void> {
    const bytes = this.#enc.encode(text);
    this.#rawHash.update(bytes);
    this.#rawBytes += bytes.length;
    await this.#writer.write(bytes);
  }

  async finish(): Promise<GzipResult> {
    await this.#writer.close();
    const gz = new Uint8Array(await this.#out);
    const sha256 = createHash('sha256').update(gz).digest('hex');
    return { gz, rawBytes: this.#rawBytes, rawSha256: this.#rawHash.digest('hex'), sha256 };
  }

  async abort(): Promise<void> {
    await this.#writer.abort().catch(() => undefined);
    await this.#out.catch(() => undefined);
  }
}
