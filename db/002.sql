ALTER TABLE issues
  ADD COLUMN issue_type text NOT NULL DEFAULT 'Issue',
  ADD COLUMN parent_issue_id integer REFERENCES issues(issue_id),
  ADD CONSTRAINT issues_type_check CHECK (issue_type IN ('Bug', 'Issue', 'Task', 'Sub-Task', 'Story')),
  ADD CONSTRAINT issues_parent_type_check CHECK ((issue_type = 'Sub-Task') = (parent_issue_id IS NOT NULL)),
  ADD CONSTRAINT issues_not_own_parent_check CHECK (parent_issue_id <> issue_id);
CREATE INDEX issues_parent_idx ON issues(parent_issue_id);
