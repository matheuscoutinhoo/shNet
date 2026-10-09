ALTER TABLE lab_progress ADD COLUMN best_score integer NOT NULL DEFAULT 0 CHECK(best_score BETWEEN 0 AND 100);
UPDATE lab_progress SET best_score=CASE WHEN completed THEN 100 ELSE floor(100.0*passed/greatest(total,1))::integer END;
