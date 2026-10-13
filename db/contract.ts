import { check, defineContract } from "@prisma/orm-postgres/contract-builder";
import pgvector from "@prisma/orm-extension-pgvector/pack";

export const contract = defineContract({ extensions: { pgvector } }, ({ field, model, rel, type }) => {
  const types = {
    StudentVector: type.pgvector.Vector(3),
    PairVector: type.pgvector.Vector(4),
  } as const;
  const Users = model("Users", {
    fields: {
      id: field.id.uuidv7String(),
      age: field.bigint(),
      name: field.text(),
      email: field.text().unique(),
      score: field.bigint(),
      income: field.text(),
      disability: field.boolean(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
      discount: field.text().optional(),
    },
  });

  const Weights = model("Weights", {
    fields: {
      id: field.id.uuidv7String(),
      field: field.text().unique(),
      value: field.float(),
    },
  });

  const StudentVectors = model("StudentVectors", {
    fields: {
      id: field.id.uuidv7String(),
      userId: field.uuidString().unique(),
      vector: field.namedType(types.StudentVector),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).sql(({ cols, constraints }) => ({
    foreignKeys: [
      constraints.foreignKey(cols.userId, Users.ref("id"), {
        onDelete: "cascade",
        index: false,
      }),
    ],
  }));

  const PairVectors = model("PairVectors", {
    fields: {
      id: field.id.uuidv7String(),
      userAId: field.uuidString(),
      userBId: field.uuidString(),
      vector: field.namedType(types.PairVector),
      contextVersion: field.text(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  })
    .attributes(({ fields, constraints }) => ({
      uniques: [constraints.unique([fields.userAId, fields.userBId])],
    }))
    .sql(({ cols, constraints }) => ({
      foreignKeys: [
        constraints.foreignKey(cols.userAId, Users.ref("id"), {
          onDelete: "cascade",
          index: false,
        }),
        constraints.foreignKey(cols.userBId, Users.ref("id"), {
          onDelete: "cascade",
          index: true,
        }),
      ],
      checks: [check({ name: "ordered_members", expression: '"userAId" < "userBId"' })],
    }));

  const PairOutcomes = model("PairOutcomes", {
    fields: {
      id: field.id.uuidv7String(),
      userAId: field.uuidString(),
      userBId: field.uuidString(),
      vector: field.namedType(types.PairVector),
      contextVersion: field.text(),
      encoderVersion: field.text(),
      policyVersion: field.text(),
      modelId: field.text().optional(),
      scoreBeforeA: field.float(),
      scoreBeforeB: field.float(),
      scoreAfterA: field.float().optional(),
      scoreAfterB: field.float().optional(),
      participationA: field.float().optional(),
      participationB: field.float().optional(),
      feedbackA: field.float().optional(),
      feedbackB: field.float().optional(),
      notes: field.text().optional(),
      startedAt: field.temporal.createdAtString(),
      completedAt: field.text().optional(),
    },
  }).attributes(({ fields, constraints }) => ({
    uniques: [constraints.unique([fields.userAId, fields.userBId])],
  })).sql(({ cols, constraints }) => ({
    foreignKeys: [
      constraints.foreignKey(cols.userAId, Users.ref("id"), { onDelete: "cascade", index: true }),
      constraints.foreignKey(cols.userBId, Users.ref("id"), { onDelete: "cascade", index: true }),
    ],
    checks: [
      check({ name: "ordered_members", expression: '"userAId" < "userBId"' }),
      check({ name: "score_ranges", expression: '"scoreBeforeA" BETWEEN 0 AND 100 AND "scoreBeforeB" BETWEEN 0 AND 100 AND ("scoreAfterA" IS NULL OR "scoreAfterA" BETWEEN 0 AND 100) AND ("scoreAfterB" IS NULL OR "scoreAfterB" BETWEEN 0 AND 100)' }),
      check({ name: "participation_ranges", expression: '("participationA" IS NULL OR "participationA" BETWEEN 0 AND 1) AND ("participationB" IS NULL OR "participationB" BETWEEN 0 AND 1)' }),
      check({ name: "feedback_ranges", expression: '("feedbackA" IS NULL OR "feedbackA" BETWEEN 1 AND 5) AND ("feedbackB" IS NULL OR "feedbackB" BETWEEN 1 AND 5)' }),
      check({ name: "complete_observations", expression: '("completedAt" IS NULL AND "scoreAfterA" IS NULL AND "scoreAfterB" IS NULL AND "participationA" IS NULL AND "participationB" IS NULL AND "feedbackA" IS NULL AND "feedbackB" IS NULL) OR ("completedAt" IS NOT NULL AND "scoreAfterA" IS NOT NULL AND "scoreAfterB" IS NOT NULL AND "participationA" IS NOT NULL AND "participationB" IS NOT NULL AND "feedbackA" IS NOT NULL AND "feedbackB" IS NOT NULL)' }),
    ],
  }));

  const TrainedModels = model("TrainedModels", {
    fields: {
      id: field.id.uuidv7String(),
      modelId: field.text(),
      kind: field.text(),
      artifact: field.json(),
      trainingReport: field.json().optional(),
      activeKey: field.text().optional().unique(),
      createdAt: field.temporal.createdAtString(),
      updatedAt: field.temporal.updatedAtString(),
    },
  }).sql(({ cols, constraints }) => ({
    indexes: [constraints.index(cols.modelId)],
    checks: [
      check({ name: "active_kind", expression: '"activeKey" IS NULL OR "activeKey" = "kind"' }),
      check({ name: "artifact_identity", expression: 'jsonb_typeof("artifact") = \'object\' AND ("artifact" #>> \'{metadata,modelId}\') IS NOT NULL AND "modelId" = "artifact" #>> \'{metadata,modelId}\'' }),
      check({ name: "report_object", expression: '"trainingReport" IS NULL OR jsonb_typeof("trainingReport") = \'object\'' }),
    ],
  }));

  return {
    types,
    models: {
      Users: Users.relations({
        studentVectors: rel.hasMany(StudentVectors, { by: "userId" }),
        pairVectorsAsA: rel.hasMany(PairVectors, { by: "userAId" }),
        pairVectorsAsB: rel.hasMany(PairVectors, { by: "userBId" }),
      }),
      Weights,
      StudentVectors: StudentVectors.relations({
        user: rel.belongsTo(Users, { from: "userId", to: "id" }),
      }),
      PairVectors: PairVectors.relations({
        userA: rel.belongsTo(Users, { from: "userAId", to: "id" }),
        userB: rel.belongsTo(Users, { from: "userBId", to: "id" }),
      }),
      PairOutcomes,
      TrainedModels,
    },
  };
});
