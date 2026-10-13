import * as tf from "@tensorflow/tfjs";
import { connectDatabase } from "../db/db.ts";
import { createContext, encodePair } from "./vectors.ts";
import { parseId } from "./utils/idParser.ts";
import { getPairVectorsForUser, savePairVectors, type PairVectorInput } from "../db/pairVectors.ts";
import { evaluatePair, readPairFeatures } from "./pairPolicy.ts";
import { rankWithTrainedModel } from "./pairRanker.ts";
import { getStartedPairPartners } from "../db/pairOutcomes.ts";

export { evaluatePair } from "./pairPolicy.ts";

const DEFAULT_RECOMMENDATION_LIMIT = 5;
const MIN_RECOMMENDATION_LIMIT = 1;
const MAX_RECOMMENDATION_LIMIT = 100;
const MAX_EXAM_SCORE = 100;

export class StudentNotFoundError extends Error {
  constructor() {
    super("Aluno não encontrado");
    this.name = "StudentNotFoundError";
  }
}


export async function recommendPartners(userId: string, limit = DEFAULT_RECOMMENDATION_LIMIT) {
  const id = parseId(userId);
  if (
    !Number.isInteger(limit) ||
    limit < MIN_RECOMMENDATION_LIMIT ||
    limit > MAX_RECOMMENDATION_LIMIT
  ) {
    throw new Error(`O limite deve ser um inteiro entre ${MIN_RECOMMENDATION_LIMIT} e ${MAX_RECOMMENDATION_LIMIT}`);
  }

  await connectDatabase();

  // Uma consulta prepara todos os alunos com a mesma escala de renda
  // e a mesma média da turma. Isso torna as duplas comparáveis.
  const context = await createContext();

  try {
    const selected = context.students.find(
      (student) => student.userId === id,
    );

    if (typeof selected == 'undefined') {
      throw new StudentNotFoundError();
    }

    // Os dados usados para exibir o parceiro vêm do mesmo conjunto
    // usado para calcular suas características.
    const usersById = new Map(context.users.map((user) => [user.id, user]));
    const startedPartners = await getStartedPairPartners(selected.userId);
    const storedPairs = await getPairVectorsForUser(selected.userId, context.contextVersion);
    const storedByPartner = new Map(storedPairs
      .filter((pair) => pair.contextVersion === context.contextVersion &&
        (pair.userAId === selected.userId || pair.userBId === selected.userId))
      .map((pair) => [pair.userAId === selected.userId ? pair.userBId : pair.userAId, pair]));
    let reusedCount = 0;
    const calculatedPairs: PairVectorInput[] = [];

    const evaluatedPairs = context.students
      // Um aluno não pode ser recomendado para si mesmo.
      .filter((candidate) => candidate.userId !== selected.userId)
      .map((candidate) => {
        const stored = storedByPartner.get(candidate.userId);
        const values = typeof stored == 'undefined' ? tf.tidy(() => {
          const tensor = encodePair(
            selected.features,
            candidate.features,
            context.cohortMeanScore,
          );

          // arraySync() copia os valores para um array JavaScript.
          // O tidy libera o tensor; o array continua disponível.
          // Não colocamos operações assíncronas dentro do tidy.
          return tensor.arraySync();
        }) : Array.from(stored.vector);

        const features = readPairFeatures(values);
        if (typeof stored == 'undefined') {
          calculatedPairs.push({ userAId: selected.userId, userBId: candidate.userId, vector: features });
        } else {
          reusedCount += 1;
        }
        const evaluation = evaluatePair(features);
        const partner = usersById.get(candidate.userId);

        if (typeof partner == 'undefined') {
          throw new Error("Dados do candidato não encontrados");
        }

        return {
          partner: {
            id: partner.id,
            name: partner.name,
            score: partner.score,
            income: partner.income,
            disability: partner.disability,
          },

          // Mesma ordem de características usada pela persistência em PairVectors.
          features,
          outcomeId: startedPartners.get(candidate.userId) ?? null,

          // Inclui elegibilidade, score e critérios explicativos.
          ...evaluation,
        };
      });

    // Salvamos somente vetores ausentes no contexto atual, inclusive inelegíveis.
    await savePairVectors(calculatedPairs, context.contextVersion);
    const inference = await rankWithTrainedModel(evaluatedPairs.map((pair) => pair.features));
    const scoredPairs = evaluatedPairs.map((pair, index) => ({
      ...pair,
      policyScore: pair.score,
      score: inference?.scores[index] ?? pair.score,
    }));

    const eligiblePairs = scoredPairs.filter(
      (pair) => pair.eligible,
    );

    const recommendations = eligiblePairs
      .sort(
        (a, b) =>
          b.score - a.score ||
          // Desempate estável: evita mudanças arbitrárias na ordem.
          a.partner.id.localeCompare(b.partner.id),
      )
      .slice(0, limit);

    return {
      userId: selected.userId,
      selectedScore: selected.features.score * MAX_EXAM_SCORE,
      contextVersion: context.contextVersion,

      // Voltamos à escala de 0–100 para exibição no frontend.
      cohortMeanScore: context.cohortMeanScore * MAX_EXAM_SCORE,

      evaluatedCount: evaluatedPairs.length,
      reusedCount,
      calculatedCount: calculatedPairs.length,
      rankingSource: inference ? "trained-policy-model" : "policy",
      canStartPairs: inference !== null,
      model: inference?.metadata ?? null,
      eligibleCount: eligiblePairs.length,
      recommendations,
    };
  } finally {
    // createContext() também produz a matriz dos vetores individuais.
    // Ela precisa ser liberada mesmo se a recomendação falhar.
    context.studentVectors.dispose();
  }
}
