// Classifies pending D1 migrations before the pipeline applies them (docs/DEPLOY.md).
// Fail-closed: a statement that is not recognised as additive counts as destructive.
import { createHash } from 'node:crypto';

export interface MigrationFile {
  readonly name: string;
  readonly content: string;
}

interface Token {
  readonly text: string; // upper-cased for bare words, verbatim for quoted names
  readonly quoted: boolean;
}

export interface Statement {
  readonly tokens: readonly Token[];
  readonly preview: string;
  /** Index in `tokens` of a CREATE TRIGGER's body (just after its BEGIN). */
  readonly triggerBody?: number;
  /** Why a CREATE TRIGGER could not be delimited with confidence; treated as destructive. */
  readonly triggerProblem?: string;
}

/**
 * Splits SQL into statements; comments and strings are removed, trigger bodies stay whole.
 *
 * BEGIN and END are also legal identifiers in SQLite, so a CREATE TRIGGER is delimited by its
 * grammar: the body opens at the first bare BEGIN after ON, and closes at the END that balances
 * it, immediately before the `;`. Anything that does not fit is reported, never guessed.
 */
export function parseStatements(sql: string): Statement[] {
  const out: Statement[] = [];
  let tokens: Token[] = [];
  let start = -1;
  // CREATE TRIGGER state: 0 = before ON, 1 = after ON (looking for BEGIN), 2 = in the body, 3 = after the final END
  let phase = 0;
  let depth = 0;
  let body: number | undefined;
  let problem: string | undefined;
  let i = 0;

  const isTrigger = (): boolean => {
    const w = tokens.slice(0, 4).map((t) => (t.quoted ? '' : t.text));
    return w[0] === 'CREATE' && (w[1] === 'TRIGGER' || ((w[1] === 'TEMP' || w[1] === 'TEMPORARY') && w[2] === 'TRIGGER'));
  };
  const flush = (end: number): void => {
    if (tokens.length > 0) {
      const trigger = isTrigger();
      if (trigger && phase !== 3) problem ??= 'the trigger body is not closed by a final END';
      out.push({
        tokens,
        preview: sql.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 100),
        ...(trigger && body !== undefined ? { triggerBody: body } : {}),
        ...(trigger && problem !== undefined ? { triggerProblem: problem } : {}),
      });
    }
    tokens = [];
    start = -1;
    phase = 0;
    depth = 0;
    body = undefined;
    problem = undefined;
  };
  const push = (text: string, quoted: boolean, at: number): void => {
    if (start < 0) start = at;
    tokens.push({ text, quoted });
  };
  /** Advances the trigger state for the bare word just pushed. */
  const onTriggerWord = (word: string, afterDot: boolean): void => {
    if (phase === 3) {
      problem ??= 'text after the final END of the trigger';
    } else if (phase === 0) {
      if (word === 'ON') phase = 1;
    } else if (phase === 1) {
      if (word === 'BEGIN' && !afterDot) {
        phase = 2;
        depth = 1;
        body = tokens.length;
      }
    } else if (!afterDot) {
      if (word === 'BEGIN') problem ??= 'a second BEGIN inside the trigger body';
      else if (word === 'CASE') depth++;
      else if (word === 'END' && --depth === 0) phase = 3;
    }
  };

  while (i < sql.length) {
    const c = sql[i]!;
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? sql.length : nl + 1;
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close < 0 ? sql.length : close + 2;
    } else if (c === "'" || c === '"' || c === '`' || c === '[') {
      const closer = c === '[' ? ']' : c;
      let j = i + 1;
      let value = '';
      while (j < sql.length) {
        if (sql[j] === closer) {
          if (closer !== ']' && sql[j + 1] === closer) {
            value += closer;
            j += 2;
            continue;
          }
          break;
        }
        value += sql[j];
        j++;
      }
      push(c === "'" ? "'" : value, true, i);
      if (isTrigger() && phase === 3) problem ??= 'text after the final END of the trigger';
      i = j + 1;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < sql.length && /[\w$]/.test(sql[j]!)) j++;
      const word = sql.slice(i, j).toUpperCase();
      const prev = tokens.at(-1);
      const afterDot = prev !== undefined && !prev.quoted && prev.text === '.';
      push(word, false, i);
      if (isTrigger() && tokens.length > 2) onTriggerWord(word, afterDot);
      i = j;
    } else if (c === ';') {
      if (!(isTrigger() && phase === 2)) flush(i);
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      push(c, false, i);
      if (isTrigger() && phase === 3) problem ??= 'text after the final END of the trigger';
      i++;
    }
  }
  flush(sql.length);
  return out;
}

const SAFE_PRAGMAS = new Set(['DEFER_FOREIGN_KEYS', 'FOREIGN_KEYS', 'FOREIGN_KEY_CHECK', 'FOREIGN_KEY_LIST', 'TABLE_INFO', 'INDEX_LIST']);

/** A trigger is additive only when its body cannot write: it would run on every later order. */
function triggerReason(s: Statement): string | null {
  if (s.triggerProblem) return `CREATE TRIGGER (${s.triggerProblem}): ${s.preview}`;
  if (s.triggerBody === undefined) return `CREATE TRIGGER without a body: ${s.preview}`;
  for (let i = s.triggerBody; i < s.tokens.length; i++) {
    const t = s.tokens[i]!;
    if (t.quoted || s.tokens[i - 1]?.text === '.') continue;
    if (t.text === 'UPDATE' || t.text === 'DELETE' || t.text === 'INSERT' || t.text === 'REPLACE') {
      return `CREATE TRIGGER whose body writes (${t.text}): ${s.preview}`;
    }
  }
  return null;
}

/** Why this statement can drop or rewrite existing data; null when it is additive. */
export function destructiveReason(s: Statement): string | null {
  const word = (i: number): string => {
    const t = s.tokens[i];
    return t && !t.quoted ? t.text : '';
  };
  const words = s.tokens.map((t) => (t.quoted ? '' : t.text));
  const unrecognised = `unrecognised statement: ${s.preview}`;

  // A conflict clause that deletes rows on later plain INSERTs, wherever it is declared.
  if (words.some((w, i) => w === 'ON' && words[i + 1] === 'CONFLICT' && words[i + 2] === 'REPLACE')) {
    return `ON CONFLICT REPLACE: ${s.preview}`;
  }

  switch (word(0)) {
    case 'SELECT':
      return null;
    case 'CREATE': {
      const kind = word(1) === 'TEMP' || word(1) === 'TEMPORARY' ? word(2) : word(1);
      if (kind === 'TRIGGER') return triggerReason(s);
      if (kind === 'TABLE' || kind === 'INDEX' || kind === 'VIEW' || kind === 'UNIQUE' || kind === 'VIRTUAL') return null;
      return unrecognised;
    }
    case 'DROP': {
      if (word(1) === 'TABLE') return `DROP TABLE: ${s.preview}`;
      if (word(1) === 'INDEX' || word(1) === 'TRIGGER' || word(1) === 'VIEW') return null;
      return unrecognised;
    }
    case 'ALTER': {
      if (word(1) !== 'TABLE') return unrecognised;
      const op = words.slice(2).find((w) => w === 'ADD' || w === 'DROP' || w === 'RENAME');
      if (op === 'ADD') return null;
      if (op === 'DROP') return `ALTER TABLE DROP COLUMN: ${s.preview}`;
      if (op === 'RENAME') return `ALTER TABLE RENAME: ${s.preview}`;
      return unrecognised;
    }
    case 'DELETE':
      return `DELETE: ${s.preview}`;
    case 'UPDATE':
      return `UPDATE: ${s.preview}`;
    case 'REPLACE':
      return `REPLACE: ${s.preview}`;
    case 'TRUNCATE':
      return `TRUNCATE: ${s.preview}`;
    case 'INSERT': {
      if (word(1) === 'OR' && word(2) === 'REPLACE') return `INSERT OR REPLACE: ${s.preview}`;
      const doAt = words.findIndex((w, i) => w === 'DO' && words[i + 1] === 'UPDATE');
      if (doAt >= 0) return `INSERT ... ON CONFLICT DO UPDATE: ${s.preview}`;
      return null;
    }
    case 'PRAGMA':
      return SAFE_PRAGMAS.has(word(1)) ? null : unrecognised;
    default:
      return unrecognised;
  }
}

/** Reasons a migration file is destructive; empty when every statement is additive. */
export function classifyMigration(content: string): string[] {
  const statements = parseStatements(content);
  const reasons = statements.map(destructiveReason).filter((r): r is string => r !== null);
  const rebuild = statements.some((s) => {
    const words = s.tokens.map((t) => (t.quoted ? '' : t.text));
    if (words[0] !== 'CREATE' || !words.includes('TABLE')) return false;
    return s.tokens.some((t) => t.text.toLowerCase().startsWith('__new_'));
  });
  return rebuild ? ['table rebuild (__new_ table)', ...reasons] : reasons;
}

export function pendingSetHash(pending: readonly MigrationFile[]): string {
  const h = createHash('sha256');
  for (const m of pending) h.update(m.name).update('\0').update(m.content).update('\0');
  return h.digest('hex');
}

export interface MigrationPlan {
  readonly pending: readonly MigrationFile[];
  readonly hash: string;
  readonly destructive: readonly { readonly name: string; readonly reasons: readonly string[] }[];
  readonly firstDeployment: boolean;
  readonly action: 'none' | 'apply' | 'halt';
  readonly warnings: readonly string[];
}

export interface PlanInput {
  /** Migrations in the repository, any order. */
  readonly files: readonly MigrationFile[];
  /** Names in d1_migrations. */
  readonly applied: readonly string[];
  /** User tables in the database, excluding d1_migrations and D1/SQLite internals. */
  readonly userTables: number;
  /** approve_destructive_migrations input; only ever set on a hand-started run. */
  readonly approval: string;
}

export class MigrationOrderError extends Error {
  override readonly name = 'MigrationOrderError';
}

export function planMigrations(input: PlanInput): MigrationPlan {
  const files = [...input.files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const known = new Set(files.map((f) => f.name));
  const applied = new Set(input.applied);
  const pending = files.filter((f) => !applied.has(f.name));
  const lastApplied = [...applied].filter((n) => known.has(n)).sort().at(-1);
  const early = lastApplied === undefined ? [] : pending.filter((m) => m.name < lastApplied);
  if (early.length > 0) {
    throw new MigrationOrderError(
      `refusing to apply migrations out of order: ${early.map((m) => m.name).join(', ')} sort(s) before the last applied migration ${lastApplied}`,
    );
  }
  const warnings = input.applied
    .filter((n) => !known.has(n))
    .map((n) => `migration ${n} is applied on the database but not in this commit`);

  const hash = pendingSetHash(pending);
  const destructive = pending
    .map((m) => ({ name: m.name, reasons: classifyMigration(m.content) }))
    .filter((m) => m.reasons.length > 0);
  const firstDeployment = input.applied.length === 0 && input.userTables === 0;

  let action: MigrationPlan['action'];
  if (pending.length === 0) action = 'none';
  else if (destructive.length === 0 || firstDeployment || input.approval === hash) action = 'apply';
  else action = 'halt';
  return { pending, hash, destructive, firstDeployment, action, warnings };
}
