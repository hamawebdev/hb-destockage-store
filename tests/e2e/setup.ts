/**
 * Vitest global setup for the e2e suite: seed one local D1, boot web + admin when their code is
 * in this checkout, provide their URLs (or the boot error) to the specs, stop them afterwards.
 * A boot failure is NOT a skip: specs that need the worker fail with the error.
 */
import type { TestProject } from 'vitest/node';
import { ARTIFACTS, FEATURES, migrateFresh, seedFresh, startWorker, type Running } from './harness.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { REPO } from './harness.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    webUrl: string | null;
    adminUrl: string | null;
    bootError: string | null;
    seeded: boolean;
  }
}

let running: Running[] = [];

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const ext = { web: process.env['HB_E2E_WEB_URL'] ?? null, admin: process.env['HB_E2E_ADMIN_URL'] ?? null };
  let bootError: string | null = null;
  let seeded = false;
  let webUrl = ext.web;
  let adminUrl = ext.admin;
  const logs = path.join(ARTIFACTS, 'logs');
  try {
    if (!ext.web && !ext.admin) {
      if (!FEATURES.seed()) { seedFresh(); seeded = true; } else migrateFresh();
    }
    if (!webUrl && existsSync(path.join(REPO, 'apps/web/wrangler.jsonc')) && !FEATURES.storefront()) {
      const w = await startWorker('web', logs);
      running.push(w);
      webUrl = w.url;
    }
    if (!adminUrl && !FEATURES.adminAuth()) {
      const a = await startWorker('admin', logs);
      running.push(a);
      adminUrl = a.url;
    }
  } catch (e) {
    bootError = (e as Error).message;
  }
  project.provide('webUrl', webUrl);
  project.provide('adminUrl', adminUrl);
  project.provide('bootError', bootError);
  project.provide('seeded', seeded || !!ext.web);
  return async () => {
    for (const r of running) await r.stop();
    running = [];
  };
}
