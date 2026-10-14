import { z } from "zod";

export const userCreationSchema = z.object({
  name: z.string().trim().min(1, "Name is required"),
  email: z.email("Enter a valid email address"),
  age: z.number().int().min(16).max(80),
  score: z.number().int().min(0).max(100),
  income: z.string().trim().min(1, "Income is required"),
  disability: z.boolean(),
});

export type ZodUser = z.infer<typeof userCreationSchema>;
