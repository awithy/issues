CREATE TABLE IF NOT EXISTS projects (
  project_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  key text NOT NULL UNIQUE,
  next_issue_number integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS issue_statuses (
  status_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects ON DELETE CASCADE,
  title text NOT NULL,
  is_complete boolean NOT NULL DEFAULT false,
  position integer NOT NULL,
  UNIQUE (project_id, status_id)
);
CREATE TABLE IF NOT EXISTS issues (
  issue_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects ON DELETE CASCADE,
  issue_number integer NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  status_id integer NOT NULL,
  labels text[] NOT NULL DEFAULT '{}',
  assignee text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, issue_number),
  FOREIGN KEY (project_id, status_id) REFERENCES issue_statuses(project_id, status_id)
);
CREATE INDEX IF NOT EXISTS issues_project_status_idx ON issues(project_id, status_id);
CREATE TABLE IF NOT EXISTS attachments (
  attachment_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  issue_id integer NOT NULL REFERENCES issues ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_issue_idx ON attachments(issue_id);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY,
  username text NOT NULL,
  expires_at timestamptz NOT NULL
);
