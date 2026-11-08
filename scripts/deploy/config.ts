// Parses a wrangler.jsonc (comments and trailing commas allowed) with the TypeScript parser.
import ts from 'typescript';

export function parseJsonc(path: string, text: string): unknown {
  const { config, error } = ts.parseConfigFileTextToJson(path, text);
  if (error) throw new Error(`cannot parse ${path}`);
  return config;
}
