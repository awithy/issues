import type pg from 'pg';
import type { Attachment, CreateIssueInput, Issue, UpdateIssueInput, Project, StatusInput, IssueFilters, IssuePagination, IssuePage, ProjectView, ViewInput } from '../shared/types.js';
import { DEFAULT_STATUSES } from '../shared/types.js';
import { HttpError, transaction } from './db.js';
type Db = pg.Pool | pg.PoolClient;
const statusJson = "json_build_object('statusId', s.status_id, 'title', s.title, 'isComplete', s.is_complete)";
const viewColumns = 'view_id AS "viewId", project_id AS "projectId", title, filters';
const projectSelect =   "SELECT p.project_id AS \"projectId\", p.title, p.key, " +
  "COALESCE((SELECT json_agg(" + statusJson + " ORDER BY s.position) FROM issue_statuses s WHERE s.project_id=p.project_id), '[]') AS \"issueStatuses\", " +
  "COALESCE((SELECT json_agg(v ORDER BY v.\"viewId\") FROM (SELECT " + viewColumns + " FROM project_views WHERE project_id=p.project_id) v), '[]') AS views FROM projects p";
const attachmentColumns = 'attachment_id AS "attachmentId", filename, content_type AS "contentType", octet_length(data) AS size, created_at AS "createdAt"';
const issueSelect =   "SELECT i.issue_id AS \"issueId\", i.project_id AS \"projectId\", p.key || '-' || i.issue_number AS \"issueKey\", " +
  "i.issue_type AS \"issueType\", i.parent_issue_id AS \"parentIssueId\", i.title, i.description, i.notes, i.labels, i.assignee, i.created_at AS \"createdAt\", i.updated_at AS \"updatedAt\", i.resolution_date AS \"resolutionDate\", " + statusJson + " AS status, " +
  "COALESCE((SELECT json_agg(a ORDER BY a.\"attachmentId\") FROM (SELECT " + attachmentColumns + " FROM attachments WHERE issue_id=i.issue_id) a), '[]') AS attachments, " +
  "COALESCE((SELECT json_agg(json_build_object('issueId', linked.issue_id, 'projectId', linked.project_id, 'issueKey', lp.key || '-' || linked.issue_number, 'title', linked.title) ORDER BY lp.key, linked.issue_number) " +
  "FROM issue_links l JOIN issues linked ON linked.issue_id=CASE WHEN l.issue_id_a=i.issue_id THEN l.issue_id_b ELSE l.issue_id_a END " +
  "JOIN projects lp ON lp.project_id=linked.project_id WHERE l.issue_id_a=i.issue_id OR l.issue_id_b=i.issue_id), '[]') AS \"linkedIssues\" " +
  "FROM issues i JOIN projects p USING (project_id) JOIN issue_statuses s ON s.status_id=i.status_id";
function issueWhere(ref: string | number) {
  return /^\d+$/.test(String(ref)) ? 'i.issue_id=$1' : "p.key || '-' || i.issue_number=$1";
}
export class Repository {
  constructor(public pool: pg.Pool) {}
  async projects() { return (await this.pool.query<Project>(projectSelect + ' ORDER BY p.project_id')).rows; }
  async project(id: number, db: Db = this.pool) {
    const row = (await db.query<Project>(projectSelect + ' WHERE p.project_id=$1', [id])).rows[0];
    if (!row) throw new HttpError(404, 'Project not found'); return row;
  }
  async createProject(title: string, key: string) {
    return transaction(this.pool, async db => {
      const { rows: [row] } = await db.query<{ project_id: number }>('INSERT INTO projects(title, key) VALUES ($1,$2) RETURNING project_id', [title, key]);
      const id = row!.project_id;
      for (const [position, status] of DEFAULT_STATUSES.entries()) await db.query('INSERT INTO issue_statuses(project_id,title,is_complete,position) VALUES ($1,$2,$3,$4)', [id, status.title, status.isComplete, position]);
      return this.project(id, db);
    });
  }
  async updateProject(id: number, input: { title?: string; issueStatuses?: StatusInput[] }) {
    return transaction(this.pool, async db => {
      await db.query('SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE', [id]);
      const project = await this.project(id, db);
      if (input.title !== undefined) await db.query('UPDATE projects SET title=$2 WHERE project_id=$1', [id, input.title]);
      if (input.issueStatuses) {
        const keep = input.issueStatuses.flatMap(s => s.statusId === undefined ? [] : [s.statusId]);
        if (new Set(keep).size !== keep.length || keep.some(id => !project.issueStatuses.some(s => s.statusId === id))) throw new HttpError(400, 'Invalid or repeated status ID');
        const removed = project.issueStatuses.filter(s => !keep.includes(s.statusId)).map(s => s.statusId);
        const used = await db.query('SELECT 1 FROM issues WHERE project_id=$1 AND status_id=ANY($2::int[]) LIMIT 1', [id, removed]);
        if (used.rowCount) throw new HttpError(409, 'Move issues out of a status before deleting it');
        if (project.views.some(v => v.filters.statusIds.some(id => removed.includes(id)))) throw new HttpError(409, 'Remove the status from saved views before deleting it');
        await db.query('DELETE FROM issue_statuses WHERE project_id=$1 AND status_id=ANY($2::int[])', [id, removed]);
        for (const [position, status] of input.issueStatuses.entries()) {
          if (status.statusId !== undefined) await db.query('UPDATE issue_statuses SET title=$2, is_complete=$3, position=$4 WHERE status_id=$1', [status.statusId, status.title, status.isComplete, position]);
          else await db.query('INSERT INTO issue_statuses(project_id,title,is_complete,position) VALUES ($1,$2,$3,$4)', [id, status.title, status.isComplete, position]);
        }
      }
      return this.project(id, db);
    });
  }
  async deleteProject(id: number) {
    const result = await this.pool.query('DELETE FROM projects WHERE project_id=$1', [id]);
    if (!result.rowCount) throw new HttpError(404, 'Project not found');
  }
  async views(projectId: number) { return (await this.project(projectId)).views; }
  async view(projectId: number, viewId: number, db: Db = this.pool) {
    const row = (await db.query<ProjectView>('SELECT ' + viewColumns + ' FROM project_views WHERE project_id=$1 AND view_id=$2', [projectId, viewId])).rows[0];
    if (!row) throw new HttpError(404, 'View not found'); return row;
  }
  async saveView(projectId: number, input: Partial<ViewInput>, viewId?: number) {
    return transaction(this.pool, async db => {
      await db.query('SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE', [projectId]);
      const project = await this.project(projectId, db);
      const current = viewId === undefined ? undefined : await this.view(projectId, viewId, db);
      const title = input.title ?? current!.title;
      const filters = input.filters ?? current!.filters;
      if (filters.statusIds.some(id => !project.issueStatuses.some(s => s.statusId === id))) throw new HttpError(400, 'Status does not belong to this project');
      const values = [projectId, title, JSON.stringify(filters)];
      if (viewId === undefined) return (await db.query<ProjectView>('INSERT INTO project_views(project_id,title,filters) VALUES ($1,$2,$3) RETURNING ' + viewColumns, values)).rows[0]!;
      return (await db.query<ProjectView>('UPDATE project_views SET title=$2,filters=$3 WHERE project_id=$1 AND view_id=$4 RETURNING ' + viewColumns, [...values, viewId])).rows[0]!;
    });
  }
  async deleteView(projectId: number, viewId: number) {
    const result = await this.pool.query('DELETE FROM project_views WHERE project_id=$1 AND view_id=$2', [projectId, viewId]);
    if (!result.rowCount) throw new HttpError(404, 'View not found');
  }
  async issues(projectId: number, filters: IssueFilters): Promise<Issue[]>;
  async issues(projectId: number, filters: IssueFilters, pagination: IssuePagination): Promise<IssuePage>;
  async issues(projectId: number, filters: IssueFilters, pagination?: IssuePagination): Promise<Issue[] | IssuePage> {
    await this.project(projectId);
    const values: unknown[] = [projectId];
    let where = ' WHERE i.project_id=$1';
    if (filters.viewId) {
      const view = await this.view(projectId, filters.viewId);
      if (view.filters.labels.length) { values.push(view.filters.labels); where += ' AND i.labels @> $' + values.length + '::text[]'; }
      if (view.filters.statusIds.length) { values.push(view.filters.statusIds); where += ' AND i.status_id=ANY($' + values.length + '::int[])'; }
      if (view.filters.issueTypes.length) { values.push(view.filters.issueTypes); where += ' AND i.issue_type=ANY($' + values.length + '::text[])'; }
    }
    if (filters.statusId) { values.push(filters.statusId); where += ' AND i.status_id=$' + values.length; }
    if (filters.search) {
      values.push('%' + filters.search + '%'); const param = '$' + values.length;
      where += " AND (i.title ILIKE " + param + " OR p.key || '-' || i.issue_number ILIKE " + param + " OR i.assignee ILIKE " + param + " OR array_to_string(i.labels, ',') ILIKE " + param + ')';
    }
    // Only allowlisted expressions and directions are interpolated into SQL.
    const sortColumns = { key: 'i.issue_number', type: 'lower(i.issue_type)', status: 's.position', assignee: "NULLIF(lower(i.assignee), '')" };
    const sortBy = filters.sortBy ?? 'status';
    const direction = (filters.sortDirection ?? 'asc') === 'asc' ? 'ASC' : 'DESC';
    const orderBy = ' ORDER BY ' + sortColumns[sortBy] + ' ' + direction + ' NULLS LAST' + (sortBy === 'key' ? '' : ', i.issue_number DESC');
    if (!pagination) return (await this.pool.query<Issue>(issueSelect + where + orderBy, values)).rows;
    const counts = (await this.pool.query<{ total: number; complete: number }>(
      'SELECT count(*)::int AS total, count(*) FILTER (WHERE s.is_complete)::int AS complete ' +
      'FROM issues i JOIN projects p USING (project_id) JOIN issue_statuses s ON s.status_id=i.status_id' + where, values,
    )).rows[0]!;
    const page = Math.min(pagination.page, Math.max(1, Math.ceil(counts.total / pagination.pageSize)));
    values.push(pagination.pageSize, (page - 1) * pagination.pageSize);
    const items = (await this.pool.query<Issue>(issueSelect + where + orderBy + ' LIMIT $' + (values.length - 1) + ' OFFSET $' + values.length, values)).rows;
    return { items, ...counts, page, pageSize: pagination.pageSize };
  }
  async issue(ref: string | number, db: Db = this.pool) {
    const row = (await db.query<Issue>(issueSelect + ' WHERE ' + issueWhere(ref), [ref])).rows[0];
    if (!row) throw new HttpError(404, 'Issue not found'); return row;
  }
  async validateParent(db: Db, issueType: string, parentIssueId: number | null, issueId?: number) {
    if ((issueType === 'Sub-Task') !== (parentIssueId !== null)) throw new HttpError(400, 'Only Sub-Tasks can have a parent, and Sub-Tasks must have a parent');
    if (parentIssueId === null) return;
    if (!(await db.query('SELECT 1 FROM issues WHERE issue_id=$1', [parentIssueId])).rowCount) throw new HttpError(400, 'Parent issue not found');
    if (issueId !== undefined) {
      const cycle = await db.query(`WITH RECURSIVE ancestors AS (
        SELECT issue_id, parent_issue_id FROM issues WHERE issue_id=$1
        UNION
        SELECT i.issue_id, i.parent_issue_id FROM issues i JOIN ancestors a ON i.issue_id=a.parent_issue_id
      ) SELECT 1 FROM ancestors WHERE issue_id=$2`, [parentIssueId, issueId]);
      if (cycle.rowCount) throw new HttpError(400, 'An issue cannot be its own parent or a descendant of itself');
    }
  }
  async lockParents(db: Db) {
    // Parents can span projects; serialize graph edits so concurrent edits cannot create cycles.
    await db.query("SELECT pg_advisory_xact_lock(hashtext(current_schema() || '.issue_parents'))");
  }
  async createIssue(projectId: number, input: CreateIssueInput) {
    return transaction(this.pool, async db => {
      if (input.parentIssueId != null) await this.lockParents(db);
      // Both paths lock the project; explicit numbers advance the counter but never lower it.
      const { rows: [counter] } = await db.query<{ issue_number: number }>(
        input.issueNumber === undefined
          ? 'UPDATE projects SET next_issue_number=next_issue_number+1 WHERE project_id=$1 RETURNING next_issue_number-1 AS issue_number'
          : 'UPDATE projects SET next_issue_number=GREATEST(next_issue_number,$2::integer+1) WHERE project_id=$1 RETURNING $2::integer AS issue_number',
        input.issueNumber === undefined ? [projectId] : [projectId, input.issueNumber],
      );
      if (!counter) throw new HttpError(404, 'Project not found');
      const project = await this.project(projectId, db);
      const statusId = input.statusId ?? project.issueStatuses[0]!.statusId;
      if (!project.issueStatuses.some(s => s.statusId === statusId)) throw new HttpError(400, 'Status does not belong to this project');
      const issueType = input.issueType ?? 'Issue';
      const parentIssueId = input.parentIssueId ?? null;
      await this.validateParent(db, issueType, parentIssueId);
      const { rows: [row] } = await db.query<{ issue_id: number }>('INSERT INTO issues(project_id,issue_number,title,description,notes,status_id,labels,assignee,issue_type,parent_issue_id,created_at,updated_at,resolution_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11::timestamptz,now()),COALESCE($12::timestamptz,$11::timestamptz,now()),$13) RETURNING issue_id', [projectId, counter.issue_number, input.title, input.description ?? '', input.notes ?? '', statusId, input.labels ?? [], input.assignee ?? '', issueType, parentIssueId, input.createdAt ?? null, input.updatedAt ?? null, input.resolutionDate ?? null]);
      return this.issue(row!.issue_id, db);
    });
  }
  async updateIssue(ref: string | number, input: UpdateIssueInput) {
    return transaction(this.pool, async db => {
      if (input.parentIssueId !== undefined) await this.lockParents(db);
      const initial = await this.issue(ref, db);
      await db.query('SELECT project_id FROM projects WHERE project_id=$1 FOR UPDATE', [initial.projectId]);
      // Read again after the lock, so validation uses the latest saved parent and type.
      const current = await this.issue(ref, db);
      const project = await this.project(current.projectId, db);
      if (current.parentIssueId !== null && input.issueType !== undefined && input.issueType !== current.issueType && input.parentIssueId !== null) throw new HttpError(400, 'Remove the parent before changing a Sub-Task type (send parentIssueId: null with the new type)');
      await this.validateParent(db, input.issueType ?? current.issueType, input.parentIssueId === undefined ? current.parentIssueId : input.parentIssueId, current.issueId);
      if (input.statusId !== undefined && !project.issueStatuses.some(s => s.statusId === input.statusId)) throw new HttpError(400, 'Status does not belong to this project');
      const columns: Record<string, string> = { title: 'title', description: 'description', notes: 'notes', statusId: 'status_id', labels: 'labels', assignee: 'assignee', issueType: 'issue_type', parentIssueId: 'parent_issue_id', resolutionDate: 'resolution_date', updatedAt: 'updated_at' };
      const values: unknown[] = [current.issueId];
      const sets = Object.entries(input).map(([key, value]) => { values.push(value); return columns[key] + '=$' + values.length; });
      if (input.updatedAt === undefined) sets.push('updated_at=now()');
      await db.query('UPDATE issues SET ' + sets.join(',') + ' WHERE issue_id=$1', values);
      return this.issue(current.issueId, db);
    });
  }
  async deleteIssue(ref: string | number) {
    const issue = await this.issue(ref);
    await this.pool.query('DELETE FROM issues WHERE issue_id=$1', [issue.issueId]);
  }
  private async linkPair(ref: string | number, other: string | number) {
    const [a, b] = await Promise.all([this.issue(ref), this.issue(other)]);
    if (a.issueId === b.issueId) throw new HttpError(400, 'An issue cannot link to itself');
    return [Math.min(a.issueId, b.issueId), Math.max(a.issueId, b.issueId)];
  }
  async linkIssue(ref: string | number, other: string | number) {
    const pair = await this.linkPair(ref, other);
    await this.pool.query('INSERT INTO issue_links(issue_id_a, issue_id_b) VALUES ($1,$2) ON CONFLICT DO NOTHING', pair);
  }
  async unlinkIssue(ref: string | number, other: string | number) {
    const pair = await this.linkPair(ref, other);
    await this.pool.query('DELETE FROM issue_links WHERE issue_id_a=$1 AND issue_id_b=$2', pair);
  }
  async upload(ref: string | number, file: { originalname: string; mimetype: string; buffer: Buffer }, uploadKey?: string) {
    return transaction(this.pool, async db => {
      const issue = await this.issue(ref, db);
      if (uploadKey) {
        await db.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [issue.issueId, uploadKey]);
        const previous = (await db.query<Attachment & { data: Buffer }>('SELECT ' + attachmentColumns + ', data FROM attachments WHERE issue_id=$1 AND upload_key=$2', [issue.issueId, uploadKey])).rows[0];
        if (previous) {
          if (previous.filename !== file.originalname || previous.contentType !== file.mimetype || !previous.data.equals(file.buffer)) throw new HttpError(409, 'Upload key already used for different content');
          const { data: _data, ...attachment } = previous;
          return attachment;
        }
      }
      return (await db.query<Attachment>('INSERT INTO attachments(issue_id,filename,content_type,data,upload_key) VALUES ($1,$2,$3,$4,$5) RETURNING ' + attachmentColumns, [issue.issueId, file.originalname, file.mimetype, file.buffer, uploadKey ?? null])).rows[0]!;
    });
  }
  async attachment(id: number) {
    const row = (await this.pool.query<Attachment & { data: Buffer }>('SELECT ' + attachmentColumns + ', data FROM attachments WHERE attachment_id=$1', [id])).rows[0];
    if (!row) throw new HttpError(404, 'Attachment not found'); return row;
  }
  async deleteAttachment(id: number) {
    const result = await this.pool.query('DELETE FROM attachments WHERE attachment_id=$1', [id]);
    if (!result.rowCount) throw new HttpError(404, 'Attachment not found');
  }
}
