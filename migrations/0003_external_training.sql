-- Completion and model activation share one SQLite statement/transaction.
-- Validation failure aborts the entire transition and preserves the previous active model.
CREATE TRIGGER activate_external_training BEFORE UPDATE OF status ON TrainingJob
WHEN NEW.status = 'completed' AND OLD.status = 'running' AND json_extract(NEW.options, '$.executor') = 'external'
BEGIN
  SELECT RAISE(ABORT, 'The cohort changed during external training') WHERE NOT EXISTS (
    SELECT 1 FROM AppState WHERE id = 'main' AND revision = NEW.revision AND vectorGeneration = NEW.generation
  );
  SELECT RAISE(ABORT, 'External model is missing or failed validation') WHERE NOT EXISTS (
    SELECT 1 FROM TrainedModels WHERE jobId = NEW.id AND iteration = NEW.iteration AND kind = 'pair-ranker'
      AND json_extract(artifact, '$.metadata.encoderVersion') = 'pair-v1'
      AND json_extract(artifact, '$.metadata.policyVersion') = 'pair-policy-v1'
      AND json_extract(artifact, '$.metadata.validationMeanAbsoluteError') BETWEEN 0 AND 0.05
      AND coalesce(json_extract(artifact, '$.metadata.eligibleValidationMeanAbsoluteError'), 0) BETWEEN 0 AND 0.05
      AND json_extract(artifact, '$.metadata.validationStrategy') = 'student-disjoint'
  );
  UPDATE TrainedModels SET activeKey = NULL, updatedAt = NEW.finishedAt WHERE activeKey = 'pair-ranker';
  UPDATE TrainedModels SET activeKey = 'pair-ranker', updatedAt = NEW.finishedAt WHERE jobId = NEW.id AND iteration = NEW.iteration;
END;
