/**
 * A same-site path for redirects and links built from request data (return_to, Referer):
 * must start with a single "/", no "//" or "/\" (protocol-relative), no backslashes or
 * whitespace, ≤ 512 chars. Anything else → "/".
 */
export function safeReturnPath(p: string): string {
  return /^\/(?![/\\])[^\s\\]*$/.test(p) && p.length <= 512 ? p : '/';
}
