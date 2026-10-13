import { mock } from "bun:test";
import { parseId, type UserId } from "../../../src/utils/idParser.ts";
import { PAIR_RANKER_KIND } from "../../../src/modelConfig.ts";
import { rankerArtifactSchema } from "../../validators/trainedModels.ts";

const FIXTURE_WEIGHT_COUNT = 5;
const FLOAT32_BYTES = 4;
export const trainedArtifactFixture = rankerArtifactSchema.parse({
  metadata: {
    modelId: "pair-ranker-aaaaaaaaaaaa", encoderVersion: "pair-v1", policyVersion: "pair-policy-v1",
    labelSource: "policy-generated", sourceContextVersion: "fixture-context", trainedAt: "2026-10-13T18:00:00.000Z",
    sampleCount: 40, trainingCount: 32, validationCount: 8, epochs: 2, learningRate: 0.001,
    validationStrategy: "student-disjoint", validationMeanAbsoluteError: 0.01, eligibleValidationMeanAbsoluteError: 0.01,
  },
  modelTopology: {
    class_name: "Sequential", keras_version: "tfjs-layers 4.22.0", backend: "tensor_flow.js",
    config: { name: "fixture-model", layers: [{ class_name: "Dense", config: {
      name: "fixtureDense", units: 1, activation: "linear", use_bias: true, trainable: true, batch_input_shape: [null, 4], dtype: "float32",
      kernel_initializer: { class_name: "VarianceScaling", config: { scale: 1, mode: "fan_avg", distribution: "uniform", seed: 17 } },
      bias_initializer: { class_name: "Zeros", config: {} },
    } }] },
  },
  weightSpecs: [{ name: "fixtureDense/kernel", shape: [4, 1], dtype: "float32" }, { name: "fixtureDense/bias", shape: [1], dtype: "float32" }],
  weightData: Buffer.alloc(FIXTURE_WEIGHT_COUNT * FLOAT32_BYTES).toString("base64"),
});
export const trainingReportFixture = {
  modelId: trainedArtifactFixture.metadata.modelId, labelSource: "policy-generated", validationStrategy: "student-disjoint",
  architecture: [4, 1], epochs: 2, trainingStudents: 8, validationStudents: 2,
  trainingPairs: 32, validationPairs: 8, excludedCrossGroupPairs: 10,
  comparisons: [{ learningRate: 0.001, validationMeanAbsoluteError: 0.01, eligibleValidationMeanAbsoluteError: 0.01 }],
  lossHistory: [{ epoch: 1, loss: 0.02 }, { epoch: 2, loss: 0.01 }],
};
export type DbTrainedModelFixture = {
  id: UserId; modelId: string; kind: string; activeKey: string | null;
  artifact: unknown; trainingReport: unknown; createdAt: string; updatedAt: string;
};
export const trainedModelFixture: DbTrainedModelFixture = {
  id: parseId("00000000-0000-4000-8000-000000000050"),
  modelId: trainedArtifactFixture.metadata.modelId, kind: PAIR_RANKER_KIND, activeKey: PAIR_RANKER_KIND,
  artifact: trainedArtifactFixture, trainingReport: trainingReportFixture,
  createdAt: "2026-10-13T18:00:01.000Z", updatedAt: "2026-10-13T18:00:01.000Z",
};
export function createTrainedModelsMock() {
  const trainedAll = mock(async (): Promise<DbTrainedModelFixture[]> => [structuredClone(trainedModelFixture)]);
  const trainedFirst = mock(async (): Promise<DbTrainedModelFixture | null> => structuredClone(trainedModelFixture));
  const trainedPointer = mock(async (): Promise<{ id: UserId; updatedAt: string } | null> => null);
  const trainedCreate = mock(async (input: { modelId: string; kind: string; artifact: unknown; trainingReport: unknown; activeKey: string | null }): Promise<DbTrainedModelFixture> => ({ ...structuredClone(trainedModelFixture), ...input }));
  const trainedUpdate = mock(async (_values: unknown) => undefined);
  const trainedUpdateAll = mock(async (_values: unknown) => []);
  const trainedDelete = mock(async (): Promise<DbTrainedModelFixture | null> => structuredClone(trainedModelFixture));
  const trainedIdEq = mock((_value: string) => true);
  const trainedModelIdEq = mock((_value: string) => true);
  const trainedActiveEq = mock((_value: string) => true);
  const trainedDesc = mock(() => true);
  const fields = { id: { eq: trainedIdEq, desc: trainedDesc }, modelId: { eq: trainedModelIdEq }, activeKey: { eq: trainedActiveEq }, createdAt: { desc: trainedDesc } };
  type Query = { all: typeof trainedAll; first: typeof trainedFirst; where: (predicate: (values: typeof fields) => unknown) => Query; orderBy: (order: unknown) => Query; limit: (limit: number) => Query; update: typeof trainedUpdate; updateAll: typeof trainedUpdateAll; delete: typeof trainedDelete };
  const trainedWhere = mock((predicate: (values: typeof fields) => unknown): Query => { predicate(fields); return query; });
  const trainedOrderBy = mock((_order: unknown): Query => query);
  const trainedLimit = mock((_limit: number): Query => query);
  const query: Query = { all: trainedAll, first: trainedFirst, where: trainedWhere, orderBy: trainedOrderBy, limit: trainedLimit, update: trainedUpdate, updateAll: trainedUpdateAll, delete: trainedDelete };
  const trainedSelect = mock((..._fields: string[]) => ({ where: (predicate: (values: typeof fields) => unknown) => { predicate(fields); return { first: trainedPointer }; } }));
  const mocks = { trainedAll, trainedFirst, trainedPointer, trainedCreate, trainedUpdate, trainedUpdateAll, trainedDelete, trainedIdEq, trainedModelIdEq, trainedActiveEq, trainedDesc, trainedWhere, trainedOrderBy, trainedLimit, trainedSelect };
  function reset() {
    for (const fn of Object.values(mocks)) fn.mockClear();
    trainedAll.mockReset().mockImplementation(async () => [structuredClone(trainedModelFixture)]);
    trainedFirst.mockReset().mockImplementation(async () => structuredClone(trainedModelFixture));
    trainedPointer.mockReset().mockImplementation(async () => null);
    trainedCreate.mockReset().mockImplementation(async (input) => ({ ...structuredClone(trainedModelFixture), ...input }));
    trainedUpdate.mockReset().mockImplementation(async () => undefined);
    trainedUpdateAll.mockReset().mockImplementation(async () => []);
    trainedDelete.mockReset().mockImplementation(async () => structuredClone(trainedModelFixture));
  }
  return { table: { ...query, create: trainedCreate, select: trainedSelect }, mocks, reset };
}
