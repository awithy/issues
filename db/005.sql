-- Optional upload retry identity; ordinary uploads continue to allow duplicates.
ALTER TABLE attachments ADD COLUMN upload_key text;
CREATE UNIQUE INDEX attachments_upload_key_idx ON attachments(issue_id, upload_key) WHERE upload_key IS NOT NULL;
