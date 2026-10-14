import { createRemoteJWKSet, jwtVerify } from "jose";
import { HttpError } from "./database.ts";

export type AccessEnv = { ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; LOCAL_DEVELOPMENT?: string };
const HTTP_FORBIDDEN = 403;
const HTTP_UNAVAILABLE = 503;
const ACCESS_COOKIE_PREFIX = "CF_Authorization=";

export async function requireTrainingAuthorization(request: Request, env: AccessEnv) {
  const url = new URL(request.url);
  // This flag is injected only by the loopback-bound local dev launcher.
  if (env.LOCAL_DEVELOPMENT === "true" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    if (request.headers.get("origin") !== url.origin) throw new HttpError(HTTP_FORBIDDEN, "A same-origin browser request is required.");
    return;
  }
  await verifyAccessIdentity(request, env);
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
