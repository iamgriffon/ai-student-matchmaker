import type { Char } from "@prisma/orm-postgres/target/codec-types";
import { z } from "zod";

const USER_ID_LENGTH = 36;
export type UserId = Char<typeof USER_ID_LENGTH>;

export function parseId(value: string): UserId {
  const id = z.uuid().parse(value.trim()).toLowerCase();
  // O contrato armazena UUIDs em character(36). O cast adiciona a marca
  // exigida pelo Prisma somente depois da validação do UUID.
  return id as UserId;
}
