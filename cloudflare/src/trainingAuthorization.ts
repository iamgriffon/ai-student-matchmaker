import { timingSafeEqual } from "node:crypto";
import { HttpError } from "./database.ts";

type TrainingAuthorizationEnv = Env & { TRAINING_ADMIN_TOKEN?: string };
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;

export function requireTrainingAuthorization(request: Request, env: TrainingAuthorizationEnv) {
  const token = env.TRAINING_ADMIN_TOKEN;
  // Missing configuration never makes the training endpoint public.
  if (typeof token == 'undefined' || !token.trim()) {
    throw new HttpError(HTTP_UNAVAILABLE, "Configure TRAINING_ADMIN_TOKEN before starting training.");
  }
  const expected = Buffer.from(`Bearer ${token}`);
  const provided = Buffer.from(request.headers.get("authorization") ?? "");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new HttpError(HTTP_UNAUTHORIZED, "Invalid training access key.");
  }
}
