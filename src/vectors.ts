import * as tf from "@tensorflow/tfjs";
import { listUsers, type StarterUser } from "../db/users";
import { parseIncome } from "./utils/incomeParser";
import { createContextVersion } from "./utils/contextVersion.ts";

// Incremente esta versão se mudar as escalas, a ordem ou o significado
// das características dos encoders individual e de dupla.
import { PAIR_ENCODER_VERSION } from "./vectorSchema.ts";
export { PAIR_ENCODER_VERSION } from "./vectorSchema.ts";

// Os encoders esperam nota e renda já transformadas para escalas comparáveis,
// e PCD representado por 0 ou 1. O tipo number não garante a escala nem valida os dados.
// Apesar do nome, nota e renda são características numéricas, não categorias one-hot.
type StudentCategoricalFeatures = {
  score: number;
  income: number;
  disability: number;
};

// Cada aluno vira um tensor [3], com ordem fixa: [nota, renda, PCD].
// A mesma ordem deve ser usada no treinamento e na recomendação.
// Preservamos as características; os pesos entrarão na avaliação dos critérios.
// Quem chamar o encoder deve liberar o tensor com dispose() ou usar tf.tidy().
const encodeStudent = (student: StudentCategoricalFeatures): tf.Tensor1D =>
  tf.tensor1d([
    student.score,
    student.income,
    student.disability,
  ]);

// Descreve a relação entre dois alunos em um tensor [4]. A+B e B+A geram o mesmo
// vetor, pois médias e diferenças absolutas não dependem da ordem dos integrantes.
// cohortMeanScore precisa estar na mesma escala das notas dos dois alunos.
// O vetor ainda não é uma previsão de sucesso. O chamador deve liberar esse tensor.
export const encodePair = (
  a: StudentCategoricalFeatures,
  b: StudentCategoricalFeatures,
  cohortMeanScore: number,
): tf.Tensor1D => {
  const pairMeanScore = (a.score + b.score) / 2;

  return tf.tensor1d([
    // Menor = média da dupla mais próxima da turma; aproximação de equilíbrio acadêmico.
    Math.abs(pairMeanScore - cohortMeanScore),
    // Expõe diferenças acadêmicas grandes mesmo quando a média da dupla está equilibrada.
    Math.abs(a.score - b.score),
    // Maior = maior distância na renda transformada; um critério de diversidade social.
    Math.abs(a.income - b.income),
    // 1 se os indicadores diferem, 0 se são iguais; apenas uma dimensão de diversidade.
    Math.abs(a.disability - b.disability),
  ]);
};

// Reúne os dados e referências para preparar as características.
export const createContext = async () => createContextFromUsers(await listUsers());

// A versão síncrona também aceita o snapshot lido dentro de uma transação.
// Assim o cadastro e os vetores usam exatamente a mesma turma.
export const createContextFromUsers = (users: StarterUser[]) => {

  if (!users?.length) {
    throw new Error("Nenhum aluno disponível");
  }

  const preparedUsers = users.map((user) => {
    // Evita produzir tensores com NaN ou notas fora da escala do exame.
    if (
      !Number.isFinite(user.score) ||
      user.score < 0 ||
      user.score > 100
    ) {
      throw new Error(`Nota inválida para o aluno ${user.id}`);
    }

    // Informação ausente não deve virar automaticamente "não PCD".
    if (typeof user.disability !== "boolean") {
      throw new Error(`Indicador PCD ausente para o aluno ${user.id}`);
    }

    if (typeof user.income !== "string" || !user.income.trim()) {
      throw new Error(`Renda ausente para o aluno ${user.id}`);
    }

    // Atenção: o parser atual transforma strings inválidas em zero.
    // Este trecho pressupõe que o formato da renda foi validado no cadastro.
    const income = parseIncome(user.income);

    if (!Number.isFinite(income) || income < 0) {
      throw new Error(`Renda inválida para o aluno ${user.id}`);
    }

    return {
      id: user.id,
      score: user.score,
      income,
      disability: user.disability,
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  // log(1 + renda) aceita renda zero e comprime diferenças grandes.
  // Usamos a mesma transformação e os mesmos limites para todos os alunos.
  const logIncomes = preparedUsers.map((user) => Math.log1p(user.income));
  const minLogIncome = Math.min(...logIncomes);
  const maxLogIncome = Math.max(...logIncomes);

  const normalizeIncome = (income: number): number => {
    if (maxLogIncome === minLogIncome) return 0;

    return (
      (Math.log1p(income) - minLogIncome) /
      (maxLogIncome - minLogIncome)
    );
  };

  // Mantemos as características junto do ID.
  // Assim não dependemos de vários arrays paralelos para identificar um aluno.
  const students = preparedUsers.map((user) => ({
    userId: user.id,
    features: {
      score: user.score / 100,
      income: normalizeIncome(user.income),
      disability: user.disability ? 1 : 0,
    } satisfies StudentCategoricalFeatures,
  }));

  // Calculamos a média usando as notas já normalizadas.
  // Isso evita comparar uma média como 60 com um vetor cuja nota é 0,8.
  const cohortMeanScore =
    students.reduce((sum, student) => sum + student.features.score, 0) /
    students.length;

  // A ordenação por ID antes da redução também evita variações da média
  // causadas pela ordem de soma de números de ponto flutuante.
  const incomeScale = { minLogIncome, maxLogIncome };
  const contextVersion = createContextVersion({
    encoderVersion: PAIR_ENCODER_VERSION,
    students,
    cohortMeanScore,
    incomeScale,
  });

  const studentVectors = tf.tidy(() => {
    // Cada encoder produz [3].
    const individualVectors = students.map((student) =>
      encodeStudent(student.features),
    );

    // stack adiciona a dimensão dos alunos: [N, 3].
    // tidy libera os vetores individuais e preserva a matriz retornada.
    return tf.stack(individualVectors);
  });

  return {
    users,
    students,
    cohortMeanScore,
    contextVersion,
    studentVectors,

    // userIds[i] identifica a linha i da matriz.
    userIds: students.map((student) => student.userId),

    // Guardamos as referências para reproduzir a transformação de renda.
    incomeScale,
  };
};

if (import.meta.main) {
  const context = await createContext();
  let pairVector: tf.Tensor1D | undefined;

  try {
    // Uma linha por aluno; três colunas por linha.
    context.studentVectors.print();

    const a = context.students[0];
    const b = context.students[1];

    if (a && b) {
      // Os primeiros dois alunos são apenas um exemplo de codificação.
      // Ainda não estamos escolhendo a melhor dupla.
      pairVector = encodePair(
        a.features,
        b.features,
        context.cohortMeanScore,
      );

      console.log("Alunos da dupla:", a.userId, b.userId);

      // [desequilíbrio, diferença acadêmica, diferença de renda, diferença PCD]
      pairVector.print();
    }
  } finally {
    // Os tensores retornados continuam alocados até serem liberados.
    // finally executa a limpeza mesmo se ocorrer um erro durante o uso.
    pairVector?.dispose();
    context.studentVectors.dispose();
  }
}
