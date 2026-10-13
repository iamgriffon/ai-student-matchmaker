import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import contract from "../generated/contract.json" with { type: "json" };
import { database } from "./fixtutes/db.fixtures.ts";
import { trainedArtifactFixture, trainedModelFixture, trainingReportFixture } from "./fixtutes/trainedModels.fixtures.ts";
import { PAIR_RANKER_KIND, MAX_VALIDATION_MAE } from "../../src/modelConfig.ts";
import { parseId } from "../../src/utils/idParser.ts";
import { parseModelPayload, rankerArtifactSchema, trainingReportSchema } from "../validators/trainedModels.ts";
const { getTrainedModels, getTrainedModelById, getTrainedModelByModelId, getActiveTrainedModel, saveTrainedModel, activateTrainedModel, deleteTrainedModel, caches, invalidateTrainedModelCaches, TRAINED_MODELS_CACHE_TTL_MS } = await import("../trainedModels.ts");

const ID = trainedModelFixture.id;
const OTHER_ID = parseId("00000000-0000-4000-8000-000000000051");
const MAX_LIST_LIMIT = 100;
const EXPIRY_MARGIN_MS = 1;
const FLOAT32_BYTES = 4;
const artifact = () => structuredClone(trainedArtifactFixture);
const row = () => structuredClone(trainedModelFixture);
const pointer = (value = trainedModelFixture) => ({ id: value.id, updatedAt: value.updatedAt });
beforeEach(() => { database.reset(); invalidateTrainedModelCaches(); });

describe("db/trainedModels", () => {
  describe("contract", () => {
    const table = contract.storage.namespaces.public.entries.table.TrainedModels;
    test("stores artifacts and reports as native JSONB", () => {
      expect(table.columns.artifact).toMatchObject({ codecId: "pg/jsonb@1", nullable: false });
      expect(table.columns.trainingReport).toMatchObject({ codecId: "pg/jsonb@1", nullable: true });
    });
    test("allows repeated weight identifiers while keeping an execution ID", () => {
      expect(table.primaryKey.columns).toEqual(["id"]);
      expect(table.uniques).not.toContainEqual({ columns: ["modelId"] });
      expect(table.indexes).toEqual(expect.arrayContaining([expect.objectContaining({ columns: ["modelId"] })]));
    });
    test("allows only one active execution per kind", () => {
      expect(table.uniques).toContainEqual({ columns: ["activeKey"] });
      expect(table.columns.activeKey.nullable).toBe(true);
      expect(table.checks).toEqual(expect.arrayContaining([expect.objectContaining({ expression: '"activeKey" IS NULL OR "activeKey" = "kind"' })]));
    });
    test("checks artifact identity and the report object", () => {
      expect(table.checks.some((check) => check.expression.includes("{metadata,modelId}"))).toBe(true);
      expect(table.checks.some((check) => check.expression.includes('jsonb_typeof("trainingReport")'))).toBe(true);
    });
  });
  describe("Zod payload validation", () => {
    test("parses a complete model and its report without losing TensorFlow config", () => {
      const parsed = parseModelPayload(artifact(), trainingReportFixture);
      expect(parsed.artifact).toEqual(trainedArtifactFixture);
      expect(parsed.trainingReport?.lossHistory).toEqual(trainingReportFixture.lossHistory);
    });
    test("supports models without a report", () => {
      expect(parseModelPayload(artifact()).trainingReport).toBeNull();
      expect(parseModelPayload(artifact(), null).trainingReport).toBeNull();
    });
    test.each(["", "invalid", "pair-ranker-xyz"])("rejects invalid model identifier %p", (modelId) => {
      const invalid = artifact(); invalid.metadata.modelId = modelId;
      expect(() => rankerArtifactSchema.parse(invalid)).toThrow();
    });
    test("rejects inconsistent sample totals and malformed dates", () => {
      const invalid = artifact(); invalid.metadata.sampleCount++;
      expect(() => rankerArtifactSchema.parse(invalid)).toThrow("amostras");
      invalid.metadata.sampleCount--; invalid.metadata.trainedAt = "yesterday";
      expect(() => rankerArtifactSchema.parse(invalid)).toThrow();
    });
    test("rejects invalid dimensions, activations and layer names", () => {
      const invalid = artifact();
      invalid.modelTopology.config.layers[0]!.config.units = 2;
      expect(() => rankerArtifactSchema.parse(invalid)).toThrow();
      const wrongActivation = artifact(); wrongActivation.modelTopology.config.layers[0]!.config.activation = "relu";
      expect(() => rankerArtifactSchema.parse(wrongActivation)).toThrow("saída linear");
      const wrongInput = artifact(); wrongInput.modelTopology.config.layers[0]!.config.batch_input_shape = [null, 3];
      expect(() => rankerArtifactSchema.parse(wrongInput)).toThrow("entradas");
    });
    test("rejects mismatched weight names, shapes and tensor counts", () => {
      const invalid = artifact(); invalid.weightSpecs[0]!.name = "wrong/kernel";
      expect(() => rankerArtifactSchema.parse(invalid)).toThrow("Kernel");
      invalid.weightSpecs[0]!.name = "fixtureDense/kernel"; invalid.weightSpecs[0]!.shape = [3, 1];
      expect(() => rankerArtifactSchema.parse(invalid)).toThrow("Kernel");
      invalid.weightSpecs.pop();
      expect(() => rankerArtifactSchema.parse(invalid)).toThrow("tensores");
    });
    test.each(["not-base64!", "AAAA", ""])("rejects invalid or truncated weight data %p", (weightData) => {
      expect(() => rankerArtifactSchema.parse({ ...artifact(), weightData })).toThrow();
    });
    test.each([NaN, Infinity, -Infinity])("rejects nonfinite weight %p", (value) => {
      const invalid = artifact(); const buffer = Buffer.from(invalid.weightData, "base64");
      buffer.writeFloatLE(value, FLOAT32_BYTES);
      invalid.weightData = buffer.toString("base64");
      expect(() => rankerArtifactSchema.parse(invalid)).toThrow("finitos");
    });
    test("rejects a non-JSON TensorFlow configuration", () => {
      const invalid = artifact(); Reflect.set(invalid.modelTopology.config.layers[0]!.config.kernel_initializer.config, "extra", undefined);
      expect(() => rankerArtifactSchema.parse(invalid)).toThrow();
    });
    test("rejects report identities, counts, architecture and epochs that disagree", () => {
      expect(() => parseModelPayload(artifact(), { ...trainingReportFixture, modelId: "pair-ranker-bbbbbbbbbbbb" })).toThrow("outro modelo");
      expect(() => parseModelPayload(artifact(), { ...trainingReportFixture, trainingPairs: 99 })).toThrow("amostras");
      expect(() => parseModelPayload(artifact(), { ...trainingReportFixture, architecture: [4, 8, 1] })).toThrow("arquitetura");
      expect(() => parseModelPayload(artifact(), { ...trainingReportFixture, epochs: 3 })).toThrow("épocas");
      expect(() => parseModelPayload(artifact(), { ...trainingReportFixture, validationStrategy: "pair-holdout" })).toThrow("estratégia");
    });
    test("rejects duplicate or unordered epoch histories", () => {
      expect(() => trainingReportSchema.parse({ ...trainingReportFixture, lossHistory: [{ epoch: 1, loss: 0.02 }, { epoch: 1, loss: 0.01 }] })).toThrow("ordem crescente");
      expect(() => trainingReportSchema.parse({ ...trainingReportFixture, lossHistory: [{ epoch: 2, loss: 0.02 }, { epoch: 1, loss: 0.01 }] })).toThrow("ordem crescente");
    });
    test("rejects malformed reports and epochs beyond the training", () => {
      expect(() => trainingReportSchema.parse({ ...trainingReportFixture, comparisons: [] })).toThrow();
      expect(() => parseModelPayload(artifact(), { ...trainingReportFixture, lossHistory: [{ epoch: 3, loss: 0.01 }] })).toThrow("Época");
      expect(() => trainingReportSchema.parse({ ...trainingReportFixture, trainingStudents: -1 })).toThrow();
    });
  });
  describe("queries", () => {
    test("lists executions in descending creation order", async () => {
      expect(await getTrainedModels()).toHaveLength(1);
      expect(database.mocks.trainedOrderBy).toHaveBeenCalledWith([expect.any(Function), expect.any(Function)]);
      expect(database.mocks.trainedLimit).not.toHaveBeenCalled();
    });
    test.each([1, MAX_LIST_LIMIT])("accepts boundary limit %p", async (limit) => {
      await getTrainedModels(limit);
      expect(database.mocks.trainedLimit).toHaveBeenCalledWith(limit);
    });
    test.each([0, -1, MAX_LIST_LIMIT + 1, 1.5, NaN, Infinity])("rejects invalid limit %p before connecting", async (limit) => {
      await expect(getTrainedModels(limit)).rejects.toThrow("limite");
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
    });
    test("queries an execution by a parsed Char<36> ID", async () => {
      expect((await getTrainedModelById(` ${ID} `))?.id).toBe(ID);
      expect(database.mocks.trainedIdEq).toHaveBeenCalledWith(ID);
    });
    test("queries the latest execution for a weights identifier", async () => {
      expect((await getTrainedModelByModelId(` ${trainedModelFixture.modelId} `))?.modelId).toBe(trainedModelFixture.modelId);
      expect(database.mocks.trainedModelIdEq).toHaveBeenCalledWith(trainedModelFixture.modelId);
      expect(database.mocks.trainedOrderBy).toHaveBeenCalled();
    });
    test("rejects invalid identifiers before connecting", async () => {
      await expect(getTrainedModelById("invalid")).rejects.toThrow();
      await expect(getTrainedModelByModelId("invalid")).rejects.toThrow();
      await expect(getActiveTrainedModel("invalid")).rejects.toThrow();
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
    });
    test("returns null or empty lists when records are absent", async () => {
      database.mocks.trainedFirst.mockResolvedValue(null); database.mocks.trainedAll.mockResolvedValue([]);
      expect(await getTrainedModelById(ID)).toBeNull();
      expect(await getTrainedModelByModelId(trainedModelFixture.modelId)).toBeNull();
      expect(await getTrainedModels()).toEqual([]);
      expect(await getActiveTrainedModel()).toBeNull();
    });
    test("validates JSONB on reads and does not cache invalid rows", async () => {
      database.mocks.trainedFirst.mockResolvedValueOnce({ ...row(), artifact: {} });
      await expect(getTrainedModelById(ID)).rejects.toThrow();
      expect((await getTrainedModelById(ID))?.id).toBe(ID);
      expect(database.mocks.trainedFirst).toHaveBeenCalledTimes(2);
    });
    test("rejects inconsistent row and artifact identifiers", async () => {
      database.mocks.trainedFirst.mockResolvedValueOnce({ ...row(), modelId: "pair-ranker-bbbbbbbbbbbb" });
      await expect(getTrainedModelById(ID)).rejects.toThrow("inconsistente");
    });
    test("propagates connection and query failures without caching them", async () => {
      database.mocks.connectDatabase.mockRejectedValueOnce(new Error("Connection failed"));
      await expect(getTrainedModels()).rejects.toThrow("Connection failed");
      database.mocks.trainedAll.mockRejectedValueOnce(new Error("Read failed"));
      await expect(getTrainedModels()).rejects.toThrow("Read failed");
      expect(await getTrainedModels()).toHaveLength(1);
    });
  });
  describe("cache", () => {
    test("caches lists and record lookups without exposing mutable references", async () => {
      const first = await getTrainedModels(); first[0]!.artifact.metadata.epochs = 99;
      expect((await getTrainedModels())[0]?.artifact.metadata.epochs).toBe(2);
      await getTrainedModelById(ID); await getTrainedModelById(ID);
      await getTrainedModelByModelId(trainedModelFixture.modelId); await getTrainedModelByModelId(trainedModelFixture.modelId);
      expect(database.mocks.trainedAll).toHaveBeenCalledTimes(1);
      expect(database.mocks.trainedFirst).toHaveBeenCalledTimes(2);
    });
    test("keeps list limits separate and supports an explicit fresh read", async () => {
      await getTrainedModels(); await getTrainedModels(1); await getTrainedModels(MAX_LIST_LIMIT);
      await getTrainedModels();
      expect(database.mocks.trainedAll).toHaveBeenCalledTimes(3);
      await getTrainedModels(undefined, { fresh: true });
      expect(database.mocks.trainedAll).toHaveBeenCalledTimes(4);
    });
    test("refreshes exactly at the one-hour TTL", async () => {
      const start = Date.now(); const clock = spyOn(Date, "now").mockReturnValue(start);
      try {
        await getTrainedModels(); clock.mockReturnValue(start + TRAINED_MODELS_CACHE_TTL_MS - EXPIRY_MARGIN_MS);
        await getTrainedModels(); expect(database.mocks.trainedAll).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(start + TRAINED_MODELS_CACHE_TTL_MS);
        await getTrainedModels(); expect(database.mocks.trainedAll).toHaveBeenCalledTimes(2);
      } finally { clock.mockRestore(); }
    });
    test("caches missing rows", async () => {
      database.mocks.trainedFirst.mockResolvedValue(null);
      await getTrainedModelById(ID); await getTrainedModelById(ID);
      expect(database.mocks.trainedFirst).toHaveBeenCalledTimes(1);
    });
    test("checks the active pointer every time while reusing the heavy JSONB", async () => {
      database.mocks.trainedPointer.mockResolvedValue(pointer());
      await getActiveTrainedModel(); await getActiveTrainedModel();
      expect(database.mocks.trainedSelect).toHaveBeenCalledWith("id", "updatedAt");
      expect(database.mocks.trainedPointer).toHaveBeenCalledTimes(2);
      expect(database.mocks.trainedFirst).toHaveBeenCalledTimes(1);
    });
    test("detects an activation from another process through the pointer", async () => {
      database.mocks.trainedPointer.mockResolvedValue(pointer()); await getActiveTrainedModel();
      const changed = { ...row(), id: OTHER_ID, updatedAt: "2026-10-13T19:00:00.000Z" };
      database.mocks.trainedPointer.mockResolvedValue(pointer(changed)); database.mocks.trainedFirst.mockResolvedValue(changed);
      expect((await getActiveTrainedModel())?.id).toBe(OTHER_ID);
      expect(database.mocks.trainedFirst).toHaveBeenCalledTimes(2);
      expect(caches.active.size).toBe(1);
    });
    test("reloads the same execution after its updatedAt changes", async () => {
      database.mocks.trainedPointer.mockResolvedValue(pointer()); await getActiveTrainedModel();
      const changed = { ...row(), updatedAt: "2026-10-13T19:00:00.000Z" };
      database.mocks.trainedPointer.mockResolvedValue(pointer(changed)); database.mocks.trainedFirst.mockResolvedValue(changed);
      await getActiveTrainedModel(); expect(database.mocks.trainedFirst).toHaveBeenCalledTimes(2);
    });
    test("clears the active cache if the active model disappears", async () => {
      database.mocks.trainedPointer.mockResolvedValueOnce(pointer()); await getActiveTrainedModel();
      expect(await getActiveTrainedModel()).toBeNull(); expect(caches.active.size).toBe(0);
    });
    test("does not repopulate a cache from a read started before invalidation", async () => {
      const pending = Promise.withResolvers<typeof trainedModelFixture | null>();
      const started = Promise.withResolvers<void>();
      database.mocks.trainedFirst.mockImplementationOnce(() => { started.resolve(); return pending.promise; });
      const reading = getTrainedModelById(ID); await started.promise;
      invalidateTrainedModelCaches(); pending.resolve(row()); await reading;
      expect(caches.byId.size).toBe(0);
    });
  });
  describe("writes and activation", () => {
    test("saves a Zod-validated artifact and report as objects in a transaction", async () => {
      const saved = await saveTrainedModel(artifact(), { trainingReport: trainingReportFixture });
      expect(saved.artifact.metadata.modelId).toBe(trainedModelFixture.modelId);
      expect(database.mocks.transaction).toHaveBeenCalledTimes(1);
      expect(database.mocks.transactionQuery).toHaveBeenCalledTimes(1);
      expect(database.mocks.trainedCreate).toHaveBeenCalledWith({ modelId: trainedModelFixture.modelId, kind: PAIR_RANKER_KIND, artifact: trainedArtifactFixture, trainingReport: trainingReportFixture, activeKey: null });
      expect(database.mocks.trainedUpdateAll).not.toHaveBeenCalled();
    });
    test("omits undefined optional fields before storing JSONB", async () => {
      const value = artifact(); value.metadata.learningRate = undefined;
      const saved = await saveTrainedModel(value);
      expect(saved.artifact.metadata.learningRate).toBeUndefined();
      const input = database.mocks.trainedCreate.mock.calls[0]?.[0];
      expect(JSON.stringify(input?.artifact)).not.toContain("learningRate");
    });
    test("creates distinct executions even when the weights are identical", async () => {
      database.mocks.trainedCreate.mockResolvedValueOnce({ ...row(), activeKey: null }).mockResolvedValueOnce({ ...row(), id: OTHER_ID, activeKey: null });
      const first = await saveTrainedModel(artifact()); const second = await saveTrainedModel(artifact());
      expect(first.modelId).toBe(second.modelId); expect(first.id).not.toBe(second.id);
      expect(database.mocks.trainedCreate).toHaveBeenCalledTimes(2);
    });
    test("saves without a report and invalidates caches only after success", async () => {
      await getTrainedModels(); await saveTrainedModel(artifact());
      expect(caches.lists.size).toBe(0);
      expect(database.mocks.trainedCreate).toHaveBeenCalledWith(expect.objectContaining({ trainingReport: null }));
    });
    test("activates the saved execution atomically", async () => {
      const saved = await saveTrainedModel(artifact(), { activate: true });
      expect(saved.activeKey).toBe(PAIR_RANKER_KIND);
      expect(database.mocks.trainedUpdateAll).toHaveBeenCalledWith({ activeKey: null });
      expect(database.mocks.trainedUpdate).toHaveBeenCalledWith({ activeKey: PAIR_RANKER_KIND });
    });
    test("activates an existing execution and invalidates caches", async () => {
      await getTrainedModelById(ID); await activateTrainedModel(` ${ID} `);
      expect(database.mocks.trainedIdEq).toHaveBeenCalledWith(ID);
      expect(caches.byId.size).toBe(0);
    });
    test("rejects invalid JSONB and mismatched reports before connecting", async () => {
      await expect(saveTrainedModel({})).rejects.toThrow();
      await expect(saveTrainedModel(artifact(), { trainingReport: {} })).rejects.toThrow();
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
    });
    test("stores a failed model for inspection but prevents its activation", async () => {
      const invalid = artifact(); invalid.metadata.validationMeanAbsoluteError = MAX_VALIDATION_MAE + 0.1;
      await saveTrainedModel(invalid);
      database.mocks.connectDatabase.mockClear();
      await expect(saveTrainedModel(invalid, { activate: true })).rejects.toThrow("limite de erro");
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
      database.mocks.trainedFirst.mockResolvedValueOnce({ ...row(), artifact: invalid });
      await expect(activateTrainedModel(ID)).rejects.toThrow("limite de erro");
      expect(database.mocks.trainedUpdateAll).not.toHaveBeenCalled();
    });
    test("rejects high eligible-pair error and incompatible versions on activation", async () => {
      const invalid = artifact(); invalid.metadata.eligibleValidationMeanAbsoluteError = MAX_VALIDATION_MAE + 0.1;
      await expect(saveTrainedModel(invalid, { activate: true })).rejects.toThrow("limite de erro");
      invalid.metadata.eligibleValidationMeanAbsoluteError = 0.01; invalid.metadata.encoderVersion = "old";
      await expect(saveTrainedModel(invalid, { activate: true })).rejects.toThrow("incompatível");
      invalid.metadata.encoderVersion = "pair-v1"; invalid.metadata.policyVersion = "old";
      await expect(saveTrainedModel(invalid, { activate: true })).rejects.toThrow("incompatível");
    });
    test("rejects invalid and unknown activation IDs", async () => {
      await expect(activateTrainedModel("invalid")).rejects.toThrow();
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
      database.mocks.trainedFirst.mockResolvedValueOnce(null);
      await expect(activateTrainedModel(ID)).rejects.toThrow("não encontrado");
      expect(database.mocks.trainedUpdateAll).not.toHaveBeenCalled();
    });
    test("preserves caches when create, transaction or activation fails", async () => {
      await getTrainedModels();
      database.mocks.trainedCreate.mockRejectedValueOnce(new Error("Create failed"));
      await expect(saveTrainedModel(artifact())).rejects.toThrow("Create failed");
      expect(caches.lists.size).toBe(1);
      database.mocks.transaction.mockRejectedValueOnce(new Error("Transaction failed"));
      await expect(saveTrainedModel(artifact())).rejects.toThrow("Transaction failed");
      expect(caches.lists.size).toBe(1);
      database.mocks.trainedUpdate.mockRejectedValueOnce(new Error("Activation failed"));
      await expect(activateTrainedModel(ID)).rejects.toThrow("Activation failed");
      expect(caches.lists.size).toBe(1);
    });
    test("deletes by validated ID and invalidates caches", async () => {
      await getTrainedModels(); expect((await deleteTrainedModel(ID))?.id).toBe(ID);
      expect(database.mocks.trainedIdEq).toHaveBeenCalledWith(ID);
      expect(database.mocks.trainedDelete).toHaveBeenCalledTimes(1); expect(caches.lists.size).toBe(0);
    });
    test("handles missing deletes and rejects invalid IDs", async () => {
      await expect(deleteTrainedModel("invalid")).rejects.toThrow();
      expect(database.mocks.connectDatabase).not.toHaveBeenCalled();
      database.mocks.trainedDelete.mockResolvedValueOnce(null);
      expect(await deleteTrainedModel(ID)).toBeNull();
    });
    test("preserves caches if deletion fails", async () => {
      await getTrainedModels(); database.mocks.trainedDelete.mockRejectedValueOnce(new Error("Delete failed"));
      await expect(deleteTrainedModel(ID)).rejects.toThrow("Delete failed"); expect(caches.lists.size).toBe(1);
    });
  });
});
