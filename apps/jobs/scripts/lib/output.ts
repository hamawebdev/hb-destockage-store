// Picking the useful line out of a failed command's output (publish pipeline, JOBS-8).

/**
 * The last error-looking line that is not npm's lifecycle trailer or a stack frame: for a failed
 * storefront build that is e.g. "catalogue pre-build failed (exit 2) …", not
 * "npm error command sh -c astro build". Falls back to the last line.
 */
export function errorLine(out: string): string {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const useful = lines.filter((l) => !/^npm (error|ERR!)/.test(l) && !/^at /.test(l) && /error|failed|refused|✘/i.test(l));
  return useful.at(-1) ?? lines.at(-1) ?? '';
}
