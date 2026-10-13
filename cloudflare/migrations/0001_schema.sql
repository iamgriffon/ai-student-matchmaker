-- CreateTable
CREATE TABLE "Users" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "age" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "income" TEXT NOT NULL,
    "disability" BOOLEAN NOT NULL,
    "discount" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StudentVectors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "contextVersion" TEXT NOT NULL,
    CONSTRAINT "StudentVectors_userId_fkey" FOREIGN KEY ("userId") REFERENCES "Users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PairVectors" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vectorId" TEXT NOT NULL,
    "uploaded" BOOLEAN NOT NULL DEFAULT false,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "contextVersion" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    CONSTRAINT "PairVectors_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "Users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PairVectors_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "Users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PairOutcomes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userAId" TEXT NOT NULL,
    "userBId" TEXT NOT NULL,
    "contextVersion" TEXT NOT NULL,
    "encoderVersion" TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "modelId" TEXT,
    "imbalance" REAL NOT NULL,
    "academicGap" REAL NOT NULL,
    "incomeDistance" REAL NOT NULL,
    "disabilityDifference" REAL NOT NULL,
    "scoreBeforeA" REAL NOT NULL,
    "scoreBeforeB" REAL NOT NULL,
    "scoreAfterA" REAL,
    "scoreAfterB" REAL,
    "participationA" REAL,
    "participationB" REAL,
    "feedbackA" INTEGER,
    "feedbackB" INTEGER,
    "notes" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    CONSTRAINT "PairOutcomes_userAId_fkey" FOREIGN KEY ("userAId") REFERENCES "Users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PairOutcomes_userBId_fkey" FOREIGN KEY ("userBId") REFERENCES "Users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TrainedModels" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "artifact" JSONB NOT NULL,
    "trainingReport" JSONB,
    "activeKey" TEXT,
    "jobId" TEXT NOT NULL,
    "iteration" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AppState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "vectorGeneration" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "TrainingJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "activeKey" TEXT,
    "status" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "revision" INTEGER NOT NULL,
    "generation" INTEGER NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 0,
    "iteration" INTEGER NOT NULL DEFAULT 0,
    "iterationCount" INTEGER NOT NULL DEFAULT 1,
    "totalEpochs" INTEGER NOT NULL,
    "learningRate" REAL NOT NULL,
    "loss" REAL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "VectorDeletion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "index" TEXT NOT NULL,
    "vectorId" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Weights" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "field" TEXT NOT NULL,
    "value" REAL NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Users_email_key" ON "Users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "StudentVectors_userId_key" ON "StudentVectors"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PairVectors_vectorId_key" ON "PairVectors"("vectorId");

-- CreateIndex
CREATE INDEX "PairVectors_contextVersion_generation_idx" ON "PairVectors"("contextVersion", "generation");

-- CreateIndex
CREATE INDEX "PairVectors_userBId_idx" ON "PairVectors"("userBId");

-- CreateIndex
CREATE UNIQUE INDEX "PairVectors_userAId_userBId_key" ON "PairVectors"("userAId", "userBId");

-- CreateIndex
CREATE INDEX "PairOutcomes_userBId_idx" ON "PairOutcomes"("userBId");

-- CreateIndex
CREATE UNIQUE INDEX "PairOutcomes_userAId_userBId_key" ON "PairOutcomes"("userAId", "userBId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainedModels_activeKey_key" ON "TrainedModels"("activeKey");

-- CreateIndex
CREATE INDEX "TrainedModels_modelId_idx" ON "TrainedModels"("modelId");

-- CreateIndex
CREATE UNIQUE INDEX "TrainedModels_jobId_iteration_key" ON "TrainedModels"("jobId", "iteration");

-- CreateIndex
CREATE UNIQUE INDEX "TrainingJob_activeKey_key" ON "TrainingJob"("activeKey");

-- CreateIndex
CREATE UNIQUE INDEX "VectorDeletion_index_vectorId_key" ON "VectorDeletion"("index", "vectorId");

-- CreateIndex
CREATE UNIQUE INDEX "Weights_field_key" ON "Weights"("field");
