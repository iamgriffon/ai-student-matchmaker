INSERT INTO AppState (id, revision, vectorGeneration) VALUES ('main', 0, 0);

CREATE TRIGGER users_insert_revision AFTER INSERT ON Users BEGIN UPDATE AppState SET revision = revision + 1 WHERE id = 'main'; END;
CREATE TRIGGER users_update_revision AFTER UPDATE ON Users BEGIN UPDATE AppState SET revision = revision + 1 WHERE id = 'main'; END;
CREATE TRIGGER users_delete_revision AFTER DELETE ON Users BEGIN UPDATE AppState SET revision = revision + 1 WHERE id = 'main'; END;
CREATE TRIGGER delete_pair_vector BEFORE DELETE ON PairVectors BEGIN
  INSERT OR IGNORE INTO VectorDeletion (id, "index", vectorId) VALUES (lower(hex(randomblob(16))), 'pair', OLD.vectorId);
END;
CREATE TRIGGER delete_student_vector BEFORE DELETE ON StudentVectors BEGIN
  INSERT OR IGNORE INTO VectorDeletion (id, "index", vectorId) VALUES (lower(hex(randomblob(16))), 'student', OLD.id);
END;
CREATE TRIGGER validate_pair_order BEFORE INSERT ON PairVectors WHEN NEW.userAId >= NEW.userBId BEGIN SELECT RAISE(ABORT, 'Pair members must be ordered and different'); END;
CREATE TRIGGER validate_outcome_order BEFORE INSERT ON PairOutcomes WHEN NEW.userAId >= NEW.userBId BEGIN SELECT RAISE(ABORT, 'Pair members must be ordered and different'); END;
CREATE TRIGGER validate_user_insert BEFORE INSERT ON Users
WHEN NEW.score NOT BETWEEN 0 AND 100 OR NEW.age NOT BETWEEN 16 AND 80 OR NEW.disability NOT IN (0, 1)
BEGIN SELECT RAISE(ABORT, 'Invalid student fields'); END;
CREATE TRIGGER validate_user_update BEFORE UPDATE ON Users
WHEN NEW.score NOT BETWEEN 0 AND 100 OR NEW.age NOT BETWEEN 16 AND 80 OR NEW.disability NOT IN (0, 1)
BEGIN SELECT RAISE(ABORT, 'Invalid student fields'); END;
CREATE TRIGGER validate_model_insert BEFORE INSERT ON TrainedModels
WHEN NOT json_valid(NEW.artifact) OR json_extract(NEW.artifact, '$.metadata.modelId') IS NULL
OR json_extract(NEW.artifact, '$.metadata.modelId') != NEW.modelId OR (NEW.activeKey IS NOT NULL AND NEW.activeKey != NEW.kind)
OR (NEW.trainingReport IS NOT NULL AND NOT json_valid(NEW.trainingReport))
BEGIN SELECT RAISE(ABORT, 'Invalid model payload'); END;
CREATE TRIGGER validate_model_update BEFORE UPDATE ON TrainedModels
WHEN NOT json_valid(NEW.artifact) OR json_extract(NEW.artifact, '$.metadata.modelId') IS NULL
OR json_extract(NEW.artifact, '$.metadata.modelId') != NEW.modelId OR (NEW.activeKey IS NOT NULL AND NEW.activeKey != NEW.kind)
OR (NEW.trainingReport IS NOT NULL AND NOT json_valid(NEW.trainingReport))
BEGIN SELECT RAISE(ABORT, 'Invalid model payload'); END;
CREATE TRIGGER validate_outcome_insert BEFORE INSERT ON PairOutcomes
WHEN NEW.scoreBeforeA NOT BETWEEN 0 AND 100 OR NEW.scoreBeforeB NOT BETWEEN 0 AND 100
OR NEW.imbalance NOT BETWEEN 0 AND 1 OR NEW.academicGap NOT BETWEEN 0 AND 1 OR NEW.incomeDistance NOT BETWEEN 0 AND 1 OR NEW.disabilityDifference NOT BETWEEN 0 AND 1
BEGIN SELECT RAISE(ABORT, 'Invalid study pair snapshot'); END;
CREATE TRIGGER validate_outcome_completion BEFORE UPDATE ON PairOutcomes
WHEN OLD.completedAt IS NOT NULL OR NEW.completedAt IS NULL
OR NEW.scoreAfterA IS NULL OR NEW.scoreAfterB IS NULL OR NEW.participationA IS NULL OR NEW.participationB IS NULL OR NEW.feedbackA IS NULL OR NEW.feedbackB IS NULL
OR NEW.scoreAfterA NOT BETWEEN 0 AND 100 OR NEW.scoreAfterB NOT BETWEEN 0 AND 100
OR NEW.participationA NOT BETWEEN 0 AND 1 OR NEW.participationB NOT BETWEEN 0 AND 1
OR NEW.feedbackA NOT BETWEEN 1 AND 5 OR NEW.feedbackB NOT BETWEEN 1 AND 5
BEGIN SELECT RAISE(ABORT, 'Invalid or repeated study pair completion'); END;

CREATE TRIGGER update_pair_vector BEFORE UPDATE OF vectorId ON PairVectors WHEN OLD.vectorId != NEW.vectorId BEGIN
  INSERT OR IGNORE INTO VectorDeletion (id, "index", vectorId) VALUES (lower(hex(randomblob(16))), 'pair', OLD.vectorId);
END;
CREATE TRIGGER update_student_vector BEFORE UPDATE OF id ON StudentVectors WHEN OLD.id != NEW.id BEGIN
  INSERT OR IGNORE INTO VectorDeletion (id, "index", vectorId) VALUES (lower(hex(randomblob(16))), 'student', OLD.id);
END;

CREATE TRIGGER validate_pair_order_update BEFORE UPDATE OF userAId, userBId ON PairVectors WHEN NEW.userAId >= NEW.userBId BEGIN SELECT RAISE(ABORT, 'Pair members must be ordered and different'); END;
CREATE TRIGGER validate_outcome_order_update BEFORE UPDATE OF userAId, userBId ON PairOutcomes WHEN NEW.userAId >= NEW.userBId BEGIN SELECT RAISE(ABORT, 'Pair members must be ordered and different'); END;
