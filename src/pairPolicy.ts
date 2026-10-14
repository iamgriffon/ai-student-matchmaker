import { DEFAULT_CATEGORY_WEIGHTS, type CategoryWeights } from "./categoryWeights.ts";
export const PAIR_POLICY_VERSION = "pair-policy-v1";

const PAIR_FEATURE_COUNT = 4;
const DEFAULT_MAX_IMBALANCE = 0.1;
const FLOAT_COMPARISON_TOLERANCE = 1e-6;
const MIN_NORMALIZED_VALUE = 0;
const MAX_NORMALIZED_VALUE = 1;


export type PairFeatures = readonly [
  imbalance: number,
  academicGap: number,
  incomeDistance: number,
  disabilityDifference: number,
];

export function readPairFeatures(values: readonly number[]): PairFeatures {
  const [imbalance, academicGap, incomeDistance, disabilityDifference] = values;
  if (
    values.length !== PAIR_FEATURE_COUNT ||
    typeof imbalance == 'undefined' ||
    typeof academicGap == 'undefined' ||
    typeof incomeDistance == 'undefined' ||
    typeof disabilityDifference == 'undefined' ||
    !values.every(Number.isFinite)
  ) {
    throw new Error(`O vetor da dupla deve ter ${PAIR_FEATURE_COUNT} valores finitos`);
  }
  return [imbalance, academicGap, incomeDistance, disabilityDifference];
}

// Função que avalia uma dupla de alunos com base em suas características.
// Retorna um objeto com a pontuação e indicadores de elegibilidade.
export function evaluatePair(
  features: PairFeatures,
  maxImbalance = DEFAULT_MAX_IMBALANCE,
  categoryWeights: CategoryWeights = DEFAULT_CATEGORY_WEIGHTS,
) {
  // Early throw para dados invalidos
  if (!Number.isFinite(maxImbalance) || maxImbalance <= MIN_NORMALIZED_VALUE) {
    throw new Error("A tolerância deve ser positiva");
  }

  const [
    imbalance, // Distância entre a média da dupla e a média da turma
    academicGap, // Diferença entre as notas dos alunos
    incomeDistance, // Distância entre os salários dos alunos
    disabilityDifference, // Diferença entre os indicadores PCD dos alunos
  ] = features;

  // As notas estão divididas por 100. (valor maximo)
  // Tolerância 0.1 =  permite até 10 pontos de diferença
  // entre a média da dupla e a média da turma.
  // Margem apenas para arredondamento numérico.
  const eligible = imbalance <= maxImbalance + FLOAT_COMPARISON_TOLERANCE;

  // Converte distância em preferência:
  // média perfeitamente equilibrada -> 1;
  // média no limite da tolerância -> 0.
  const balance = Math.max(
    MIN_NORMALIZED_VALUE,
    MAX_NORMALIZED_VALUE - imbalance / maxImbalance,
  );

  // Pesos iniciais de uma política explícita.
  // Ainda não foram aprendidos nem validados com resultados reais.
  const score =
    categoryWeights.balance * balance +
    categoryWeights.incomeDistance * incomeDistance +
    categoryWeights.disabilityDifference * disabilityDifference;

  return {
    eligible,
    score,
    // Guardamos os critérios para explicar a recomendação.
    metrics: {
      imbalance,
      academicGap,
      incomeDistance,
      disabilityDifference,
    },
  };
}

