// <Copy>: placeholder markers become a dev pill that takes the page direction, marker first.
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterEach, describe, expect, test } from 'vitest';
import Copy from '../src/components/Copy.astro';

const strings = { 'dev.placeholder': '[PLACEHOLDER]', k: 'Horaires 9 h [PLACEHOLDER]' };

describe('Copy', async () => {
  const c = await AstroContainer.create();
  afterEach(() => {
    delete process.env['HB_STRICT_COPY'];
  });
  test('plain text renders as is', async () => {
    expect(await c.renderToString(Copy, { props: { strings, text: 'Bonjour' } })).toContain('Bonjour');
  });
  test('noted marker: span pill (inherits dir), marker isolated LTR first, note isolated after', async () => {
    const html = await c.renderToString(Copy, { props: { strings, text: 'المدة [PLACEHOLDER: في انتظار التأكيد]' } });
    expect(html).toMatch(/data-placeholder="text"/);
    expect(html).toMatch(/<span class="dev-ph"><bdi dir="ltr">\[PLACEHOLDER\]<\/bdi>: <bdi>في انتظار التأكيد<\/bdi><\/span>/);
    expect(html).not.toMatch(/<bdi class="dev-ph"/);
  });
  test('key form: marker stripped from the text, pill added', async () => {
    const html = await c.renderToString(Copy, { props: { strings, k: 'k' } });
    expect(html).toContain('Horaires 9 h');
    expect(html).toMatch(/data-placeholder="k"/);
  });
  test('strict build refuses both forms', async () => {
    process.env['HB_STRICT_COPY'] = '1';
    await expect(c.renderToString(Copy, { props: { strings, text: 'x [PLACEHOLDER: y]' } })).rejects.toThrow(/placeholder/);
    await expect(c.renderToString(Copy, { props: { strings, k: 'k' } })).rejects.toThrow(/placeholder/);
  });
});
