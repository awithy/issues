CREATE TABLE project_views (
  view_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id integer NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  title text NOT NULL,
  filters jsonb NOT NULL DEFAULT '{"labels":[],"statusIds":[],"issueTypes":[]}'::jsonb
);
CREATE INDEX project_views_project_id_idx ON project_views(project_id);
