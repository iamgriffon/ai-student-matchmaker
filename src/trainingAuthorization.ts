import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "./database.ts";

export type AccessEnv = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; LOCAL_DEVELOPMENT?: string; ADMIN_EMAIL?: string };
const HTTP_FORBIDDEN = 403;
const HTTP_UNAVAILABLE = 503;
const ACCESS_COOKIE_PREFIX = "CF_Authorization=";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLocalDevelopment(request: Request, env: AccessEnv): boolean {
  return env.LOCAL_DEVELOPMENT === "true" && LOCAL_HOSTNAMES.has(new URL(request.url).hostname);
}

export async function requireTrainingAuthorization(request: Request, env: AccessEnv) {
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new HttpError(HTTP_FORBIDDEN, "A same-origin browser request is required.");
  if (!await canManageTraining(request, env)) throw new HttpError(HTTP_FORBIDDEN, "Only the administrator signed in with Cloudflare Access can manage training.");
}

export async function canManageTraining(request: Request, env: AccessEnv): Promise<boolean> {
  if (isLocalDevelopment(request, env)) return true;
  if (!env.ADMIN_EMAIL?.trim()) return false;
  try {
    const identity = await verifyAccessIdentity(request, env);
    return typeof identity.email === "string"
      && identity.email.trim().toLowerCase() === env.ADMIN_EMAIL.trim().toLowerCase();
  } catch {
    return false;
  }
}

export async function verifyAccessIdentity(request: Request, env: AccessEnv) {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    throw new HttpError(HTTP_UNAVAILABLE, "Configure the Cloudflare Access team domain and application audience.");
  }
  const issuer = new URL(env.ACCESS_TEAM_DOMAIN).origin;
  const token = request.headers.get("cf-access-jwt-assertion") ?? request.headers.get("cookie")
    ?.split(";").map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(ACCESS_COOKIE_PREFIX))?.slice(ACCESS_COOKIE_PREFIX.length);
  if (!token) throw new HttpError(HTTP_FORBIDDEN, "Sign in with Cloudflare Access to manage training.");
  // Keep network work within this request; never trust an unverified cookie or header.
  const keys = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer));
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer, audience: env.ACCESS_AUD, algorithms: ["RS256"], requiredClaims: ["exp", "iat", "aud", "iss"],
    });
    return payload;
  } catch {
    throw new HttpError(HTTP_FORBIDDEN, "Your Cloudflare Access session could not be verified. Sign in again.");
  }
}
