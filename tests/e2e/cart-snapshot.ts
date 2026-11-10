// CART-5: writes the seed catalogue snapshot with settings.cartEnabled set, for a cart-off (or on) build.
// Usage: node tests/e2e/cart-snapshot.ts <out.json> <on|off>   (generatedAt from SOURCE_DATE_EPOCH, like HB_SNAPSHOT=seed)
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromSeed } from '../../packages/catalog/src/sources.ts';

const [out, mode] = process.argv.slice(2);
if (!out || (mode !== 'on' && mode !== 'off')) throw new Error('usage: node tests/e2e/cart-snapshot.ts <out.json> <on|off>');
const s = await fromSeed(fileURLToPath(new URL('../..', import.meta.url)));
writeFileSync(out, JSON.stringify({ ...s, settings: { ...s.settings, cartEnabled: mode === 'on' } }));
console.log(`${out}: seed snapshot, cartEnabled=${mode === 'on'}, ${s.products.length} products`);
