CREATE TABLE issue_links (
  issue_id_a integer NOT NULL REFERENCES issues(issue_id) ON DELETE CASCADE,
  issue_id_b integer NOT NULL REFERENCES issues(issue_id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id_a, issue_id_b),
  CHECK (issue_id_a < issue_id_b)
);
CREATE INDEX issue_links_b_idx ON issue_links(issue_id_b);
