import { mock } from "bun:test";
const realRanker = await import("../../../src/pairRanker.ts");
export const actualRankWithTrainedModel = realRanker.rankWithTrainedModel;
export const rankWithTrainedModelMock = mock<typeof actualRankWithTrainedModel>(async () => null);
export function resetRankerMock() {
  rankWithTrainedModelMock.mockReset().mockImplementation(async () => null);
}
mock.module("../../../src/pairRanker.ts", () => ({ ...realRanker, rankWithTrainedModel: rankWithTrainedModelMock }));
