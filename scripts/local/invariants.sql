INSERT INTO "AppState" (id,revision,"vectorGeneration") VALUES ('main',0,0);
CREATE TABLE "VectorIndex" (
  kind text NOT NULL, id text NOT NULL, namespace text NOT NULL,
  values vector(32) NOT NULL, metadata jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY(kind,id)
);
CREATE INDEX ON "VectorIndex"(kind,namespace);
ALTER TABLE "Users" ADD CHECK (score BETWEEN 0 AND 100 AND age BETWEEN 16 AND 80);
ALTER TABLE "PairVectors" ADD CHECK ("userAId" < "userBId");
ALTER TABLE "PairOutcomes" ADD CHECK ("userAId" < "userBId");
ALTER TABLE "TrainedModels" ADD CHECK (
  artifact->'metadata'->>'modelId' IS NOT NULL AND artifact->'metadata'->>'modelId' = "modelId"
  AND ("activeKey" IS NULL OR "activeKey" = kind)
);
CREATE FUNCTION bump_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE "AppState" SET revision=revision+1 WHERE id='main'; RETURN NULL; END $$;
CREATE TRIGGER users_revision AFTER INSERT OR UPDATE OR DELETE ON "Users" FOR EACH ROW EXECUTE FUNCTION bump_revision();

CREATE FUNCTION queue_deleted_vector() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous_id text; vector_kind text;
BEGIN
  IF TG_TABLE_NAME='PairVectors' THEN
    previous_id:=OLD."vectorId"; vector_kind:='pair';
    IF TG_OP='UPDATE' AND NEW."vectorId"=previous_id THEN RETURN NEW; END IF;
  ELSE
    previous_id:=OLD.id; vector_kind:='student';
    IF TG_OP='UPDATE' AND NEW.id=previous_id THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO "VectorDeletion"(id,"index","vectorId") VALUES(gen_random_uuid()::text,vector_kind,previous_id) ON CONFLICT DO NOTHING;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pair_vector_outbox BEFORE DELETE OR UPDATE ON "PairVectors" FOR EACH ROW EXECUTE FUNCTION queue_deleted_vector();
CREATE TRIGGER student_vector_outbox BEFORE DELETE OR UPDATE ON "StudentVectors" FOR EACH ROW EXECUTE FUNCTION queue_deleted_vector();

CREATE FUNCTION validate_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."scoreBeforeA" NOT BETWEEN 0 AND 100 OR NEW."scoreBeforeB" NOT BETWEEN 0 AND 100
    OR NEW.imbalance NOT BETWEEN 0 AND 1 OR NEW."academicGap" NOT BETWEEN 0 AND 1
    OR NEW."incomeDistance" NOT BETWEEN 0 AND 1 OR NEW."disabilityDifference" NOT BETWEEN 0 AND 1 THEN
    RAISE EXCEPTION 'Invalid study pair snapshot';
  END IF;
  IF TG_OP='UPDATE' AND (OLD."completedAt" IS NOT NULL OR NEW."completedAt" IS NULL
    OR NEW."scoreAfterA" IS NULL OR NEW."scoreAfterB" IS NULL
    OR NEW."participationA" IS NULL OR NEW."participationB" IS NULL
    OR NEW."feedbackA" IS NULL OR NEW."feedbackB" IS NULL
    OR NEW."scoreAfterA" NOT BETWEEN 0 AND 100 OR NEW."scoreAfterB" NOT BETWEEN 0 AND 100
    OR NEW."participationA" NOT BETWEEN 0 AND 1 OR NEW."participationB" NOT BETWEEN 0 AND 1
    OR NEW."feedbackA" NOT BETWEEN 1 AND 5 OR NEW."feedbackB" NOT BETWEEN 1 AND 5) THEN
    RAISE EXCEPTION 'Invalid or repeated study pair completion';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER outcome_validation BEFORE INSERT OR UPDATE ON "PairOutcomes" FOR EACH ROW EXECUTE FUNCTION validate_outcome();

CREATE FUNCTION activate_browser_model() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='completed' AND OLD.status='running' AND NEW.options->>'executor'='external' THEN
    PERFORM 1 FROM "AppState" WHERE id='main' AND revision=NEW.revision AND "vectorGeneration"=NEW.generation FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'The cohort changed during training'; END IF;
    PERFORM 1 FROM "TrainedModels" WHERE "jobId"=NEW.id AND iteration=NEW.iteration AND kind='pair-ranker'
      AND artifact->'metadata'->>'encoderVersion'='pair-v1'
      AND artifact->'metadata'->>'policyVersion'='pair-policy-v1'
      AND artifact->'metadata'->>'validationStrategy'='student-disjoint'
      AND (artifact->'metadata'->>'validationMeanAbsoluteError')::float BETWEEN 0 AND 0.05
      AND coalesce((artifact->'metadata'->>'eligibleValidationMeanAbsoluteError')::float,0) BETWEEN 0 AND 0.05;
    IF NOT FOUND THEN RAISE EXCEPTION 'Model missing or failed validation'; END IF;
    UPDATE "TrainedModels" SET "activeKey"=NULL,"updatedAt"=NEW."finishedAt" WHERE "activeKey"='pair-ranker';
    UPDATE "TrainedModels" SET "activeKey"='pair-ranker',"updatedAt"=NEW."finishedAt" WHERE "jobId"=NEW.id AND iteration=NEW.iteration;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER activate_external_training BEFORE UPDATE OF status ON "TrainingJob" FOR EACH ROW EXECUTE FUNCTION activate_browser_model();
