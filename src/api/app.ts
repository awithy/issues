import express from 'express';
import type { ErrorRequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit } from 'express-rate-limit';
import { compare } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';
import { z } from 'zod';
import { Repository } from './repository.js';
import { HttpError } from './db.js';
import type { User } from './users.js';
import { ISSUE_TYPES, ISSUE_PAGE_SIZES, ISSUE_SORT_COLUMNS } from '../shared/types.js';
import { attachmentImageType } from '../shared/attachments.js';

const id = z.coerce.number().int().positive().max(2147483647);
const title = z.string().trim().min(1).max(300);
const timestamp = z.iso.datetime({ offset: true });
const issueInput = z.object({
  title, issueType: z.enum(ISSUE_TYPES).optional(), parentIssueId: id.nullable().optional(),
  description: z.string().max(500000).optional(), notes: z.string().max(500000).optional(),
  priority: z.number().int().min(-2147483648).max(2147483647).optional(),
  statusId: id.optional(), labels: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  assignee: z.string().trim().max(300).optional(), resolutionDate: timestamp.nullable().optional(),
}).strict();
// Leave room for the next-number counter in PostgreSQL's integer column.
const issueCreateInput = issueInput.extend({
  issueNumber: z.number().int().positive().max(2147483646).optional(),
  createdAt: timestamp.optional(), updatedAt: timestamp.optional(),
});
const nonempty = (value: object) => Object.keys(value).length > 0;
const projectInput = z.object({ title, key: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{0,11}$/, 'Use 1–12 letters or numbers, starting with a letter') }).strict();
const statuses = z.array(z.object({ statusId: id.optional(), title: z.string().trim().min(1).max(100), isComplete: z.boolean() }).strict()).min(1).max(30)
  .refine(values => new Set(values.map(s => s.title.toLowerCase())).size === values.length, 'Status names must be unique');
const projectPatch = z.object({ title: title.optional(), issueStatuses: statuses.optional() }).strict().refine(nonempty, 'Provide a field to update');
const viewFilters = z.object({
  labels: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  statusIds: z.array(id).max(30).default([]),
  issueTypes: z.array(z.enum(ISSUE_TYPES)).max(ISSUE_TYPES.length).default([]),
}).strict();
const viewInput = z.object({ title, filters: viewFilters.default({ labels: [], statusIds: [], issueTypes: [] }) }).strict();
const viewPatch = z.object({ title: title.optional(), filters: viewFilters.optional() }).strict().refine(nonempty, 'Provide a field to update');
const issueRef = (value: unknown) => z.string().trim().toUpperCase().regex(/^(?:[1-9]\d*|[A-Z][A-Z0-9]{0,11}-[1-9]\d*)$/, 'Use an issue ID or key such as WEB-123').parse(value);
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieName = 'issues_session';
const sessionMs = 7 * 24 * 60 * 60 * 1000;

export function createApp(options: { pool: pg.Pool; users: User[]; publicOrigin?: string; secureCookies?: boolean; webDir?: string }) {
  const { pool, users } = options;
  const repo = new Repository(pool);
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ strictTransportSecurity: options.secureCookies ? undefined : false }));
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());
  const router = express.Router();
  const cookieOptions = { httpOnly: true, sameSite: 'lax' as const, secure: !!options.secureCookies, path: '/api' };
  router.use((req, _res, next) => {
    // Cookies are same-site; also reject cross-origin browser mutations (including login).
    const origin = req.get('origin');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && origin !== options.publicOrigin && origin !== req.protocol + '://' + req.get('host')) return next(new HttpError(403, 'Cross-origin requests are not allowed'));
    next();
  });
  router.get('/health', async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); });
  router.post('/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, skipSuccessfulRequests: true, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Too many login attempts. Try again later.' } }), async (req, res) => {
    const input = z.object({ username: z.string().trim().min(1).max(100), password: z.string().min(1).max(1000) }).parse(req.body);
    const user = users.find(u => u.username === input.username);
    const matches = await compare(input.password, user?.passwordHash ?? users[0]!.passwordHash);
    if (!user || !matches || Buffer.byteLength(input.password) > 72) throw new HttpError(401, 'Invalid username or password');
    const token = randomBytes(32).toString('hex');
    await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    await pool.query('INSERT INTO sessions(token_hash,username,expires_at) VALUES ($1,$2,$3)', [tokenHash(token), user.username, new Date(Date.now() + sessionMs)]);
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: sessionMs });
    res.json({ username: user.username, token });
  });
  router.use(async (req, res, next) => {
    const authorization = req.get('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : req.cookies[cookieName];
    if (!token || typeof token !== 'string') throw new HttpError(401, 'Please log in');
    const session = (await pool.query<{ username: string }>('SELECT username FROM sessions WHERE token_hash=$1 AND expires_at > now()', [tokenHash(token)])).rows[0];
    if (!session || !users.some(u => u.username === session.username)) throw new HttpError(401, 'Session expired. Please log in');
    res.locals.username = session.username; res.locals.tokenHash = tokenHash(token); next();
  });
  router.get('/auth/me', (_req, res) => res.json({ username: res.locals.username }));
  router.post('/auth/logout', async (_req, res) => {
    await pool.query('DELETE FROM sessions WHERE token_hash=$1', [res.locals.tokenHash]);
    res.clearCookie(cookieName, cookieOptions); res.sendStatus(204);
  });
  router.get('/issue-types', (_req, res) => res.json(ISSUE_TYPES));
  router.get('/projects', async (_req, res) => res.json(await repo.projects()));
  router.post('/projects', async (req, res) => { const input = projectInput.parse(req.body); res.status(201).json(await repo.createProject(input.title, input.key)); });
  router.get('/projects/:id', async (req, res) => res.json(await repo.project(id.parse(req.params.id))));
  router.patch('/projects/:id', async (req, res) => res.json(await repo.updateProject(id.parse(req.params.id), projectPatch.parse(req.body))));
  router.delete('/projects/:id', async (req, res) => { await repo.deleteProject(id.parse(req.params.id)); res.sendStatus(204); });
  router.get('/projects/:id/views', async (req, res) => res.json(await repo.views(id.parse(req.params.id))));
  router.post('/projects/:id/views', async (req, res) => res.status(201).json(await repo.saveView(id.parse(req.params.id), viewInput.parse(req.body))));
  router.get('/projects/:id/views/:viewId', async (req, res) => res.json(await repo.view(id.parse(req.params.id), id.parse(req.params.viewId))));
  router.patch('/projects/:id/views/:viewId', async (req, res) => res.json(await repo.saveView(id.parse(req.params.id), viewPatch.parse(req.body), id.parse(req.params.viewId))));
  router.delete('/projects/:id/views/:viewId', async (req, res) => { await repo.deleteView(id.parse(req.params.id), id.parse(req.params.viewId)); res.sendStatus(204); });
  router.get('/projects/:id/issues', async (req, res) => {
    const { page, pageSize, ...filters } = z.object({
      statusId: id.optional(), search: z.string().max(300).optional(), viewId: id.optional(),
      labels: z.preprocess(value => typeof value === 'string' ? [value] : value, z.array(z.string().trim().min(1).max(100)).max(50).optional()),
      sortBy: z.enum(ISSUE_SORT_COLUMNS).optional(), sortDirection: z.enum(['asc', 'desc']).optional(),
      page: id.default(1),
      pageSize: z.coerce.number().pipe(z.union(ISSUE_PAGE_SIZES.map(size => z.literal(size)))).optional(),
    }).parse(req.query);
    const projectId = id.parse(req.params.id);
    res.json(pageSize === undefined ? await repo.issues(projectId, filters) : await repo.issues(projectId, filters, { page, pageSize }));
  });
  router.post('/projects/:id/issues', async (req, res) => res.status(201).json(await repo.createIssue(id.parse(req.params.id), issueCreateInput.parse(req.body))));
  router.get('/issues/:ref', async (req, res) => res.json(await repo.issue(issueRef(req.params.ref))));
  router.patch('/issues/:ref', async (req, res) => res.json(await repo.updateIssue(issueRef(req.params.ref), issueInput.partial().extend({ updatedAt: timestamp.optional() }).refine(nonempty, 'Provide a field to update').parse(req.body))));
  router.post('/issues/:ref/priority', async (req, res) => {
    const { delta } = z.object({ delta: z.union([z.literal(-1), z.literal(1)]) }).strict().parse(req.body);
    res.json(await repo.adjustIssuePriority(issueRef(req.params.ref), delta));
  });
  router.delete('/issues/:ref', async (req, res) => { await repo.deleteIssue(issueRef(req.params.ref)); res.sendStatus(204); });
  router.put('/issues/:ref/links/:other', async (req, res) => { await repo.linkIssue(issueRef(req.params.ref), issueRef(req.params.other)); res.sendStatus(204); });
  router.delete('/issues/:ref/links/:other', async (req, res) => { await repo.unlinkIssue(issueRef(req.params.ref), issueRef(req.params.other)); res.sendStatus(204); });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1, fields: 0 } });
  router.post('/issues/:ref/attachments', upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Attach a file using the file field');
    const uploadKey = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/).optional().parse(req.get('Idempotency-Key'));
    res.status(201).json(await repo.upload(issueRef(req.params.ref), req.file, uploadKey));
  });
  router.get('/attachments/:id', async (req, res) => {
    const attachment = await repo.attachment(id.parse(req.params.id));
    const imageType = req.query.preview === '1' ? attachmentImageType(attachment) : undefined;
    res.attachment(attachment.filename).type(imageType || 'application/octet-stream');
    if (imageType) res.set('Content-Disposition', res.get('Content-Disposition')!.replace(/^attachment/, 'inline'));
    res.set('Cache-Control', 'no-store').send(attachment.data);
  });
  router.delete('/attachments/:id', async (req, res) => { await repo.deleteAttachment(id.parse(req.params.id)); res.sendStatus(204); });
  router.use((_req, _res, next) => next(new HttpError(404, 'API endpoint not found')));
  app.use('/api', router);
  const webDir = options.webDir ?? resolve('dist/web');
  if (existsSync(resolve(webDir, 'index.html'))) {
    app.use(express.static(webDir));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(webDir, 'index.html')));
  }
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues.map(i => (i.path.join('.') ? i.path.join('.') + ': ' : '') + i.message).join('; ') }); return; }
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    if (error instanceof multer.MulterError) { res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File is too large (maximum 25 MB)' : error.message }); return; }
    if (error.code === '23505') { res.status(409).json({ error: error.constraint === 'issues_project_id_issue_number_key' ? 'That issue number already exists in this project' : 'That project key already exists' }); return; }
    if (error.code === '23503') { res.status(409).json({ error: error.constraint === 'issues_parent_issue_id_fkey' ? 'Move or delete child Sub-Tasks before deleting their parent issue or project.' : 'A related record changed. Refresh and try again.' }); return; }
    if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') { res.status(error.status).json({ error: error.type === 'entity.too.large' ? 'Request is too large' : 'Invalid JSON' }); return; }
    console.error(error); res.status(500).json({ error: 'Internal server error' });
  };
  app.use(errors);
  return app;
}
