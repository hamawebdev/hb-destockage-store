// Cloudflare Access JWT verification (production identity).
//
// Input: only the `Cf-Access-Jwt-Assertion` header (the CF_Authorization cookie is ignored).
// Checks: RS256 only; signature against the team's JWKS (`<team>/cdn-cgi/access/certs`);
// iss = ACCESS_TEAM_DOMAIN exactly; aud contains ACCESS_AUD; exp/nbf with 60 s tolerance;
// iat/sub/email present; type = "app" (service tokens carry no email and are refused).
// Keys: jose createRemoteJWKSet, one per isolate and team domain: cached 10 min, an unknown
// `kid` triggers a refetch at most every 30 s (Access key rotation), 5 s fetch timeout.
// Outcomes: no header → 401; any token problem → 403; certs unreachable → 503 (fail closed).
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Context } from 'hono';
import type { AppEnv } from '../env.ts';
import type { IdentityResult } from './authenticate.ts';

export const ACCESS_JWT_HEADER = 'Cf-Access-Jwt-Assertion';
export const MAX_JWT_LENGTH = 8192;
export const CLOCK_TOLERANCE_S = 60;

const TEAM_RE = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const AUD_RE = /^[a-f0-9]{64}$/;
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const remoteSets = new Map<string, JWTVerifyGetKey>();

export function certsUrl(teamDomain: string): URL {
  return new URL('/cdn-cgi/access/certs', teamDomain);
}

function remoteKeys(teamDomain: string): JWTVerifyGetKey {
  let set = remoteSets.get(teamDomain);
  if (!set) {
    set = createRemoteJWKSet(certsUrl(teamDomain));
    remoteSets.set(teamDomain, set);
  }
  return set;
}

export interface AccessConfig {
  teamDomain: string;
  aud: string;
}

export function accessConfig(c: Context<AppEnv>): AccessConfig | null {
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
  const aud = c.env.ACCESS_AUD;
  return typeof teamDomain === 'string' && TEAM_RE.test(teamDomain) && typeof aud === 'string' && AUD_RE.test(aud)
    ? { teamDomain, aud }
    : null;
}

/** Key-resolution failures that mean "we could not check", not "the token is bad". */
function isUnavailable(err: unknown): boolean {
  if (err instanceof errors.JWKSTimeout || err instanceof errors.JWKSInvalid) return true;
  if (err instanceof errors.JOSEError) return false;
  return true; // network errors (TypeError from fetch), non-JSON certs, …
}

export async function verifyAccessJwt(
  token: string,
  cfg: AccessConfig,
  getKey: JWTVerifyGetKey = remoteKeys(cfg.teamDomain),
  currentDate?: Date,
): Promise<IdentityResult> {
  if (token.length > MAX_JWT_LENGTH || !JWT_SHAPE.test(token)) return { ok: false, status: 403 };
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, getKey, {
      algorithms: ['RS256'],
      issuer: cfg.teamDomain,
      audience: cfg.aud,
      clockTolerance: CLOCK_TOLERANCE_S,
      requiredClaims: ['exp', 'iat', 'sub', 'email'],
      ...(currentDate ? { currentDate } : {}),
    }));
  } catch (err) {
    return { ok: false, status: isUnavailable(err) ? 503 : 403 };
  }
  const email = payload['email'];
  if (payload['type'] !== 'app' || typeof email !== 'string' || !email.includes('@') || email.length > 254) {
    return { ok: false, status: 403 };
  }
  return { ok: true, email };
}
