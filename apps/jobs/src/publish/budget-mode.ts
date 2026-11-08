// Warm vs full byte-budget mode for a publish (JOBS-7, lead ruling on JOBS-3 timing; D-003).
// Decided from the build's own fingerprint (image-manifest digest + template/code hash) against
// the last good build's, never from an admin flag. Conservative: anything unknown → full.
//   static = measure's static pass only (HTML ≤ 14 KiB br, critical path bytes/requests, AVIF
//            ceilings, third-party origins in markup), still BLOCKING;
//   full   = static + the Chrome runtime pass, BLOCKING.

export const FINGERPRINT_SCHEMA = 1;
/** A full pass at least every N warm publishes, not only nightly. */
export const MAX_STATIC_STREAK = 20;

export interface BuildFingerprint {
  /** sha256 of the canonical image manifest (every image's content hash and variants). */
  images: string;
  /** sha256 over the git blob ids of every path that shapes the built site or its budget. */
  template: string;
  /** Uncommitted changes in those paths: the template hash cannot vouch for them. */
  dirty: boolean;
}

export interface LastGood {
  schema: typeof FINGERPRINT_SCHEMA;
  images: string;
  template: string;
  /** Consecutive static-only publishes up to and including this one (0 after a full pass). */
  staticOnlyStreak: number;
  runId: number;
  at: number;
}

export type BudgetMode = 'static' | 'full';
export interface ModeDecision {
  mode: BudgetMode;
  reason: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Validates last-good.json content (string, already-parsed value, or null when absent). */
export function readLastGood(raw: unknown): { ok: true; value: LastGood } | { ok: false; reason: string } {
  if (raw === null || raw === undefined) return { ok: false, reason: 'no last good build recorded' };
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'last-good.json unreadable' };
    }
  }
  if (typeof v !== 'object' || v === null) return { ok: false, reason: 'last-good.json malformed' };
  const o = v as Record<string, unknown>;
  if (o['schema'] !== FINGERPRINT_SCHEMA) return { ok: false, reason: `fingerprint schema changed (${String(o['schema'])} → ${FINGERPRINT_SCHEMA})` };
  const streak = o['staticOnlyStreak'];
  if (
    typeof o['images'] !== 'string' || !HEX64.test(o['images']) ||
    typeof o['template'] !== 'string' || !HEX64.test(o['template']) ||
    !Number.isInteger(streak) || (streak as number) < 0 ||
    !Number.isInteger(o['runId']) || !Number.isInteger(o['at'])
  ) {
    return { ok: false, reason: 'last-good.json malformed' };
  }
  return { ok: true, value: o as unknown as LastGood };
}

export function decideBudgetMode(lastGoodRaw: unknown, cur: BuildFingerprint, maxStreak = MAX_STATIC_STREAK): ModeDecision {
  const prev = readLastGood(lastGoodRaw);
  if (!prev.ok) return { mode: 'full', reason: prev.reason };
  if (cur.dirty) return { mode: 'full', reason: 'uncommitted changes in template/code paths' };
  if (cur.images !== prev.value.images) return { mode: 'full', reason: 'images added or changed' };
  if (cur.template !== prev.value.template) return { mode: 'full', reason: 'template/code/budget config changed' };
  if (prev.value.staticOnlyStreak >= maxStreak) return { mode: 'full', reason: `periodic full pass after ${prev.value.staticOnlyStreak} static-only publishes` };
  return { mode: 'static', reason: 'content-only change (text, price, stock, settings)' };
}

export function nextLastGood(lastGoodRaw: unknown, cur: BuildFingerprint, mode: BudgetMode, runId: number, at: number): LastGood {
  const prev = readLastGood(lastGoodRaw);
  const streak = mode === 'full' ? 0 : (prev.ok ? prev.value.staticOnlyStreak : 0) + 1;
  return { schema: FINGERPRINT_SCHEMA, images: cur.images, template: cur.template, staticOnlyStreak: streak, runId, at };
}
