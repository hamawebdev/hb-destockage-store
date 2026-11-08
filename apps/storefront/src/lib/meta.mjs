// Meta Pixel build settings (artifacts/META-0/contract.md §2.1). Pure, tested in test/meta-config.test.ts.
// Read at build time only; unset means the storefront ships nothing Meta-related at all.

/**
 * @param {Readonly<Record<string, string | undefined>>} env
 * @returns {{ pixelId: string, consent: 'required' | 'off' } | null} null = Meta is off
 */
export function metaBuildConfig(env) {
  const consent = (env['META_CONSENT_REQUIRED'] ?? '').trim();
  if (consent !== '' && consent !== '0' && consent !== '1') {
    throw new Error('META_CONSENT_REQUIRED must be 0 or 1, or unset (on)');
  }
  const pixelId = (env['META_PIXEL_ID'] ?? '').trim();
  if (pixelId === '') return null;
  if (!/^\d{15,16}$/.test(pixelId)) throw new Error('META_PIXEL_ID must be 15 or 16 digits');
  return { pixelId, consent: consent === '0' ? 'off' : 'required' };
}

/** The build's settings, read when called so tests can change the environment. */
export const metaConfig = () => metaBuildConfig(process.env);
