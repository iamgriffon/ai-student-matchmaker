import { describe, expect, test } from "bun:test";
import { trainingOptionsSchema } from "./trainingOptions.ts";

describe("training/options", () => {
  test("uses the default training configuration", () => {
    expect(trainingOptionsSchema.parse({})).toEqual({
      learningRate: 0.001, epochs: 80, batchSize: 64, compareLearningRates: false,
    });
  });
  test("accepts numeric query parameters", () => {
    expect(trainingOptionsSchema.parse({ learningRate: "0.01", epochs: "2", batchSize: "256" }))
      .toMatchObject({ learningRate: 0.01, epochs: 2, batchSize: 256 });
  });
  test.each([0, -1, 1.5, 257, NaN, Infinity])("rejects invalid batch size %s", (batchSize) => {
    expect(trainingOptionsSchema.safeParse({ batchSize }).success).toBe(false);
  });
});
