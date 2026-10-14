# Issues

A minimalist issue tracker with a React web app and CLI, built with TypeScript and Postgres.

For architecture, data models, API contracts, authentication details, testing strategy, and design trade-offs, see **[docs/design.md](docs/design.md)**.

## What’s included

- Projects and issues with keys such as `WEB-123`.
- Global issue types: **Bug, Issue, Task, Sub-Task, Story**. Only Sub-Tasks have a parent, and a parent is required.
- Searchable issue table, status filters, and inline status changes.
- Markdown Description and Notes with previews, labels, and free-text assignees.
- Customizable statuses with unrestricted transitions; defaults are **backlog → design → ready → in progress → done → archived**.
- Multi-user login; every authenticated user has full access.
- File attachments, up to **25 MB per file**.
- Permanent deletion of attachments, issues, and projects. Deleting an issue or project also deletes its dependent data. Parents cannot be deleted while Sub-Tasks outside the deletion still reference them.

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

Log in with one of the usernames/passwords you configured. There are no default credentials. The API applies schema migrations automatically on startup. `npm run db:migrate` can also apply them explicitly.

If you change `PORT`, restart development and set the CLI’s API URL with `--api` or `ISSUES_API_URL`.

### Configuration

Copy `.env.example` to `.env` and adjust as needed:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://issues:issues@localhost:5432/issues` | Postgres connection string |
| `PORT` | `3031` | API/production web port |
| `USERS_FILE` | `config/users.json` | User config loaded at API startup |
| `PUBLIC_ORIGIN` | unset in code; example uses `http://localhost:5173` | Additional permitted browser origin, useful behind a reverse proxy |
| `COOKIE_SECURE` | `false` | Set `true` for HTTPS deployment |

Serve the web app and API on the same public origin. Set `PUBLIC_ORIGIN` to that URL when deploying behind a reverse proxy.

`compose.yaml` binds Postgres to localhost and uses a persistent Docker volume. Its development credentials should be changed for production. Stop it with `docker compose down`; this preserves the database volume. **`docker compose down -v` destroys the database.**

### Users

Run `npm run user:add -- alice` to add a user or replace an existing user’s password. The command prompts for a password and updates `config/users.json` (or `USERS_FILE`). **Restart the API after changing users.** There is no user-management UI.

Passwords must be at least 8 characters and at most 72 UTF-8 bytes. For automation, set `ISSUES_PASSWORD` for the user-config command or CLI login. Do not commit `.env`, user configs, or CLI session tokens.

Changing a password does not revoke existing sessions. To block a user’s access, remove them from the config and restart the API.

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

npm run cli -- issue types
npm run cli -- issue create WEB "Build a component" --issue-type Sub-Task --parent WEB-1
# Clear the parent and change type together, so no parentless Sub-Task is saved.
npm run cli -- issue update WEB-2 --parent "" --issue-type Task

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

Project arguments accept a key or numeric project ID. Issue arguments accept a key or numeric issue ID. Status arguments accept a name or numeric status ID. `--parent` accepts an issue key or ID; issue types default to `Issue`. In the web editor, clear the parent before selecting a different type, then save both changes together. CLI deletes require `--yes` because they cannot be undone.

Global options:

```sh
npm run cli -- --api http://localhost:3031/api login alice
npm run cli -- --json issue list WEB
npm run cli -- --help
npm run cli -- issue update --help
```

The CLI saves login information in `~/.config/minimal-issues/session.json`. Override that path with `ISSUES_CONFIG`, or select a different API URL with `ISSUES_API_URL`.

### Customize statuses

The web app exposes status editing under **Project settings**. In the CLI:

```sh
npm run --silent cli -- --json project statuses WEB > statuses.json
# Edit statuses.json, preserving statusId for statuses you want to keep.
# Omit statusId on newly added statuses. Array order sets display/default order.
npm run cli -- project statuses WEB --file statuses.json
```

Use `npm run --silent cli -- ...` when redirecting JSON to a file so npm’s script banner is not included.

Each status is `{ "statusId": 1, "title": "backlog", "isComplete": false }`. Keep at least one status, and move issues out of a status before removing it.

## Tests

Tests require a running Postgres database and a user with permission to create schemas. They use isolated schemas, leaving application tables intact. Set `TEST_DATABASE_URL` to use a separate test database; otherwise `DATABASE_URL` is used.

```sh
docker compose up -d --wait
npm run typecheck
npm test

# One-time browser installation (Linux CI may also need --with-deps).
npx playwright install chromium
npm run test:web
```

- `npm test`: API and CLI workflow tests.
- `npm run test:web`: production-build browser tests in Chromium at desktop and mobile sizes. No development server or user config is needed.

## Production

```sh
npm ci
npm run build
# Configure DATABASE_URL, USERS_FILE, PUBLIC_ORIGIN and COOKIE_SECURE first.
NODE_ENV=production npm start
```

Run from the repository root. The app listens on `PORT` (default `3031`). Use an HTTPS reverse proxy, set `PUBLIC_ORIGIN` to the public URL (scheme + host + optional port, without a trailing slash), and set `COOKIE_SECURE=true`. Keep Postgres private and replace the development database credentials. Configure proxy upload limits to allow 25 MB files plus multipart overhead.

Back up Postgres to back up issues **and files**. Permanent deletion removes live application records; existing database backups are not rewritten or securely erased.

