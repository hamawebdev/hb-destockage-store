// SQL text for the dump: identifier quoting and exact value literals (SQLite syntax, D1-compatible).

/** D1's maximum SQL statement length is 100,000 bytes. Stay well under it. */
export const MAX_STATEMENT_BYTES = 90_000;
export const MAX_ROWS_PER_INSERT = 500;
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function toHex(bytes: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]! & 0xff];
  return s;
}

/** D1 returns BLOBs as number[] (or ArrayBuffer / typed arrays in some paths). */
export function blobBytes(v: unknown): ArrayLike<number> | null {
  if (Array.isArray(v)) return v as number[];
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

export class UnsupportedValueError extends Error {
  override readonly name = 'UnsupportedValueError';
}

/** Exact SQL literal for a value read from D1. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'NULL'; // SQLite stores NaN as NULL
    if (v === Infinity) return '9e999';
    if (v === -Infinity) return '-9e999';
    const s = String(v); // shortest round-trip representation for doubles
    // Integral values beyond 2^53 can only be REALs here (the precision guard rejects INTEGERs that
    // large before export): keep them REAL so SQLite does not parse them as INTEGER.
    if (Number.isInteger(v) && Math.abs(v) > MAX_SAFE && !/[.e]/.test(s)) return `${s}.0`;
    return s;
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'string') {
    if (v.includes('\0')) return `CAST(X'${toHex(new TextEncoder().encode(v))}' AS TEXT)`;
    return `'${v.replaceAll("'", "''")}'`;
  }
  const bytes = blobBytes(v);
  if (bytes) return `X'${toHex(bytes)}'`;
  throw new UnsupportedValueError(`unsupported value type ${typeof v}`);
}

export class OversizedRowError extends Error {
  override readonly name = 'OversizedRowError';
}

/**
 * Accumulates rows of one table into multi-row INSERT statements under D1's statement limit.
 * `flush` callbacks receive complete statements ending in ";\n".
 */
export class InsertWriter {
  readonly table: string;
  readonly columns: readonly string[];
  readonly #prefix: string;
  readonly #emit: (stmt: string) => Promise<void>;
  #tuples: string[] = [];
  #bytes = 0;

  // Plain fields (no parameter properties): the Node restore script runs this file with type stripping.
  constructor(table: string, columns: readonly string[], emit: (stmt: string) => Promise<void>) {
    this.table = table;
    this.columns = columns;
    this.#prefix = `INSERT INTO ${quoteIdent(table)} (${columns.map(quoteIdent).join(',')}) VALUES\n`;
    this.#emit = emit;
  }

  async add(row: Record<string, unknown>): Promise<void> {
    const tuple = `(${this.columns.map((c) => sqlLiteral(row[c])).join(',')})`;
    const size = utf8Length(tuple) + 2;
    if (utf8Length(this.#prefix) + size + 2 > MAX_STATEMENT_BYTES) {
      // Never put row data in the error: table name only.
      throw new OversizedRowError(`row in ${this.table} exceeds the statement size limit`);
    }
    if (this.#tuples.length >= MAX_ROWS_PER_INSERT || this.#bytes + size > MAX_STATEMENT_BYTES - utf8Length(this.#prefix)) {
      await this.flush();
    }
    this.#tuples.push(tuple);
    this.#bytes += size;
  }

  async flush(): Promise<void> {
    if (this.#tuples.length === 0) return;
    const stmt = `${this.#prefix}${this.#tuples.join(',\n')};\n`;
    this.#tuples = [];
    this.#bytes = 0;
    await this.#emit(stmt);
  }
}

const enc = new TextEncoder();
export function utf8Length(s: string): number {
  // Fast path for ASCII.
  let ascii = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) {
      ascii = false;
      break;
    }
  }
  return ascii ? s.length : enc.encode(s).length;
}
