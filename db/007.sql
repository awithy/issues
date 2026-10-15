-- Priority is a manual ordering value within a status, not a global rank.
ALTER TABLE issues ADD COLUMN priority integer NOT NULL DEFAULT 0;
