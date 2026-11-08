// Loaders for the normalised geo data (Node only; the storefront gets build.mjs output instead).
import { readFileSync } from 'node:fs';

const load = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));

/** All 69 wilayas, sorted by code. */
export const loadWilayas = () => load('./wilayas.json');
/** All 1,541 communes, sorted by id. */
export const loadCommunes = () => load('./communes.json');
