import { HttpError } from "./database.ts";
import { isLocalDevelopment, verifyAccessIdentity, type AccessEnv } from "./trainingAuthorization.ts";

type StudentAuthorizationEnv = AccessEnv & { ADMIN_EMAIL?: string };
const HTTP_FORBIDDEN = 403;

export async function canDeleteStudents(request: Request, env: StudentAuthorizationEnv): Promise<boolean> {
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

export async function requireStudentDeletionAuthorization(request: Request, env: StudentAuthorizationEnv) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new HttpError(HTTP_FORBIDDEN, "A same-origin browser request is required.");
  }
  if (!await canDeleteStudents(request, env)) {
    throw new HttpError(HTTP_FORBIDDEN, "Only the administrator signed in with Cloudflare Access can delete students.");
  }
}
