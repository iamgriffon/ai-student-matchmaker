import { HttpError } from "./database.ts";

const HTTP_FORBIDDEN = 403;

export function requireTrainingAuthorization(ctx: ExecutionContext) {
  // Cloudflare creates this context only after Access authenticates this invocation.
  // A caller-supplied identity header is not sufficient authorization.
  if (typeof ctx.access == 'undefined') {
    throw new HttpError(HTTP_FORBIDDEN, "Sign in with Cloudflare Access to manage training.");
  }
}
