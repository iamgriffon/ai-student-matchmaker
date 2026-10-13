import { createHash } from "node:crypto";

const CONTEXT_HASH_ALGORITHM = "sha256";
const CONTEXT_HASH_ENCODING = "hex";

export type ContextVersionInput = {
  encoderVersion: string;
  students: readonly {
    userId: string;
    features: { score: number; income: number; disability: number };
  }[];
  cohortMeanScore: number;
  incomeScale: { minLogIncome: number; maxLogIncome: number };
};

export function createContextVersion(context: ContextVersionInput): string {
  const encoderVersion = context.encoderVersion.trim();
  if (!encoderVersion) throw new Error("A versão do encoder é obrigatória");

  const { minLogIncome, maxLogIncome } = context.incomeScale;
  const students = context.students
    .map(({ userId, features }) => ({
      userId,
      // A ordem das propriedades faz parte da serialização canônica.
      score: features.score,
      income: features.income,
      disability: features.disability,
    }))
    .sort((a, b) => a.userId.localeCompare(b.userId));

  const numericValues = [context.cohortMeanScore, minLogIncome, maxLogIncome];
  if (
    !numericValues.every(Number.isFinite) ||
    !students.every((student) =>
      [student.score, student.income, student.disability].every(Number.isFinite),
    )
  ) {
    // JSON transformaria NaN e Infinity em null, escondendo um contexto inválido.
    throw new Error("O contexto deve conter apenas características numéricas finitas");
  }

  // Nomes, e-mails, descontos e timestamps não alteram o vetor da dupla.
  // Pesos de ranking também ficam fora: podemos reavaliar o mesmo vetor.
  const snapshot = JSON.stringify({
    encoderVersion,
    students,
    cohortMeanScore: context.cohortMeanScore,
    incomeScale: { minLogIncome, maxLogIncome },
  });
  return createHash(CONTEXT_HASH_ALGORITHM).update(snapshot).digest(CONTEXT_HASH_ENCODING);
}
