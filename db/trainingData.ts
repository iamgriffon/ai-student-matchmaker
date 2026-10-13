import { connectDatabase, db } from "./db.ts";
import { invalidatePairVectorCaches } from "./pairVectors.ts";
import { invalidateTrainedModelCaches, lockModelWrites } from "./trainedModels.ts";
import { lockStudentMutations } from "./vectorSync.ts";

export async function deleteTrainingData() {
  await connectDatabase();
  const deleted = await db.transaction(async (tx) => {
    // Mesma ordem de locks usada ao iniciar duplas: turma, depois modelos.
    await lockStudentMutations(tx);
    await lockModelWrites(tx);
    const pairVectors = await tx.orm.public.PairVectors.where((v) => v.id.isNotNull()).deleteAndCount();
    const trainedModels = await tx.orm.public.TrainedModels.where((m) => m.id.isNotNull()).deleteAndCount();
    return { pairVectors, trainedModels };
  });
  invalidatePairVectorCaches();
  invalidateTrainedModelCaches();
  return deleted;
}
