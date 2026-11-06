// Every class that client JS (public/js/*.js) adds or tests at runtime must survive the CSS trim,
// even when no page's HTML contains it (lead requirement on the trim, BUG-12).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { knownClasses, runtimeClassesIn, trimUnusedRules } from '../integrations/postbuild-core.mjs';

const dir = fileURLToPath(new URL('../public/js/', import.meta.url));
const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
const jsText = files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

describe('runtime classes from public/js survive the trim', () => {
  test('there is client JS to check', () => expect(files.length).toBeGreaterThan(0));
  const runtime = [...runtimeClassesIn(jsText)];
  test('runtime classes are found', () => expect(runtime.length).toBeGreaterThan(0));
  test.each(runtime)('.%s is kept with an empty HTML class set', (c) => {
    const css = `.${c}{color:red}.${c}:hover{color:blue}`;
    expect(trimUnusedRules(css, knownClasses(new Set(), jsText))).toBe(css);
  });
});

test('runtimeClassesIn reads classList, className and class="…"', () => {
  const js = `el.classList.add('is-a', "is-b");el.classList.toggle('is-c', x);el.className = 'x-d x-e';h.innerHTML = '<p class="x-f x-g">'`;
  expect([...runtimeClassesIn(js)].sort()).toEqual(['is-a', 'is-b', 'is-c', 'x-d', 'x-e', 'x-f', 'x-g']);
});
