import { createHash } from "node:crypto";

const VALIDATION_STRIDE = 5;
const VALIDATION_REMAINDER = 0;

export function splitStudentIds(ids: readonly string[]) {
  const sorted = [...new Set(ids)].map((id) => ({
    id, hash: createHash("sha256").update(id).digest("hex"),
  })).sort((a, b) => a.hash.localeCompare(b.hash) || a.id.localeCompare(b.id));
  const trainingIds = new Set<string>();
  const validationIds = new Set<string>();
  sorted.forEach(({ id }, index) => {
    (index % VALIDATION_STRIDE === VALIDATION_REMAINDER ? validationIds : trainingIds).add(id);
  });
  return { trainingIds, validationIds };
}

export function splitPairsByStudent<T extends { userAId: string; userBId: string }>(
  rows: readonly T[], ids: ReturnType<typeof splitStudentIds>,
) {
  const training: T[] = [];
  const validation: T[] = [];
  let excludedCount = 0;
  for (const row of rows) {
    if (ids.trainingIds.has(row.userAId) && ids.trainingIds.has(row.userBId)) training.push(row);
    else if (ids.validationIds.has(row.userAId) && ids.validationIds.has(row.userBId)) validation.push(row);
    else excludedCount++;
  }
  // Duplas que cruzam os grupos ficam fora: nenhum aluno pode estar nos dois conjuntos.
  return { training, validation, excludedCount };
}
