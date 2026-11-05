// Minimal typing for the one node:crypto API used here (available in workerd via nodejs_compat).
// Full @types/node in the Worker tsconfig conflicts with @cloudflare/workers-types (URL, streams).
declare module 'node:crypto' {
  interface Hash {
    update(data: string | Uint8Array): Hash;
    digest(encoding: 'hex'): string;
  }
  export function createHash(algorithm: 'sha256'): Hash;
}
