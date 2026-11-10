// The per-account courier webhook token (SHIP-0 contract rule 16). Shown once when generated; only
// its SHA-256 is stored. The public route rejects anything not shaped like a token before D1.

/** 32 random bytes, base64url without padding. */
export const WEBHOOK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newWebhookToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Lower-case hex SHA-256 of the token, the only form that is stored. */
export async function hashWebhookToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
