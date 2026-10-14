import type { RuntimeEnv as Env } from "./runtimeEnv.ts";
import { database } from "./database.ts";
import { latestTraining } from "./training.ts";
import { createTrainingStream } from "./training/progressStream.ts";

export function trainingStream(request: Request, env: Env) {
  const db = database(env);
  return createTrainingStream(request, () => latestTraining(env, db));
}
