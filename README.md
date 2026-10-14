# Issues

A minimalist issue tracker with a React web app, a CLI, and one shared HTTP API. TypeScript throughout; PostgreSQL is the only data store. Both clients use the API for every operation—neither has database access.

## What’s included

- Projects with immutable keys such as `WEB` and issue keys such as `WEB-123`.
- Issue table with search, status filtering, and inline status changes.
- Issue editing: title, **Markdown Description**, **Markdown Notes**, status, labels, and free-text assignee.
- Markdown write/preview, including tables, code blocks, and task lists. Raw HTML is not rendered.
- Per-project statuses, defaulting to **backlog → design → ready → in progress → done → archived**. Any-to-any transitions; done and archived are complete by default.
- Customizable status names, ordering, and completion flags. The first status is the default. An in-use status cannot be removed until its issues are moved elsewhere.
- Multiple config-defined users with bcrypt password hashes. Every authenticated user has full access.
- Attachments stored as PostgreSQL `bytea`, never as files on the API server. Authenticated upload/download, up to **25 MB per file**.
- Permanent deletes: attachments are physically removed from the table; deleting an issue cascades to its attachments, and deleting a project cascades to all its issues, attachments, and statuses. No soft-delete/trash mechanism.

## Quick start

Requires **Node.js 22.12+** (Node 24 recommended), npm, and Docker Compose (or an existing Postgres database).

```sh
npm install
cp .env.example .env

docker compose up -d --wait

# Prompts for a password and writes a bcrypt hash, not the password.
npm run user:add -- alice
npm run user:add -- bob

npm run dev
```

- Web: **http://localhost:5173**
- API: **http://localhost:3031/api**

Log in with one of the usernames/passwords you configured. There are no default credentials. The API creates the initial schema automatically on startup. `npm run db:migrate` can also apply it explicitly.

The Vite development server proxies `/api` to the configured API `PORT`. If you change the API port, restart development and set the CLI’s API URL with `--api` or `ISSUES_API_URL`.

### Configuration

Copy `.env.example` to `.env` and adjust as needed:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://issues:issues@localhost:5432/issues` | Postgres connection string |
| `PORT` | `3031` | API/production web port |
| `USERS_FILE` | `config/users.json` | User config loaded at API startup |
| `PUBLIC_ORIGIN` | unset in code; example uses `http://localhost:5173` | Additional permitted browser origin, useful behind a reverse proxy |
| `COOKIE_SECURE` | `false` | Set `true` for HTTPS deployment |

Browser mutations are permitted only from the API’s own origin or the exact configured `PUBLIC_ORIGIN`. CORS is intentionally not enabled. Serve the web app and API on the same public origin.

`compose.yaml` binds Postgres to localhost and uses a persistent Docker volume. Its development credentials should be changed for production. Stop it with `docker compose down`; this preserves the database volume. **`docker compose down -v` destroys the database.**

### Users

`config/users.json` is git-ignored and looks like this (the placeholder must be replaced with a real bcrypt hash):

```json
{
  "users": [
    { "username": "alice", "passwordHash": "<bcrypt hash>" }
  ]
}
```

Use `npm run user:add -- alice` to add or replace a user’s hash. Restart the API after config changes. Removing a user from config and restarting prevents their existing sessions from authenticating. Password changes do not otherwise revoke already-issued sessions; sessions expire after seven days.

For automation, `ISSUES_PASSWORD` supplies the password to the user-config command and CLI login. Interactive prompts do not echo passwords. Passwords created by the helper must be at least 8 characters and at most 72 UTF-8 bytes (bcrypt’s limit). Do not commit `.env`, user configs, or CLI session tokens.

## CLI

Run from this directory with `npm run cli -- ...`. The production build is also usable with `node dist/cli/index.js ...`.

```sh
npm run cli -- login alice
npm run cli -- whoami

npm run cli -- project create WEB "Website"
npm run cli -- project list
npm run cli -- project show WEB
npm run cli -- project update WEB --title "Web platform"

npm run cli -- issue create WEB "Build the landing page" \
  --description "A **simple** homepage" \
  --notes "Discuss the design with the team" \
  --assignee "External designer" --labels frontend,design

npm run cli -- issue list WEB
npm run cli -- issue list WEB --status "in progress" --search landing
npm run cli -- issue show WEB-1
npm run cli -- issue update WEB-1 --status archived
npm run cli -- issue update WEB-1 --status backlog --notes-file ./notes.md
npm run cli -- issue update WEB-1 --description-file ./description.md
npm run cli -- issue update WEB-1 --labels "" --assignee ""

npm run cli -- attachment upload WEB-1 ./design.png
npm run cli -- attachment list WEB-1
npm run cli -- attachment download 1 ./downloaded-design.png
npm run cli -- attachment delete 1 --yes

npm run cli -- issue delete WEB-1 --yes
npm run cli -- project delete WEB --yes
npm run cli -- logout
```

Project arguments accept a key or numeric project ID. Issue arguments accept a key or numeric issue ID. Status arguments accept a name or numeric status ID. CLI deletes require `--yes` because they cannot be undone.

Global options:

```sh
npm run cli -- --api http://localhost:3031/api login alice
npm run cli -- --json issue list WEB
npm run cli -- --help
npm run cli -- issue update --help
```

The CLI stores its API URL and session token in `~/.config/minimal-issues/session.json` with mode `0600`. Override the path with `ISSUES_CONFIG`, or the API URL with `ISSUES_API_URL`. A saved token is only sent to its saved API URL. Sessions are opaque random tokens, with only SHA-256 token hashes stored in Postgres. Browser sessions use an HTTP-only, SameSite=Lax cookie.

### Customize statuses

The web app exposes status editing under **Project settings**. In the CLI:

```sh
npm run --silent cli -- --json project statuses WEB > statuses.json
# Edit statuses.json, preserving statusId for statuses you want to keep.
# Omit statusId on newly added statuses. Array order sets display/default order.
npm run cli -- project statuses WEB --file statuses.json
```

**Use `npm run --silent cli -- ...` when redirecting JSON to a file**, so npm’s script banner is not included. For example:

```sh
npm run --silent cli -- --json project statuses WEB > statuses.json
```

Each status is `{ "statusId": 1, "title": "backlog", "isComplete": false }`. At least one status must remain. Updating statuses is transactional: removing an in-use status rejects the entire update.

## Tests

Tests use **real Postgres**, not a database mock. Each run creates and drops an isolated, randomly named schema; it does not truncate application tables. The database user must have permission to create schemas. Set `TEST_DATABASE_URL` to use a separate test database (otherwise `DATABASE_URL` is used).

```sh
docker compose up -d --wait
npm run typecheck
npm test

# One-time browser installation (Linux CI may also need --with-deps).
npx playwright install chromium
npm run test:web
```

- `npm test`: login/logout, cookie and token auth, multiple users, project/issue CRUD, Markdown Description/Notes persistence, search/filtering, arbitrary transitions, status configuration, binary attachments, permanent cascading deletes, unique concurrent numbering, and an end-to-end CLI workflow. Important failures include unauthenticated requests, bad login, cross-origin mutation, duplicate keys, cross-project status assignment, removing in-use statuses, and expired/revoked sessions.
- `npm run test:web`: builds the production app and exercises its main workflow in Chromium at desktop and mobile sizes. Starts its own API on an ephemeral port; no development server or user config is needed.

## Production

```sh
npm ci
npm run build
# Configure DATABASE_URL, USERS_FILE, PUBLIC_ORIGIN and COOKIE_SECURE first.
NODE_ENV=production npm start
```

Node serves the built web app and `/api` together on `PORT` (default `3031`). Run from the repository root: the server uses `db/001.sql`, the user config, and `dist/web` relative to that directory. Put an HTTPS reverse proxy in front of it, set `PUBLIC_ORIGIN` to the public URL (scheme + host + optional port, without a trailing slash), and set `COOKIE_SECURE=true`. Configure proxy upload limits to allow 25 MB files plus multipart overhead. HTTPS and a non-public database are required for a real deployment.

Back up Postgres to back up issues **and files**. Permanent deletion removes live application records; existing database backups are not rewritten or securely erased.

## API overview

All routes except health and login require a valid session cookie or `Authorization: Bearer <token>`. JSON request/response bodies unless otherwise noted; errors are `{ "error": "message" }`. IDs are integers.

| Method | Path (under `/api`) | Action |
| --- | --- | --- |
| GET | `/health` | Database health |
| POST | `/auth/login` | `{username, password}` → `{username, token}` and cookie |
| POST | `/auth/logout` | Revoke current session |
| GET | `/auth/me` | Current username |
| GET / POST | `/projects` | List / create `{title, key}` |
| GET / PATCH / DELETE | `/projects/:id` | Read / update `{title?, issueStatuses?}` / permanently delete |
| GET / POST | `/projects/:id/issues` | List / create issue |
| GET / PATCH / DELETE | `/issues/:id-or-key` | Read / update / permanently delete issue |
| POST | `/issues/:id-or-key/attachments` | Multipart upload with field `file` |
| GET / DELETE | `/attachments/:id` | Binary download / permanent deletion |

Issue create accepts `{title, description?, notes?, statusId?, labels?, assignee?}`. Update accepts any non-empty subset of those fields; arrays such as labels are replaced. Issue listing accepts `?statusId=1&search=text`; search covers the key, title, assignee, and labels. Attachment metadata is included in issue responses; binary content is downloaded separately and is always served as a download, not inline executable content.

## Layout and deliberate limits

```text
src/api/          Express routes, auth, Postgres repository
src/shared/       API types and fetch client shared by web and CLI
src/cli/          CLI commands; no database imports
web/              React UI and Vite config
scripts/          Local user-config helper
config/           Example user config
db/001.sql        Initial idempotent database schema
tests/            Postgres-backed API/CLI and browser workflow tests
```

Issue numbering is an atomic per-project counter. Deleting an issue does not reuse its number. Project keys are immutable, so renaming a project does not change issue references. The database enforces status/project membership and cascading deletes.

Intentionally no roles, signup, comments, boards, sprints, notifications, audit history, soft deletes, optimistic-concurrency UI, or pagination in v1. The issue table loads all matching issues, suitable for a small tracker. Simultaneous edits use last-write-wins. There is one initial idempotent schema file; introduce versioned SQL migrations when changing an existing deployed schema.
