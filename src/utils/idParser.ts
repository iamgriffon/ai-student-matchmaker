import { z } from "zod";

const userIdSchema = z.uuid().brand<"UserId">();
export type UserId = z.infer<typeof userIdSchema>;

export function parseId(value: string): UserId {
  return userIdSchema.parse(value.trim().toLowerCase());
}
