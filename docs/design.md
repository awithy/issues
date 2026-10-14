# Issues — Design

## 1. Purpose and principles

Issues is a minimalist, self-hosted issue tracker for a small team. It borrows Jira’s core concepts—projects, issue keys, and statuses—without its workflow machinery.

This document describes the **implemented v1 design**, its rationale, and its deliberate limitations. It is not a proposal for features that do not yet exist. See [README.md](../README.md) for setup instructions and command examples.

Guiding principles:

1. **Keep it simple.** One API, one database, two thin clients. Avoid services and abstractions that do not solve a current problem.
2. **The API owns application data access.** Web and CLI operations go through the same HTTP API; neither client connects to Postgres.
3. **All authenticated users are equal.** Authentication is required, but there are no roles, project permissions, or ownership restrictions.
4. **Statuses describe work; they do not constrain transitions.** Any issue can move directly to any status in its project.
5. **Deletes are permanent.** No trash, soft-delete flags, or restore workflow.
6. **Test functionality, not every imaginable edge case.** Cover primary workflows and high-priority failures, particularly authentication and data integrity.

### Scope

- Create, view, rename, and permanently delete projects.
- Create, list, edit, and permanently delete issues.
- View issues in a table; search and filter by status.
- Edit separate Markdown Description and Notes fields.
- Configure statuses for each project.
- Assign free-text assignees and string labels.
- Attach, download, and permanently delete files stored as database blobs.
- Support multiple config-defined users with username/password login.
- Provide a React web app and a CLI with equivalent core capabilities.

### Non-goals

V1 does not include signup, a user-management UI, roles, comments, sprints, boards, notifications, audit history, soft deletes, issue moves between projects, workflow transition rules, pagination, or real-time collaboration.

## 2. Architecture

```text
React web app ──┐
               ├── Shared TypeScript API client ── HTTP /api ── Node/Express API
Node CLI ──────┘                                                   │
                                                          Postgres repository
                                                                  │
                                                               Postgres
                                                      projects, statuses, issues,
                                                        attachments, sessions

Local user-config helper ── bcrypt hashes ── config/users.json ── API startup
```

### Components

| Component | Responsibility | Main files |
| --- | --- | --- |
| API | HTTP routing, authentication, runtime validation, response/error handling | `src/api/app.ts` |
| Repository | Parameterized SQL, transactions, issue numbering, status membership, data retrieval | `src/api/repository.ts` |
| Database setup | Connection configuration, transaction helper, initial schema | `src/api/db.ts`, `db/001.sql` |
| Shared contract | Domain types, request types, default statuses | `src/shared/types.ts` |
| Shared client | JSON requests, bearer/cookie authentication, multipart uploads, binary downloads | `src/shared/client.ts` |
| Web app | Login, project navigation, issue table, Markdown editor, attachments, project settings | `web/src/` |
| CLI | Commands, human-readable/JSON output, local session storage | `src/cli/` |
| User-config helper | Add users or replace password hashes locally | `scripts/add-user.ts` |

The stack is TypeScript, React, Vite, Node.js, Express, and Postgres. The API uses `pg` directly rather than an ORM. Zod validates API input at runtime; shared TypeScript types describe the client contract but do not replace server validation.

The user-config helper is an administrative bootstrap tool, not a third application client. It edits the permitted local user config and does not access application tables.

### Development and production

In development, Vite serves the web app on port `5173` and proxies `/api` to Node on `PORT`, default `3031`. The proxy preserves the browser’s host header so same-origin checks work.

In production, Node serves the built SPA from `dist/web` and the API under `/api` on the same origin. The CLI talks to that same API. Postgres can run via the supplied Docker Compose service or an existing database.

## 3. Domain model and persistence

The API uses camelCase names; SQL uses snake_case. Project statuses and attachment metadata are nested in API responses, but persisted in separate relational tables.

```text
Project 1 ───── * IssueStatus
   │                 │
   │                 └──── * Issue
   └────────────────────── * Issue 1 ───── * Attachment

Configured User ─── Session
                  (username checked against config, not a database user table)
```

### Project

| Field | Storage / behavior |
| --- | --- |
| `projectId` | Integer identity primary key; internal project reference. |
| `title` | Required text; editable. |
| `key` | Unique uppercase abbreviation, such as `WEB`; immutable after creation. |
| `issueStatuses` | Ordered list loaded from `issue_statuses`. |
| `nextIssueNumber` | Internal counter stored as `next_issue_number`; starts at 1. |

Keys contain 1–12 letters or digits and start with a letter. Project creation creates both the project and its default statuses in one transaction.

Keeping the key immutable means renaming a project does not invalidate its issue references. A deleted project’s key is not reserved forever: a new project may reuse it, with its own sequence starting at 1.

### IssueStatus

| Field | Storage / behavior |
| --- | --- |
| `statusId` | Integer identity primary key; stable reference used when editing issues. |
| `projectId` | Owning project; not shared between projects. |
| `title` | Editable status name. |
| `isComplete` | Completion metadata used by the UI; does not lock the issue. |
| `position` | Internal ordering field; array order in the API reflects it. |

New projects receive:

| Order | Title | Complete |
| --- | --- | --- |
| 1 | backlog | No |
| 2 | design | No |
| 3 | ready | No |
| 4 | in progress | No |
| 5 | done | Yes |
| 6 | archived | Yes |

The arrow notation `backlog → design → ready → in progress → done → archived` describes default display order, **not a required workflow**. An issue may move from backlog directly to archived or from done back to design.

The first status is the default for new issues. Every project must retain at least one status. Names must be unique within the submitted project status list, ignoring case. Archived issues remain ordinary issues and are included in the default table; archiving is not deletion.

### Issue

| Field | Storage / behavior |
| --- | --- |
| `issueId` | Integer identity primary key, independent of the human-readable key. |
| `projectId` | Owning project; immutable in v1. |
| `issueNumber` | Internal per-project number, unique together with `projectId`. |
| `issueKey` | Computed from project key and issue number, e.g. `WEB-123`; not separately stored. |
| `title` | Required text; up to 300 characters. |
| `description` | Markdown source stored as text; defaults to an empty string. |
| `notes` | Independent Markdown source stored as text; defaults to an empty string. |
| `status` | Status object in responses; persisted as `status_id`. |
| `labels` | PostgreSQL `text[]`; defaults to an empty array. |
| `assignee` | Free text; defaults to an empty string. No user foreign key. |
| `attachments` | Attachment metadata loaded from `attachments`; blobs are not embedded in issue JSON. |
| `createdAt`, `updatedAt` | Database timestamps; issue patches advance `updatedAt`. |

An assignee can be a configured username, someone external to the tracker, or a team name. Labels are simple strings, not a managed taxonomy. Updating labels replaces the array. Description and Notes are plain Markdown source, not stored HTML.

### Attachment

| Field | Storage / behavior |
| --- | --- |
| `attachmentId` | Integer identity primary key. |
| `issueId` | Owning issue. |
| `filename` | Original filename retained for display and download. |
| `contentType` | Uploaded MIME metadata; not treated as trusted executable content. |
| `data` | Binary content in PostgreSQL `bytea`. |
| `size` | Computed from `octet_length(data)`, returned in bytes. |
| `createdAt` | Upload timestamp. |

There is no server-side attachment directory or object store. Uploads are buffered in memory before insertion; downloads read the stored blob. Each file is limited to 25 MiB (`25 × 1024 × 1024` bytes). Uploads are one file per API request; the web app handles multi-file selection by sending sequential requests.

This keeps backup, ownership, and deletion in one store, at the cost of larger database backups and bounded per-request memory use. There is no virus scanning, content inspection, or deduplication in v1. Attachment changes do not independently update the issue’s `updatedAt` timestamp.

### Session

`sessions` stores `token_hash`, `username`, and `expires_at`. Users themselves are not stored in Postgres. Session usernames are checked against the currently loaded user configuration on authenticated requests.

### Database integrity

The schema enforces:

- Unique project keys.
- Unique `(project_id, issue_number)` pairs.
- A composite foreign key from an issue’s `(project_id, status_id)` to a status in the same project.
- Project-to-issue, project-to-status, and issue-to-attachment cascading deletion.

Indexes support issue lookup by project/status and attachment lookup by issue. Status-name uniqueness and the requirement to retain a status are enforced by the API, rather than additional SQL constraints.

## 4. Identity, transactions, and concurrency

### Issue numbering

Issue creation atomically increments the project’s counter inside the same transaction as the issue insert:

```sql
UPDATE projects
SET next_issue_number = next_issue_number + 1
WHERE project_id = $1
RETURNING next_issue_number - 1 AS issue_number;
```

The update locks the project row. Concurrent creations within a project serialize on this row and receive distinct numbers. The issue is then inserted with the selected project status. If creation fails, the transaction rolls back, including the counter update.

Deleting a committed issue does not decrement the counter, so its number is never reused within that surviving project. API issue routes accept either an internal issue ID or a key such as `WEB-123`.

### Status configuration

A project patch can replace its status list:

1. Lock the project row.
2. Validate that retained `statusId` values belong to this project and are not repeated.
3. Identify omitted statuses as removals.
4. Reject the entire patch with `409` if any removed status has issues.
5. Delete unused omitted statuses, update retained statuses, and create entries without IDs.
6. Apply the submitted order and commit.

Existing IDs must be preserved when renaming or reordering a status. Renaming updates its display name for all associated issues without rewriting each issue. Project title and status changes in a single request are transactional: a failed status removal also rolls back the title change.

Issue creation and issue updates use the same project-row locking approach to coordinate with status edits. This is intentionally coarse-grained but appropriate for a small tracker.

### Concurrent editing

There are no revision numbers, ETags, or optimistic-concurrency checks. Patches update only supplied fields, but overlapping edits are last-write-wins. The web issue editor submits all editable fields when saving, so simultaneous editor sessions can overwrite each other’s changes. Project status edits replace the list and have the same last-write-wins limitation after transaction serialization.

## 5. Authentication and authorization

### User configuration

The API loads `config/users.json` at startup, or the path supplied by `USERS_FILE`. Configuration must contain at least one user, unique usernames, and valid bcrypt hash strings. Usernames are case-sensitive.

```json
{
  "users": [
    { "username": "alice", "passwordHash": "<full bcrypt hash>" }
  ]
}
```

`npm run user:add -- alice` prompts without echoing the password and writes a bcrypt hash with cost 12. Running it for an existing username replaces the hash. The helper creates the config if necessary and sets file permissions to `0600`. It requires at least 8 characters and at most 72 UTF-8 bytes, respecting bcrypt’s input limit.

There are no default credentials or signup endpoint. Config changes require an API restart. This administrative file is git-ignored, as is `.env`.

### Login and sessions

1. The client posts `{username, password}` to `/api/auth/login`.
2. The API verifies the password using bcrypt and returns a generic error for bad credentials.
3. On success, it generates a random 32-byte token, hex-encoded for transport.
4. Only the token’s SHA-256 hash is stored in Postgres, with the username and a seven-day expiration.
5. The response returns `{username, token}` and sets the browser session cookie.
6. Protected requests hash the supplied token, find an unexpired session, and verify that its user still exists in loaded config.

The browser uses `issues_session`, an HTTP-only, SameSite=Lax cookie scoped to `/api`. `COOKIE_SECURE=true` enables its Secure flag for HTTPS deployment. The web app does not persist the returned token in localStorage.

The CLI uses `Authorization: Bearer <token>` and stores the token, username, and API URL in `~/.config/minimal-issues/session.json` with mode `0600`. `ISSUES_CONFIG` can override this path. A saved token is only sent when the selected API URL matches its saved URL.

Logout deletes the current session record and clears the browser cookie; CLI logout also removes its local session file. Expiration is fixed rather than sliding. Expired rows are cleaned up during successful logins, and are rejected regardless of whether they have been cleaned up.

Removing a user and restarting the API blocks that user’s sessions. Changing a password does **not** automatically revoke existing sessions; they remain valid until logout or expiration unless the user is removed.

### Authorization and browser protections

Every authenticated user can read, create, edit, and delete every project, issue, and attachment. Assignment conveys no permission or ownership. Health and login are public; application data endpoints are authenticated.

Browser mutation requests with an `Origin` header must match the request’s origin or the exact configured `PUBLIC_ORIGIN`. Together with SameSite cookies, this protects against cross-origin cookie-based mutations. CORS is not enabled; the deployed web app and API should share one public origin. The CLI does not require browser CORS support.

Helmet supplies security headers. Failed login attempts are rate-limited by IP to 30 in 15 minutes; successful logins do not count against the limit. The limiter is in memory and local to the API process, not a distributed service. Behind a reverse proxy, IP grouping follows the current Express proxy configuration and should be reviewed if per-client limits are important.

## 6. API contract

The API is rooted at `/api`. Request and response bodies are JSON except attachment uploads and downloads. Project API routes use numeric IDs; the CLI resolves project keys through the API. Issue routes accept numeric IDs or human-readable keys.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/health` | Check database connectivity. |
| POST | `/auth/login` | Authenticate and issue a session. |
| POST | `/auth/logout` | Revoke the current session. |
| GET | `/auth/me` | Return the current username. |
| GET | `/projects` | List projects and their ordered statuses. |
| POST | `/projects` | Create a project and default statuses. |
| GET | `/projects/:id` | Read a project. |
| PATCH | `/projects/:id` | Update title and/or replace status configuration. |
| DELETE | `/projects/:id` | Permanently delete the project and dependent data. |
| GET | `/projects/:id/issues` | List issues; optional `statusId` and `search` filters. |
| POST | `/projects/:id/issues` | Create an issue. |
| GET | `/issues/:id-or-key` | Read issue details and attachment metadata. |
| PATCH | `/issues/:id-or-key` | Update issue fields. |
| DELETE | `/issues/:id-or-key` | Permanently delete an issue and its attachments. |
| POST | `/issues/:id-or-key/attachments` | Upload multipart field `file`. |
| GET | `/attachments/:id` | Download authenticated binary content. |
| DELETE | `/attachments/:id` | Permanently delete an attachment. |

Issue creation accepts:

```ts
{
  title: string;
  description?: string;
  notes?: string;
  statusId?: number;
  labels?: string[];
  assignee?: string;
}
```

Missing optional fields receive their defaults. Patches accept a non-empty subset of supported fields; omitted fields are unchanged. Empty strings clear Description, Notes, or assignee, and `[]` clears labels. Unknown project/issue mutation fields are rejected rather than silently persisted.

Issue responses include the current status object and attachment metadata, not binary content. Listings are ordered by descending issue number and return all matching issues. Search uses case-insensitive SQL pattern matching over issue key, title, assignee, and labels; it is not full-text search and does not search Description or Notes.

Downloads use `Content-Disposition: attachment`, `application/octet-stream`, and `Cache-Control: no-store`. Uploaded MIME metadata is retained but does not cause files to be served as executable inline content.

### Errors

Errors have the shape `{ "error": "message" }` and an appropriate HTTP status:

| Status | Typical meaning |
| --- | --- |
| 400 | Invalid input, empty patch, or status from another project. |
| 401 | Bad login, missing session, expired session, or revoked session. |
| 403 | Disallowed browser origin. |
| 404 | Missing project, issue, attachment, or endpoint. |
| 409 | Duplicate project key, removal of an in-use status, or conflicting related data. |
| 413 | File or request exceeds its size limit. |
| 429 | Login rate limit exceeded. |
| 500 | Unexpected server error; detailed error is logged server-side. |

Create operations return `201`, reads and updates return `200`, and successful deletes/logout return `204`. The shared client converts non-success responses into `ApiError` with a message and status, keeping error interpretation consistent between clients.

## 7. Client design

### Web app

The web app uses React state and a small hash-based router, without a separate state-management or routing framework. Routes identify the selected project and optionally an issue, for example `#/projects/1/issues/WEB-123`.

Its main surfaces are:

- **Login:** username/password form; current session checked on initial load.
- **Project sidebar:** project selection and creation.
- **Issue table:** key, title, status, assignee, and labels; inline status changes and attachment counts.
- **Issue detail editor:** explicit save for title, Description, Notes, status, labels, and assignee.
- **Markdown fields:** independent Write/Preview controls using `react-markdown` and `remark-gfm`; raw HTML is not rendered.
- **Attachment section:** files can be attached after issue creation; upload/delete operations persist separately from unsaved text edits.
- **Project settings:** rename project; add, rename, reorder, and remove statuses; edit completion flags; delete the project.

Search/filter changes request fresh API results after a short delay. Mutations update or refresh client state; returning to the table refreshes its issue list. There is no background subscription, autosave, or cross-client live update. Desktop and mobile layouts share the same functionality.

### CLI

The CLI is built with Commander and the shared `ApiClient`. Command groups are `project`, `issue`, and `attachment`, with `login`, `logout`, and `whoami` at the top level.

Project arguments accept a key or ID. Issue arguments accept a key or ID. Status arguments accept a name or ID, resolved from the project’s API response. Description and Notes can be supplied inline or read from local Markdown files. Status configuration can be supplied as a JSON array, preserving existing IDs.

Lists use terminal tables by default; `--json` exposes structured API data for scripts. Errors print a readable message and set a non-zero exit code. `--api` and `ISSUES_API_URL` select the server. The CLI reads/writes local input, download, and session files, but never application database records.

## 8. Permanent deletion

Deletion uses SQL `DELETE`, not a state transition:

```text
Delete attachment ── remove its row and stored blob
Delete issue ──────── remove issue + cascade to its attachments
Delete project ───── remove project + cascade to its issues, attachments, and statuses
```

Database foreign keys perform the cascades, so dependent removal is part of the database delete operation rather than a sequence of client cleanup calls. Issue deletion preserves the surviving project’s counter. Project deletion removes that counter with the project.

The web app asks for confirmation before destructive actions; the CLI requires `--yes`. These are client-side safeguards, not an API confirmation protocol: an authenticated API caller can directly issue a delete.

“Permanent” means the data is removed from the live application and there is no restore endpoint. It does not promise secure erasure of database storage, transaction logs, or previous backups. Operators must manage backup retention separately.

## 9. Operations and deployment

Runtime configuration is read from environment variables, with `.env` support:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string. |
| `PORT` | Node listening port; defaults to `3031`. |
| `USERS_FILE` | User configuration path; defaults to `config/users.json`. |
| `PUBLIC_ORIGIN` | Exact public browser origin allowed for mutations, useful behind a reverse proxy. |
| `COOKIE_SECURE` | Enable secure browser cookies; use `true` with HTTPS. |

Startup validates users, connects to Postgres, applies the initial schema, and starts serving requests. SIGINT/SIGTERM initiate HTTP server shutdown and then close the database pool. Run the server from the repository root because schema, default user-config, and built web paths are relative to that directory.

`db/001.sql` is an initial idempotent schema, applied automatically or through `npm run db:migrate`. It uses `CREATE TABLE IF NOT EXISTS`; it is **not a versioned migration system** and will not alter existing tables when their definitions change. Future deployed schema changes need explicit versioned migrations.

For production:

- Build with `npm run build`; run Node with `npm start`.
- Serve behind an HTTPS reverse proxy with web and API on one public origin.
- Set `PUBLIC_ORIGIN` to that origin and `COOKIE_SECURE=true`.
- Keep Postgres private and replace development credentials.
- Permit multipart uploads slightly larger than 25 MiB at the proxy.
- Protect config and session files; do not expose them as static assets.
- Back up Postgres to include issues, attachments, and session data together. A restored session remains subject to expiration and current user configuration.

The supplied Compose file runs only Postgres, with a localhost port binding and persistent volume. Node and Vite run through npm commands; no separate application Docker image is currently provided.

## 10. Testing strategy

Testing prioritizes end-to-end functionality and critical integrity/security failures rather than exhaustive defensive cases.

### API and CLI workflows

`tests/workflows.test.ts` uses real Postgres and a randomly named schema. It exercises HTTP requests and invokes the actual CLI against an API on an ephemeral port. Direct SQL assertions in tests verify storage and cascades; this does not relax the no-database-access rule for application clients.

Primary coverage includes:

- Cookie and bearer authentication, multiple users, logout, and session expiration.
- Project creation, retrieval, renaming, and default statuses.
- Issue creation, retrieval, editing, and Description/Notes persistence.
- Free-text assignees, labels, search, and status filtering.
- Any-to-any transitions and editable status configuration.
- Exact binary attachment round trips and permanent deletion.
- Concurrent issue creation with unique numbering and no reuse after deletion.
- Project/issue cascading deletes.
- CLI login, output, edits, file operations, status configuration, and deletes.

Important failures include unauthenticated access, bad credentials, cross-origin mutations, duplicate project keys, missing records, cross-project status assignment, and removal of an in-use status. A failed status update is checked for transactional rollback.

### Browser workflows

`tests/web.spec.ts` uses Playwright against the built production web app and its API. It starts its own server and isolated database schema, then exercises the main workflow at desktop and mobile viewport sizes, including Markdown previews and file download content.

Tests create/drop their own schemas rather than truncate application tables. `TEST_DATABASE_URL` selects a dedicated test database when supplied; otherwise tests use the normal connection configuration. The test database user needs permission to create schemas. No local user config or running development server is required for browser tests.

Verification commands:

```sh
npm run typecheck
npm test
npm run test:web
```

Install Chromium once with `npx playwright install chromium`. Browser test failures retain Playwright traces.

## 11. Deliberate trade-offs and evolution

| Decision | Benefit | Accepted limitation |
| --- | --- | --- |
| One Node API and direct SQL | Small, inspectable implementation and one place for business rules. | Manual SQL and schema evolution. |
| Config-defined users | Simple bootstrap without account-management features. | Restart required; no automatic revocation on password change. |
| Opaque database sessions | Logout/revocation is straightforward; tokens are hashed at rest. | Authenticated requests query Postgres. |
| Database attachment blobs | One backup/deletion model with enforced ownership. | Larger database and backups; uploads/downloads use memory. |
| Immutable project keys | Stable issue references while the project exists. | Changing an abbreviation is not supported. |
| Ordered, unrestricted statuses | Flexible work tracking with no workflow engine. | No transition rules or automatic actions. |
| Per-project locks | Simple numbering and status-edit coordination. | Writes within a busy project can serialize. |
| No pagination or live updates | Thin clients and a small API surface. | Large issue lists and multi-user freshness are limited. |
| Last-write-wins | No version/conflict UI to maintain. | Concurrent edits can overwrite each other. |

Add complexity only when real usage justifies it. Likely next steps, if needed, are versioned migrations, pagination with smaller list responses, optimistic concurrency, and improved user/session administration. Roles, workflow machinery, and moving files out of Postgres should require explicit product decisions rather than being introduced by default.
