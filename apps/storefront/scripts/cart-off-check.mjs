#!/usr/bin/env node
// CART-4 evidence (ledger C-8, C-9): scans a built dist for any cart UI, cart file or reference to one.
// Usage: node apps/storefront/scripts/cart-off-check.mjs [dist dir, default apps/storefront/dist] [extra file …]
// Extra files (e.g. apps/web's generated _headers) are scanned too. Prints every file checked, then the problems.
// Exit 0 = clean, 1 = problems. Owner: cart.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cartOffProblems } from '../integrations/cart-off-scan.mjs';

const here = fileURLToPath(new URL('..', import.meta.url));
const [distArg, ...extra] = process.argv.slice(2);
const dist = resolve(distArg ?? join(here, 'dist'));
const walk = (d) => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
const files = walk(dist).map((f) => relative(dist, f).split(sep).join('/')).sort();
const problems = cartOffProblems(files, (f) => readFileSync(join(dist, f), 'utf8'));
for (const x of extra) {
  const abs = resolve(x);
  problems.push(...cartOffProblems([abs.split(sep).pop() ?? x], () => readFileSync(abs, 'utf8')).map((p) => `${abs}: ${p}`));
}
const html = files.filter((f) => f.endsWith('.html'));
console.log(`dist: ${dist}`);
console.log(`files: ${files.length} (html ${html.length}, js ${files.filter((f) => f.endsWith('.js')).length}, json ${files.filter((f) => f.endsWith('.json')).length}); extra: ${extra.join(', ') || 'none'}`);
for (const f of files) console.log(`  checked ${f}`);
console.log(problems.length ? `PROBLEMS (${problems.length}):\n${problems.map((p) => `  ${p}`).join('\n')}` : 'OK: no cart file, cart UI or reference to cart code');
process.exit(problems.length ? 1 : 0);
