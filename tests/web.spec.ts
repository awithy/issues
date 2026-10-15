import 'dotenv/config';
import { test, expect } from '@playwright/test';
import { hash } from 'bcryptjs';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { createApp } from '../src/api/app.js';
import { databaseUrl, migrate } from '../src/api/db.js';
import type { Issue, Project } from '../src/shared/types.js';

let server: Server;
let pool: pg.Pool;
let admin: pg.Pool;
let schema: string;
let url: string;
test.beforeAll(async () => {
  schema = 'web_' + randomUUID().replaceAll('-', '');
  const connectionString = process.env.TEST_DATABASE_URL || databaseUrl();
  admin = new pg.Pool({ connectionString });
  await admin.query('CREATE SCHEMA ' + schema);
  pool = new pg.Pool({ connectionString, options: '-c search_path=' + schema });
  await migrate(pool);
  const app = createApp({ pool, users: [{ username: 'alice', passwordHash: await hash('alice-password', 4) }] });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not start');
  url = 'http://127.0.0.1:' + address.port;
});
test.afterAll(async () => {
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  if (pool) await pool.end();
  if (admin) { await admin.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); await admin.end(); }
});

test('dark theme is used regardless of system color preference', async ({ page }) => {
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.goto(url);
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
    await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(16, 20, 29)');
    await expect(page.locator('.login-card')).toHaveCSS('background-color', 'rgb(23, 28, 39)');
    await expect(page.getByRole('textbox', { name: 'Username', exact: true })).toHaveCSS('background-color', 'rgb(19, 24, 35)');
  }
});

test('web happy path: projects, Markdown fields, issue table, statuses, files, permanent deletes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.goto(url);
  await page.getByRole('textbox', { name: 'Username', exact: true }).fill('alice');
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('alice-password');
  await page.getByRole('button', { name: 'Log in →' }).click();
  await page.getByRole('button', { name: '+ Create project', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(23, 28, 39)');
  await page.getByRole('textbox', { name: 'Project title', exact: true }).fill('Website');
  await page.getByRole('textbox', { name: 'Project key' }).fill('WEB');
  await page.getByRole('dialog').getByRole('button', { name: 'Create project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Website', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '+ Create issue' }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Build a landing page');
  await expect(page.getByLabel('Issue type', { exact: true }).locator('option')).toHaveText(['Bug', 'Issue', 'Task', 'Sub-Task', 'Story']);
  await page.getByLabel('Issue type', { exact: true }).selectOption('Story');
  await page.getByRole('textbox', { name: 'Description', exact: true }).fill('# Goal\nA **simple** landing page.');
  await page.getByRole('textbox', { name: 'Notes', exact: true }).fill('## Design notes\n- Make it accessible');
  await page.getByRole('textbox', { name: 'Assignee', exact: true }).fill('Design team');
  await page.getByRole('textbox', { name: 'Labels', exact: true }).fill('frontend, design');
  await page.getByLabel('Resolution date', { exact: true }).fill('2025-06-01T12:30:45.123');
  await page.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(page).toHaveURL(/WEB-1$/);
  await page.getByRole('button', { name: 'Preview Description', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Goal', exact: true })).toBeVisible();
  await expect(page.locator('.markdown')).toHaveCSS('background-color', 'rgb(23, 28, 39)');
  await page.getByRole('button', { name: 'Preview Notes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Design notes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Write Notes', exact: true }).click();
  await page.getByRole('textbox', { name: 'Notes', exact: true }).fill('Updated **notes**');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Changes saved');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Updated **notes**');
  await expect(page.getByLabel('Resolution date', { exact: true })).toHaveValue('2025-06-01T12:30:45.123');
  await page.getByLabel('Resolution date', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Changes saved');
  await page.reload();
  await expect(page.getByLabel('Resolution date', { exact: true })).toHaveValue('');
  const data = Buffer.from('A file attached through the browser.');
  await page.getByLabel('Attach files', { exact: true }).setInputFiles({ name: 'hello.txt', mimeType: 'text/plain', buffer: data });
  await expect(page.getByRole('link', { name: 'hello.txt', exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'hello.txt', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('hello.txt');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks)).toEqual(data);
  await page.getByRole('button', { name: 'Delete attachment hello.txt' }).click();
  await expect(page.getByRole('link', { name: 'hello.txt', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to issues' }).click();
  await expect(page.getByRole('link', { name: 'Build a landing page', exact: true })).toBeVisible();
  await expect(page.locator('.table-wrap')).toHaveCSS('background-color', 'rgb(23, 28, 39)');
  await page.getByLabel('Status of WEB-1').selectOption({ label: 'in progress' });
  await expect(page.getByLabel('Status of WEB-1')).toBeEnabled();
  await expect(page.getByLabel('Status of WEB-1')).toHaveCSS('background-color', 'rgb(145, 184, 155)');
  await expect(page.getByLabel('Status of WEB-1')).toHaveCSS('color', 'rgb(32, 61, 41)');
  await page.getByLabel('Status of WEB-1').selectOption({ label: 'archived' });
  await expect(page.getByLabel('Status of WEB-1')).toBeEnabled();
  await expect(page.getByLabel('Status of WEB-1').locator('option:checked')).toHaveText('archived');
  await page.getByLabel('Status of WEB-1').selectOption({ label: 'design' });
  await expect(page.getByLabel('Status of WEB-1').locator('option:checked')).toHaveText('design');
  await expect(page.getByLabel('Status of WEB-1')).toHaveCSS('background-color', 'rgb(36, 50, 82)');
  await page.getByRole('textbox', { name: 'Search issues' }).fill('does not exist');
  await expect(page.getByRole('heading', { name: 'No matching issues' })).toBeVisible();
  await page.getByRole('textbox', { name: 'Search issues' }).fill('');
  await page.getByRole('button', { name: '+ Create issue' }).click();
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Landing page sub-task');
  await page.getByLabel('Issue type', { exact: true }).selectOption('Sub-Task');
  await page.getByLabel('Parent issue', { exact: true }).selectOption({ label: 'WEB-1 — Build a landing page' });
  await expect(page.getByLabel('Issue type', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Create issue', exact: true }).click();
  await expect(page).toHaveURL(/WEB-2$/);
  await page.reload();
  await expect(page.getByLabel('Issue type', { exact: true })).toHaveValue('Sub-Task');
  await expect(page.getByRole('link', { name: 'View parent WEB-1' })).toBeVisible();
  await page.getByLabel('Parent issue', { exact: true }).selectOption('');
  await expect(page.getByLabel('Issue type', { exact: true })).toBeEnabled();
  await page.getByLabel('Issue type', { exact: true }).selectOption('Bug');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Changes saved');
  await page.reload();
  await expect(page.getByLabel('Issue type', { exact: true })).toHaveValue('Bug');
  await expect(page.getByLabel('Parent issue', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to issues' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Landing page sub-task' })).toContainText('Bug');
  await page.getByRole('link', { name: 'Landing page sub-task', exact: true }).click();
  await page.getByRole('button', { name: 'Delete issue', exact: true }).click();
  await page.getByRole('button', { name: 'Project settings', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project title', exact: true }).fill('Web platform');
  await page.getByRole('button', { name: '+ Add status' }).click();
  await page.getByRole('textbox', { name: 'Status 7 name', exact: true }).fill('blocked');
  await page.getByRole('button', { name: 'Save settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Web platform', exact: true })).toBeVisible();
  await expect(page.getByLabel('Filter by status').locator('option')).toContainText(['All statuses', 'backlog', 'design', 'ready', 'in progress', 'done', 'archived', 'blocked']);
  await page.getByRole('link', { name: 'Build a landing page', exact: true }).click();
  await page.getByRole('button', { name: 'Delete issue', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Build a landing page', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Project settings', exact: true }).click();
  await page.getByRole('button', { name: 'Permanently delete project', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Make room for the work.' })).toBeVisible();
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('image attachments: scaled previews, full-size dialog, reload, and deletion', async ({ page }) => {
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'Image previews', key: 'IMG' } })).json() as Project;
  const issue = await (await page.request.post(url + '/api/projects/' + project.projectId + '/issues', { data: { title: 'Screenshots' } })).json() as Issue;
  await page.goto(url + '/#/projects/' + project.projectId + '/issues/' + issue.issueKey);
  await expect(page.getByLabel('Image attachments', { exact: true })).toHaveCount(0);
  const images = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1800; canvas.height = 900;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#4267dc'; context.fillRect(0, 0, canvas.width, canvas.height);
    return [canvas.toDataURL('image/png'), canvas.toDataURL('image/jpeg')].map(data => data.split(',')[1]!);
  });
  await page.getByLabel('Attach files', { exact: true }).setInputFiles([
    { name: 'screenshot.png', mimeType: 'image/png', buffer: Buffer.from(images[0]!, 'base64') },
    { name: 'photo.JPG', mimeType: 'application/octet-stream', buffer: Buffer.from(images[1]!, 'base64') },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Not an image') },
  ]);
  await expect(page.getByRole('link', { name: 'notes.txt', exact: true })).toBeVisible();
  const gallery = page.getByLabel('Image attachments', { exact: true });
  await expect(gallery.getByRole('img')).toHaveCount(2);
  for (const filename of ['screenshot.png', 'photo.JPG']) {
    const image = gallery.getByRole('img', { name: filename, exact: true });
    await image.scrollIntoViewIfNeeded();
    await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1800);
    const dimensions = await image.evaluate(element => ({ width: element.clientWidth, height: element.clientHeight, container: element.parentElement!.clientWidth }));
    expect(dimensions.width).toBeLessThan(1800);
    expect(dimensions.width).toBeLessThanOrEqual(dimensions.container);
    expect(Math.abs(dimensions.height - dimensions.width / 2)).toBeLessThan(1);
    await gallery.getByRole('button', { name: 'Expand ' + filename, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: filename, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('img')).toHaveCSS('width', '1800px');
    await expect(dialog.getByRole('img')).toHaveCSS('height', '900px');
    expect(await dialog.locator('.full-size-image').evaluate(element => element.scrollWidth > element.clientWidth)).toBeTruthy();
    if (filename === 'screenshot.png') await page.keyboard.press('Escape');
    else await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Issue details', exact: true })).toBeVisible();
    await expect(gallery.getByRole('button', { name: 'Expand ' + filename, exact: true })).toBeFocused();
  }
  await page.reload();
  await expect(gallery.getByRole('img')).toHaveCount(2);
  page.on('dialog', dialog => dialog.accept());
  for (const filename of ['screenshot.png', 'photo.JPG']) {
    await page.getByRole('button', { name: 'Delete attachment ' + filename, exact: true }).click();
    await expect(gallery.getByRole('img', { name: filename, exact: true })).toHaveCount(0);
  }
  await expect(gallery).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'notes.txt', exact: true })).toBeVisible();
  await page.request.delete(url + '/api/projects/' + project.projectId);
});

test('issue row bulk-adds sub-tasks with a design status and supports a single nested sub-task', async ({ page }) => {
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'Bulk sub-tasks', key: 'BULK' } })).json() as Project;
  const endpoint = url + '/api/projects/' + project.projectId + '/issues';
  const parent = await (await page.request.post(endpoint, { data: { title: 'Parent task', issueType: 'Task' } })).json() as Issue;
  await page.goto(url + '/#/projects/' + project.projectId);
  const addButton = page.getByRole('button', { name: 'Add sub-tasks to ' + parent.issueKey, exact: true });
  await expect(page.locator('.issues-table tbody tr').first().locator('td').last().getByRole('button')).toHaveAccessibleName('Add sub-tasks to ' + parent.issueKey);
  await expect(addButton.getByRole('img', { name: 'Sub-Task', exact: true })).toBeVisible();
  await addButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Parent task');
  await expect(dialog.getByRole('button', { name: 'Create', exact: false })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Sub-task titles' }).fill('Canceled task');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await (await page.request.get(endpoint)).json()).toHaveLength(1);

  // Both the stock workflow and customized "In Design" workflows choose the design status.
  for (const statusTitle of ['design', 'In Design']) {
    if (statusTitle === 'In Design') {
      const response = await page.request.patch(url + '/api/projects/' + project.projectId, { data: {
        issueStatuses: project.issueStatuses.map(status => ({ statusId: status.statusId, title: status.title === 'design' ? statusTitle : status.title, isComplete: status.isComplete })),
      } });
      expect(response.ok()).toBeTruthy();
      await page.reload();
    }
    await addButton.click();
    await expect(dialog.getByLabel('Sub-task status').locator('option:checked')).toHaveText(statusTitle);
    await dialog.getByRole('textbox', { name: 'Sub-task titles' }).fill(`  ${statusTitle} layout  \n\n  \n${statusTitle} component\n`);
    await dialog.getByRole('button', { name: 'Create 2 sub-tasks', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    for (const title of [statusTitle + ' layout', statusTitle + ' component']) {
      const row = page.locator('.issues-table tbody tr').filter({ has: page.getByRole('link', { name: title, exact: true }) });
      await expect(row).toBeVisible();
      await expect(row.locator('td').nth(0)).toHaveCSS('padding-inline-start', '42px');
      await expect(row.locator('select option:checked')).toHaveText(statusTitle);
    }
  }
  let issues = await (await page.request.get(endpoint)).json() as Issue[];
  expect(issues).toHaveLength(5);
  for (const child of issues.filter(issue => issue.issueId !== parent.issueId)) {
    expect(child.issueType).toBe('Sub-Task');
    expect(child.parentIssueId).toBe(parent.issueId);
    expect(child.status.statusId).toBe(project.issueStatuses[1]!.statusId);
  }
  const child = issues.find(issue => issue.title === 'In Design layout')!;
  await page.getByRole('button', { name: 'Add sub-tasks to ' + child.issueKey, exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Sub-task titles' }).fill('Nested sub-task');
  await dialog.getByRole('button', { name: 'Create 1 sub-task', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Nested sub-task', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('link', { name: 'Nested sub-task', exact: true })).toBeVisible();
  issues = await (await page.request.get(endpoint)).json() as Issue[];
  expect(issues.find(issue => issue.title === 'Nested sub-task')!.parentIssueId).toBe(child.issueId);
  await page.request.delete(url + '/api/projects/' + project.projectId);
});

test('bulk sub-task creation validates titles and retains only unsaved titles after a failure', async ({ page }) => {
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'Retry sub-tasks', key: 'RETRY' } })).json() as Project;
  const endpoint = url + '/api/projects/' + project.projectId + '/issues';
  const parent = await (await page.request.post(endpoint, { data: { title: 'Parent' } })).json() as Issue;
  await page.goto(url + '/#/projects/' + project.projectId);
  await page.getByRole('button', { name: 'Add sub-tasks to ' + parent.issueKey, exact: true }).click();
  const dialog = page.getByRole('dialog');
  const titles = dialog.getByRole('textbox', { name: 'Sub-task titles' });
  await titles.fill('Valid title\n' + 'x'.repeat(301));
  await dialog.getByRole('button', { name: 'Create 2 sub-tasks', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('300 characters or fewer');
  expect(await (await page.request.get(endpoint)).json()).toHaveLength(1);

  let requests = 0;
  await page.route(endpoint, async route => {
    if (route.request().method() === 'POST' && ++requests === 2) {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Please retry.' }) });
    } else await route.continue();
  });
  await titles.fill('First child\nSecond child\nThird child');
  await dialog.getByRole('button', { name: 'Create 3 sub-tasks', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('1 sub-task(s) created. Please retry.');
  await expect(titles).toHaveValue('Second child\nThird child');
  await dialog.getByRole('button', { name: 'Create 2 sub-tasks', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.issues-table tbody tr')).toHaveCount(4);
  const issues = await (await page.request.get(endpoint)).json() as Issue[];
  expect(issues.map(issue => issue.title).sort()).toEqual(['Parent', 'First child', 'Second child', 'Third child'].sort());
  await page.request.delete(url + '/api/projects/' + project.projectId);
});

test('Sub-Tasks are grouped and indented under visible parents', async ({ page }) => {
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'Hierarchical work', key: 'TREE' } })).json() as Project;
  const endpoint = url + '/api/projects/' + project.projectId + '/issues';
  async function create(title: string, parent?: Issue) {
    const response = await page.request.post(endpoint, { data: {
      title, issueType: parent ? 'Sub-Task' : 'Task', parentIssueId: parent?.issueId,
    } });
    expect(response.ok()).toBeTruthy();
    return await response.json() as Issue;
  }
  const parentA = await create('Parent A');
  const childA = await create('Child A', parentA);
  const unrelated = await create('Unrelated task');
  const parentB = await create('Parent B');
  const childB = await create('Child B', parentA);
  const childC = await create('Child C', parentB);
  const nested = await create('Nested child', childA);
  await page.goto(url + '/#/projects/' + project.projectId);
  const keys = page.locator('.issues-table tbody .issue-key');
  await expect(keys).toHaveText([parentB, childC, unrelated, parentA, childB, childA, nested].map(issue => issue.issueKey));
  for (const [issue, depth] of [[parentA, 0], [childA, 1], [nested, 2]] as const) {
    const cells = page.locator('.issues-table tbody tr').filter({ has: page.getByRole('link', { name: issue.issueKey, exact: true }) }).locator('td');
    await expect(cells.nth(0)).toHaveCSS('padding-inline-start', `${18 + depth * 24}px`);
    await expect(cells.nth(2)).toHaveCSS('padding-inline-start', `${18 + depth * 24}px`);
  }
  await page.getByRole('button', { name: 'Sort by Key', exact: true }).click();
  await expect(keys).toHaveText([parentA, childA, nested, childB, unrelated, parentB, childC].map(issue => issue.issueKey));

  // A hidden parent must not hide its children or add non-matching rows.
  await page.getByRole('textbox', { name: 'Search issues' }).fill('child');
  await expect(keys).toHaveText([childA, nested, childB, childC].map(issue => issue.issueKey));
  await expect(keys.nth(0).locator('..')).toHaveCSS('padding-inline-start', '18px');
  await expect(keys.nth(1).locator('..')).toHaveCSS('padding-inline-start', '42px');
  await expect(page.getByRole('navigation', { name: 'Issue pagination' })).toContainText('1–4 of 4 issues');
  await page.request.delete(url + '/api/projects/' + project.projectId);
});

test('issue pagination: sizes, navigation, filters, and shrinking results', async ({ page }) => {
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'Paginated work', key: 'PAGE' } })).json() as Project;
  await pool.query(`INSERT INTO issues(project_id,issue_number,title,status_id)
    SELECT $1,n,CASE WHEN n <= 101 THEN 'Needle ' ELSE 'Work ' END || n,
      CASE WHEN n <= 101 THEN $3::int ELSE $2::int END FROM generate_series(1,1001) n`,
  [project.projectId, project.issueStatuses[0]!.statusId, project.issueStatuses.find(s => s.title === 'done')!.statusId]);
  await page.goto(url + '/#/projects/' + project.projectId);
  const rows = page.locator('.issues-table tbody tr');
  const pagination = page.getByRole('navigation', { name: 'Issue pagination' });
  const previous = pagination.getByRole('button', { name: 'Previous', exact: true });
  const next = pagination.getByRole('button', { name: 'Next', exact: true });
  const size = page.getByLabel('Items per page');
  await expect(size.locator('option')).toHaveText(['100', '500', '1000']);
  await expect(size).toHaveValue('100');
  await expect(rows).toHaveCount(100);
  await expect(rows.first()).toContainText('PAGE-1001');
  await expect(pagination).toContainText('1–100 of 1001 issues');
  await expect(page.locator('.toolbar-left')).toContainText('101 complete');
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(rows.first()).toContainText('PAGE-901');
  await expect(pagination).toContainText('101–200 of 1001 issues');
  const keyHeader = page.getByRole('button', { name: 'Sort by Key', exact: true });
  await keyHeader.click();
  await expect(keyHeader.locator('..')).toHaveAttribute('aria-sort', 'ascending');
  await expect(pagination).toContainText('Page 1 of 11');
  await expect(rows.first().locator('.issue-key')).toHaveText('PAGE-1');
  await next.click();
  await expect(rows.first().locator('.issue-key')).toHaveText('PAGE-101');
  await keyHeader.click();
  await expect(keyHeader.locator('..')).toHaveAttribute('aria-sort', 'descending');
  await expect(rows.first()).toContainText('PAGE-1001');
  await size.selectOption('500');
  await expect(rows).toHaveCount(500);
  await expect(pagination).toContainText('Page 1 of 3');
  await size.selectOption('1000');
  await expect(rows).toHaveCount(1000);
  await next.click();
  await expect(rows).toHaveCount(1);
  await expect(next).toBeDisabled();
  await page.getByRole('link', { name: 'Needle 1', exact: true }).click();
  await page.getByRole('button', { name: 'Back to issues' }).click();
  await expect(pagination).toContainText('Page 2 of 2');
  await expect(rows).toHaveCount(1);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('link', { name: 'Needle 1', exact: true }).click();
  await page.getByRole('button', { name: 'Delete issue', exact: true }).click();
  await expect(pagination).toContainText('Page 1 of 1');
  await expect(rows).toHaveCount(1000);
  await size.selectOption('100');
  await expect(rows).toHaveCount(100);
  await next.click();
  await expect(pagination).toContainText('Page 2 of 10');
  await page.getByRole('textbox', { name: 'Search issues' }).fill('Needle');
  await expect(pagination).toContainText('1–100 of 100 issues');
  await expect(pagination).toContainText('Page 1 of 1');
  await page.getByRole('textbox', { name: 'Search issues' }).fill('');
  await expect(pagination).toContainText('Page 1 of 10');
  await next.click();
  await expect(pagination).toContainText('Page 2 of 10');
  await page.getByLabel('Filter by status').selectOption({ label: 'done' });
  await expect(pagination).toContainText('Page 1 of 1');
  await expect(pagination).toContainText('1–100 of 100 issues');
  await page.getByRole('textbox', { name: 'Search issues' }).fill('absent');
  await expect(rows).toHaveCount(0);
  await expect(pagination).toContainText('0 issues');
  await expect(next).toBeDisabled();
  await expect(previous).toBeDisabled();
  await page.request.delete(url + '/api/projects/' + project.projectId);
});

test('returning from issue details restores the table scroll position', async ({ page }) => {
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'Scrollable work', key: 'SCROLL' } })).json() as Project;
  await pool.query(`INSERT INTO issues(project_id,issue_number,title,status_id)
    SELECT $1,n,'Scrollable issue ' || n,$2 FROM generate_series(1,160) n`,
  [project.projectId, project.issueStatuses[0]!.statusId]);
  const view = await (await page.request.post(url + '/api/projects/' + project.projectId + '/views', { data: { title: 'Scrollable view' } })).json();
  const projectUrl = url + '/#/projects/' + project.projectId;
  for (const tableUrl of [projectUrl, projectUrl + '/views/' + view.viewId]) {
    await page.goto(tableUrl);
    const table = page.locator('.table-wrap');
    const pagination = page.getByRole('navigation', { name: 'Issue pagination' });
    await expect(table).toHaveAttribute('aria-busy', 'false');
    await pagination.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(pagination).toContainText('Page 2 of 2');
    await expect(table).toHaveAttribute('aria-busy', 'false');
    const issueLink = page.locator('.issue-title').nth(35);

    for (const back of ['button', 'browser', 'escape']) {
      await issueLink.evaluate(element => element.scrollIntoView({ block: 'center' }));
      await table.evaluate(element => { element.scrollLeft = 60; });
      const position = await page.evaluate(() => new Promise<{ y: number; left: number }>(resolve => {
        requestAnimationFrame(() => resolve({ y: window.scrollY, left: document.querySelector('.table-wrap')!.scrollLeft }));
      }));
      expect(position.y).toBeGreaterThan(1000);
      await issueLink.click();
      await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toBeVisible();
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
      // Detail-page scrolling must not overwrite the table's saved position.
      await page.evaluate(() => window.scrollTo(0, 400));
      if (back === 'button') await page.getByRole('button', { name: 'Back to issues' }).click();
      else if (back === 'browser') await page.goBack();
      else {
        await page.getByRole('textbox', { name: 'Notes', exact: true }).focus();
        await page.keyboard.press('Escape');
      }
      await expect(page).toHaveURL(tableUrl);
      await expect(table).toHaveAttribute('aria-busy', 'false');
      await expect(pagination).toContainText('Page 2 of 2');
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(position.y);
      await expect.poll(() => table.evaluate(element => element.scrollLeft)).toBe(position.left);
      await expect(issueLink).toBeInViewport();
    }
  }
  await page.request.delete(url + '/api/projects/' + project.projectId);
});

test('issue types appear as small accessible icons in table cells', async ({ page }) => {
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'Type icons', key: 'ICON' } })).json() as Project;
  const endpoint = url + '/api/projects/' + project.projectId + '/issues';
  const parent = await (await page.request.post(endpoint, { data: { title: 'Story work', issueType: 'Story' } })).json() as Issue;
  for (const issueType of ['Bug', 'Issue', 'Task', 'Sub-Task']) {
    await page.request.post(endpoint, { data: { title: issueType + ' work', issueType, ...(issueType === 'Sub-Task' ? { parentIssueId: parent.issueId } : {}) } });
  }
  await page.goto(url + '/#/projects/' + project.projectId);
  await expect(page.locator('.issues-table tbody tr')).toHaveCount(5);
  for (const type of ['Bug', 'Issue', 'Task', 'Sub-Task', 'Story']) {
    const cell = page.locator('.issues-table tbody tr').filter({ hasText: type + ' work' }).locator('td').nth(1);
    const icon = cell.getByRole('img', { name: type, exact: true });
    await expect(icon).toBeVisible();
    await expect(icon.locator('title')).toHaveText(type);
    await expect(icon).toHaveCSS('width', '16px');
    await expect(icon).toHaveCSS('height', '16px');
    await expect(cell).toHaveJSProperty('innerText', '');
  }
  await page.request.delete(url + '/api/projects/' + project.projectId);
});

test('issue sorting: all sortable headers, both directions, and returning from details', async ({ page }) => {
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'Sortable work', key: 'SORT' } })).json() as Project;
  const endpoint = url + '/api/projects/' + project.projectId + '/issues';
  await page.request.post(endpoint, { data: { title: 'Sort A', issueNumber: 2, issueType: 'Bug', assignee: 'Zed', statusId: project.issueStatuses[4]!.statusId } });
  await page.request.post(endpoint, { data: { title: 'Sort B', issueNumber: 10, issueType: 'Task', assignee: 'alice' } });
  await page.request.post(endpoint, { data: { title: 'Sort C', issueNumber: 11, issueType: 'Bug', assignee: 'ALICE', statusId: project.issueStatuses[1]!.statusId } });
  await page.request.post(endpoint, { data: { title: 'Sort D', issueNumber: 20 } });
  await page.goto(url + '/#/projects/' + project.projectId);
  const keys = page.locator('.issues-table tbody .issue-key');
  await expect(page.locator('.issues-table th')).toContainText(['Key', 'Type', 'Title', 'Status', 'Assignee', 'Labels']);
  await expect(page.locator('.issues-table tbody tr').filter({ hasText: 'Sort A' }).locator('td').nth(1).getByRole('img', { name: 'Bug', exact: true })).toBeVisible();
  await expect(page.locator('.issues-table tbody tr').filter({ hasText: 'Sort A' }).locator('td').nth(2)).toHaveText('Sort A');
  await expect(page.getByRole('button', { name: 'Sort by Status', exact: true }).locator('..')).toHaveAttribute('aria-sort', 'ascending');
  await expect(keys).toHaveText(['SORT-20', 'SORT-10', 'SORT-11', 'SORT-2']);
  const orders = [
    { column: 'Key', asc: [2, 10, 11, 20], desc: [20, 11, 10, 2] },
    { column: 'Type', asc: [11, 2, 20, 10], desc: [10, 20, 11, 2] },
    { column: 'Status', asc: [20, 10, 11, 2], desc: [2, 11, 20, 10] },
    { column: 'Assignee', asc: [11, 10, 2, 20], desc: [2, 11, 10, 20] },
  ];
  for (const { column, asc, desc } of orders) {
    const button = page.getByRole('button', { name: 'Sort by ' + column, exact: true });
    await button.click();
    await expect(button.locator('..')).toHaveAttribute('aria-sort', 'ascending');
    await expect(keys).toHaveText(asc.map(n => 'SORT-' + n));
    await button.focus();
    await page.keyboard.press('Enter');
    await expect(button.locator('..')).toHaveAttribute('aria-sort', 'descending');
    await expect(keys).toHaveText(desc.map(n => 'SORT-' + n));
  }
  await page.getByRole('link', { name: 'Sort A', exact: true }).click();
  await page.getByRole('button', { name: 'Back to issues' }).click();
  await expect(page.getByRole('button', { name: 'Sort by Assignee', exact: true }).locator('..')).toHaveAttribute('aria-sort', 'descending');
  await expect(keys).toHaveText(['SORT-2', 'SORT-11', 'SORT-10', 'SORT-20']);
  await page.request.delete(url + '/api/projects/' + project.projectId);
});

test('clicking table labels adds removable filters across pages and saved views', async ({ page }) => {
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'Labelled work', key: 'LABEL' } })).json() as Project;
  await pool.query(`INSERT INTO issues(project_id,issue_number,title,status_id,labels)
    SELECT $1,n,'Labelled work ' || n,$2,CASE WHEN n=1 THEN ARRAY['frontend','urgent'] ELSE ARRAY['frontend'] END
    FROM generate_series(1,101) n`, [project.projectId, project.issueStatuses[0]!.statusId]);
  await page.request.post(url + '/api/projects/' + project.projectId + '/issues', { data: { title: 'frontend title only', issueNumber: 102, labels: ['frontend-extra'] } });
  const view = await (await page.request.post(url + '/api/projects/' + project.projectId + '/views', { data: { title: 'Backlog view', filters: { statusIds: [project.issueStatuses[0]!.statusId] } } })).json();
  const projectUrl = url + '/#/projects/' + project.projectId;
  await page.goto(projectUrl);
  const rows = page.locator('.issues-table tbody tr');
  const pagination = page.getByRole('navigation', { name: 'Issue pagination' });
  const filters = page.getByRole('group', { name: 'Active label filters' });
  const frontend = () => rows.getByRole('button', { name: 'Filter by label frontend', exact: true }).first();
  const urgent = () => rows.getByRole('button', { name: 'Filter by label urgent', exact: true });
  await expect(pagination).toContainText('1–100 of 102 issues');
  await pagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(pagination).toContainText('Page 2 of 2');
  await frontend().click();
  await expect(pagination).toContainText('1–100 of 101 issues');
  await expect(pagination).toContainText('Page 1 of 2');
  await expect(frontend()).toHaveAttribute('aria-pressed', 'true');
  await frontend().click();
  await expect(filters.getByRole('button')).toHaveCount(1);
  await pagination.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(pagination).toContainText('101–101 of 101 issues');
  await urgent().focus();
  await page.keyboard.press('Enter');
  await expect(filters.getByRole('button')).toHaveCount(2);
  await expect(pagination).toContainText('1–1 of 1 issues');
  await expect(rows).toContainText(['Labelled work 1']);
  await page.getByLabel('Filter by status').selectOption({ label: 'done' });
  await expect(page.getByRole('heading', { name: 'No matching issues' })).toBeVisible();
  await page.getByLabel('Filter by status').selectOption('');
  await expect(rows).toHaveCount(1);
  await page.getByRole('textbox', { name: 'Search issues' }).fill('absent');
  await expect(rows).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search issues' }).fill('');
  await expect(rows).toHaveCount(1);
  await page.getByRole('link', { name: 'Labelled work 1', exact: true }).click();
  await page.getByRole('button', { name: 'Back to issues' }).click();
  await expect(filters.getByRole('button')).toHaveCount(2);
  await expect(rows).toHaveCount(1);
  await filters.getByRole('button', { name: 'Remove label filter urgent', exact: true }).click();
  await expect(pagination).toContainText('1–100 of 101 issues');
  await filters.getByRole('button', { name: 'Remove label filter frontend', exact: true }).click();
  await expect(filters).toHaveCount(0);
  await expect(pagination).toContainText('1–100 of 102 issues');

  await page.getByRole('link', { name: 'Backlog view', exact: true }).click();
  await expect(pagination).toContainText('1–100 of 102 issues');
  await frontend().click();
  await expect(pagination).toContainText('1–100 of 101 issues');
  const saved = await (await page.request.get(url + '/api/projects/' + project.projectId + '/views/' + view.viewId)).json();
  expect(saved.filters.labels).toEqual([]);
  await page.getByRole('link', { name: /Labelled work LABEL$/ }).click();
  await expect(filters).toHaveCount(0);
  await expect(pagination).toContainText('1–100 of 102 issues');
  await page.request.delete(url + '/api/projects/' + project.projectId);
});

test('saved views: sidebar, persisted filters, shared table and editing/deletion', async ({ page }) => {
  page.on('dialog', dialog => dialog.accept());
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'View project', key: 'VIEW' } })).json() as Project;
  const backlog = project.issueStatuses[0]!.statusId;
  const done = project.issueStatuses.find(s => s.title === 'done')!.statusId;
  const labels = ['frontend', 'urgent'];
  for (const data of [
    { title: 'Matching bug', issueType: 'Bug', labels },
    { title: 'Matching task', issueType: 'Task', labels, statusId: done },
    { title: 'Missing label', issueType: 'Bug', labels: ['frontend'] },
    { title: 'Wrong status', issueType: 'Bug', labels, statusId: project.issueStatuses[1]!.statusId },
    { title: 'Wrong type', issueType: 'Story', labels },
  ]) await page.request.post(url + '/api/projects/' + project.projectId + '/issues', { data });
  await page.goto(url + '/#/projects/' + project.projectId);
  const rows = page.locator('.issues-table tbody tr');
  await expect(rows).toHaveCount(5);
  await page.getByRole('button', { name: 'Create view under View project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('View title', { exact: true }).fill('Urgent work');
  await dialog.getByLabel('Labels', { exact: true }).fill('frontend, urgent');
  await dialog.getByRole('checkbox', { name: 'backlog', exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'done', exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'Bug', exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'Task', exact: true }).check();
  await dialog.getByRole('button', { name: 'Create view', exact: true }).click();
  await expect(page).toHaveURL(/\/views\/\d+$/);
  const viewUrl = page.url();
  await expect(page.getByRole('heading', { name: 'Urgent work', exact: true })).toBeVisible();
  await expect(page.locator('.project-nav-group').filter({ hasText: 'View project' }).getByRole('link', { name: 'Urgent work', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(rows).toHaveCount(2);
  await expect(rows).toContainText(['Matching bug', 'Matching task']);
  await expect(page.locator('.toolbar-left')).toContainText('1 complete');
  await page.reload();
  await expect(rows).toHaveCount(2);
  await page.getByRole('link', { name: 'Matching bug', exact: true }).click();
  await expect(page).toHaveURL(/\/views\/\d+\/issues\/VIEW-1$/);
  await page.getByRole('button', { name: 'Back to issues' }).click();
  await expect(page).toHaveURL(viewUrl);
  await page.getByRole('textbox', { name: 'Search issues', exact: true }).fill('task');
  await expect(rows).toHaveCount(1);
  await page.getByRole('link', { name: /View project VIEW$/ }).click();
  await expect(rows).toHaveCount(5);
  await expect(page.getByRole('textbox', { name: 'Search issues', exact: true })).toHaveValue('');
  await page.getByRole('link', { name: 'Urgent work', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await page.getByLabel('Status of VIEW-1').selectOption({ label: 'design' });
  await expect(rows).toHaveCount(1);
  await page.getByRole('button', { name: 'Edit view', exact: true }).click();
  await expect(dialog.getByLabel('Labels', { exact: true })).toHaveValue('frontend, urgent');
  await expect(dialog.getByRole('checkbox', { name: 'backlog', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'done', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Bug', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Task', exact: true })).toBeChecked();
  await dialog.getByLabel('View title', { exact: true }).fill('All bugs');
  await dialog.getByLabel('Labels', { exact: true }).fill('');
  await dialog.getByRole('checkbox', { name: 'backlog', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: 'done', exact: true }).uncheck();
  await dialog.getByRole('checkbox', { name: 'Task', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All bugs', exact: true })).toBeVisible();
  await expect(rows).toHaveCount(3);
  await page.reload();
  await expect(rows).toHaveCount(3);
  await page.getByRole('button', { name: 'Edit view', exact: true }).click();
  await dialog.getByRole('button', { name: 'Permanently delete view', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'View project', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'All bugs', exact: true })).toHaveCount(0);
  await expect(rows).toHaveCount(5);
  await page.goto(viewUrl);
  await expect(page.getByRole('heading', { name: 'View not found', exact: true })).toBeVisible();
  await page.request.delete(url + '/api/projects/' + project.projectId);
});

test('duplicating a view copies saved filters and leaves the original independent', async ({ page }) => {
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'Duplicate views', key: 'COPY' } })).json() as Project;
  const endpoint = url + '/api/projects/' + project.projectId + '/views';
  const filters = { labels: ['frontend', 'urgent'], statusIds: [project.issueStatuses[0]!.statusId], issueTypes: ['Bug', 'Task'] };
  const source = await (await page.request.post(endpoint, { data: { title: 'Urgent work', filters } })).json();
  await page.request.post(url + '/api/projects/' + project.projectId + '/issues', { data: { title: 'Matching bug', labels: filters.labels, issueType: 'Bug' } });
  await page.goto(url + '/#/projects/' + project.projectId + '/views/' + source.viewId);
  const dialog = page.getByRole('dialog', { name: 'Duplicate view', exact: true });
  await page.getByRole('button', { name: 'Duplicate view', exact: true }).click();
  await expect(dialog.getByLabel('View title', { exact: true })).toHaveValue('Copy of Urgent work');
  await expect(dialog.getByLabel('Labels', { exact: true })).toHaveValue('frontend, urgent');
  await expect(dialog.getByRole('checkbox', { name: 'backlog', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'done', exact: true })).not.toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Bug', exact: true })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: 'Task', exact: true })).toBeChecked();
  await expect(dialog.getByRole('button', { name: 'Permanently delete view', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await (await page.request.get(endpoint)).json()).toHaveLength(1);
  await page.getByRole('button', { name: 'Duplicate view', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create view', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Copy of Urgent work', exact: true })).toBeVisible();
  const copyUrl = page.url();
  expect(copyUrl).not.toBe(url + '/#/projects/' + project.projectId + '/views/' + source.viewId);
  await expect(page.getByRole('link', { name: 'Copy of Urgent work', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.issues-table tbody tr')).toHaveCount(1);
  await page.reload();
  await page.getByRole('button', { name: 'Edit view', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit view', exact: true });
  await editor.getByLabel('View title', { exact: true }).fill('Independent copy');
  await editor.getByLabel('Labels', { exact: true }).fill('different');
  await editor.getByRole('button', { name: 'Save view', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Independent copy', exact: true })).toBeVisible();
  await expect(page.locator('.issues-table tbody tr')).toHaveCount(0);
  expect(await (await page.request.get(endpoint + '/' + source.viewId)).json()).toEqual(source);
  await page.getByRole('link', { name: 'Urgent work', exact: true }).click();
  await expect(page.locator('.issues-table tbody tr')).toHaveCount(1);
  await page.request.delete(url + '/api/projects/' + project.projectId);
});

test('issue links: cross-project navigation, symmetric display, and unlinking', async ({ page }) => {
  await page.request.post(url + '/api/auth/login', { data: { username: 'alice', password: 'alice-password' } });
  const project = await (await page.request.post(url + '/api/projects', { data: { title: 'Linked work', key: 'LINK' } })).json() as Project;
  const other = await (await page.request.post(url + '/api/projects', { data: { title: 'Related work', key: 'REL' } })).json() as Project;
  const a = await (await page.request.post(url + '/api/projects/' + project.projectId + '/issues', { data: { title: 'First linked issue' } })).json() as Issue;
  const b = await (await page.request.post(url + '/api/projects/' + other.projectId + '/issues', { data: { title: 'Other project issue' } })).json() as Issue;
  await page.goto(url + '/#/projects/' + project.projectId + '/issues/' + a.issueKey);
  await expect(page.getByText('No linked issues.', { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Notes', exact: true }).fill('Unsaved notes');
  await page.getByRole('textbox', { name: 'Issue to link', exact: true }).fill(b.issueKey.toLowerCase());
  await page.getByRole('button', { name: 'Link issue', exact: true }).click();
  await expect(page.getByRole('link', { name: b.issueKey + ' — ' + b.title, exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Unsaved notes');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Changes saved');
  await page.reload();
  await page.getByRole('link', { name: b.issueKey + ' — ' + b.title, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(b.issueKey + '$'));
  await expect(page.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue(b.title);
  await expect(page.getByRole('link', { name: a.issueKey + ' — ' + a.title, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Unlink ' + a.issueKey, exact: true }).click();
  await expect(page.getByText('No linked issues.', { exact: true })).toBeVisible();
  await page.goto(url + '/#/projects/' + project.projectId + '/issues/' + a.issueKey);
  await expect(page.getByText('No linked issues.', { exact: true })).toBeVisible();
  await page.request.delete(url + '/api/projects/' + other.projectId);
  await page.request.delete(url + '/api/projects/' + project.projectId);
});
