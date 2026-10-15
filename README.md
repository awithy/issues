# Issues

A minimalist issue tracker with a React web app and CLI, built with TypeScript and Postgres.

For architecture, data models, API contracts, authentication details, testing strategy, and design trade-offs, see **[docs/design.md](docs/design.md)**.

## What’s included

- Projects and issues with keys such as `WEB-123`.
- Global issue types: **Bug, Issue, Task, Sub-Task, Story**. Only Sub-Tasks have a parent, and a parent is required. Parent details list direct sub-tasks with bulk creation, inline status changes, links to edit, and deletion.
- Undirected issue links, including across projects, visible from either issue.
- Searchable issue table with pagination (100, 500, or 1000 items per page), status filters, clickable labels that add removable match-all filters, inline status changes, click or J/K row selection, Enter to open details, S to pick a status (↑/↓ then Enter selects the next issue after saving; Esc cancels), Shift+K/J to raise/lower priority (shifting conflicts within the same status), and sorting by Key, Type, Status, or Assignee (Status then numeric priority by default, in workflow order; lower priority numbers first).
- Shared saved views under each project, filtering by labels (match all), statuses (match any), and issue types (match any).
- Integer issue priority (default **0**), ordering within a status and among sibling Sub-Tasks; never ranking across statuses.
- Markdown Description and Notes with previews, labels, free-text assignees, and an optional resolution date.
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

Build and install the `issctl` command on your PATH (requires your npm global bin directory on PATH):

```sh
npm run build
npm link
issctl --help
```

Run `issctl` from any directory. Rebuild after changing CLI source. You can still run the source directly from this directory with `npm run cli -- ...`.

```sh
issctl login alice
issctl whoami

issctl project create WEB "Website"
issctl project list
issctl project show WEB
issctl project update WEB --title "Web platform"

issctl issue create WEB "Build the landing page" \
  --description "A **simple** homepage" \
  --notes "Discuss the design with the team" \
  --assignee "External designer" --labels frontend,design

issctl issue types
issctl issue create WEB "Build a component" --issue-type Sub-Task --parent WEB-1
# Clear the parent and change type together, so no parentless Sub-Task is saved.
issctl issue update WEB-2 --parent "" --issue-type Task

issctl issue list WEB
issctl issue list WEB --status "in progress" --search landing
issctl issue show WEB-1
issctl issue update WEB-1 --priority 10
issctl issue update WEB-1 --status archived
issctl issue update WEB-1 --status backlog --notes-file ./notes.md
issctl issue update WEB-1 --description-file ./description.md
issctl issue update WEB-1 --labels "" --assignee ""

issctl issue link WEB-1 WEB-2
issctl issue links WEB-1
issctl issue unlink WEB-2 WEB-1

issctl attachment upload WEB-1 ./design.png
issctl attachment list WEB-1
issctl attachment download 1 ./downloaded-design.png
issctl attachment delete 1 --yes

issctl issue delete WEB-1 --yes
issctl project delete WEB --yes
issctl logout
```

`--priority` sets an integer ordering value (default `0`; lower comes first). Changing status assigns one more than the highest priority in the destination status, or `0` if empty, overriding any priority supplied in the same update. The web’s Shift+K/J shortcuts never move the selected issue or a shifted conflict below `0`. Status sorting uses priority only within each status, with descending issue number breaking ties. In the web table, matching parents also include their Sub-Tasks regardless of status filters (including saved-view statuses); search, label, and type filters still apply. Sub-Tasks are grouped beneath visible parents on the current page.

`--resolution-date` sets a resolution timestamp on create/update; use an empty string to clear. Timestamps use ISO 8601 with a timezone, e.g. `2024-05-20T17:00:00Z`.

Project arguments accept a key or numeric project ID. Issue arguments accept a key or numeric issue ID. Status arguments accept a name or numeric status ID. `--parent` accepts an issue key or ID; issue types default to `Issue`. In the web editor, clear the parent before selecting a different type, then save both changes together. Issue links accept keys or IDs for both issues and can be added or removed from either end. Unlinking does not delete either issue. CLI deletes require `--yes` because they cannot be undone.

Global options:

```sh
issctl --api http://localhost:3031/api login alice
issctl --json issue list WEB
issctl --help
issctl issue update --help
```

The CLI saves login information in `~/.config/minimal-issues/session.json`. Override that path with `ISSUES_CONFIG`, or select a different API URL with `ISSUES_API_URL`.

### Saved views

Click **+ New view** beneath a project in the sidebar, give it a title, and choose its filters. Views use the same issue table; **Edit view** changes the title/filters or deletes the view without deleting issues. **Duplicate view** opens a copy with the same saved filters and a default “Copy of …” title; edit it if needed, then create it in the same project. The original view and issues are unchanged. Filters combine with AND across categories; an empty category matches everything. Labels are exact and case-sensitive. Views persist in the database and are shared with all users.

```sh
issctl view create WEB "Urgent work" --labels frontend,urgent \
  --statuses "backlog,in progress" --issue-types Bug,Task
issctl view list WEB
issctl view duplicate WEB 1
issctl view duplicate WEB 1 --title "Frontend copy"
issctl issue list WEB --view 1
issctl view update WEB 1 --title "Frontend work" --labels frontend
issctl view delete WEB 1 --yes
```

Use a view ID from `view list`. Remove a status from saved views before deleting that status.

### Customize statuses

The web app exposes status editing under **Project settings**. In the CLI:

```sh
issctl --json project statuses WEB > statuses.json
# Edit statuses.json, preserving statusId for statuses you want to keep.
# Omit statusId on newly added statuses. Array order sets display/default order.
issctl project statuses WEB --file statuses.json
```

`issctl --json` writes JSON without an npm script banner, so its output can be redirected directly to a file.

Each status is `{ "statusId": 1, "title": "backlog", "isComplete": false }`. Keep at least one status, and move issues out of a status and remove it from saved views before deleting it.

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

