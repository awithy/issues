import { mkdir, rm } from 'node:fs/promises';
import { z } from 'zod';
import { Archive } from './archive.js';
import { issueSchema, keyNumber, parseJson } from './types.js';
import type { FileRef, JiraSource, Manifest } from './types.js';

export async function exportProject(source: JiraSource, root: string, project: string, keys?: string[], log: (message: string) => void = () => {}) {
  if (!/^[A-Z][A-Z0-9]{0,11}$/.test(project)) throw new Error('Invalid project key');
  const selection = keys ? [...new Set(keys)].sort((a, b) => keyNumber(a) - keyNumber(b)) : null;
  if (selection && (!selection.length || selection.some(key => !new RegExp('^' + project + '-[1-9]\\d*$').test(key)))) throw new Error('Selected keys must belong to the export project');
  const archive = new Archive(root);
  await archive.init();
  const lock = archive.path('.export.lock');
  try { await mkdir(lock); }
  catch { throw new Error('Export directory is locked; if no export is running, remove .export.lock before resuming'); }
  try {
    let manifest = await archive.manifest();
    if (manifest && (manifest.server !== source.server || manifest.project !== project || JSON.stringify(manifest.selection) !== JSON.stringify(selection))) throw new Error('Export source/selection differs from the existing manifest; use a new directory');
    if (!manifest) {
      manifest = { version: 1, server: source.server, project, selection, startedAt: new Date().toISOString(), scope: 'accessible', metadata: {}, inventory: [], inventoryComplete: false, searchPages: [], issues: {} };
      await archive.save(manifest);
    }
    // Resume only a verified snapshot. Do not silently repair or mix corrupted files.
    await archive.verify(manifest);
    if (manifest.completedAt) { log('Existing export verified; no source requests needed. Use a new directory for a new snapshot.'); return manifest; }
    for (const [name, path] of Object.entries({
      permissions: '/rest/api/3/mypermissions?projectKey=' + project + '&permissions=BROWSE_PROJECTS',
      project: '/rest/api/3/project/' + project,
      statuses: '/rest/api/3/project/' + project + '/statuses',
      fields: '/rest/api/3/field',
    })) {
      if (!manifest.metadata[name]) {
        manifest.metadata[name] = await archive.write('raw/' + name + '.json', await source.get(path));
        await archive.save(manifest);
      }
    }
    const permissions = z.object({ permissions: z.object({ BROWSE_PROJECTS: z.object({ havePermission: z.boolean() }) }) }).parse(parseJson(await archive.read(manifest.metadata.permissions!)));
    if (!permissions.permissions.BROWSE_PROJECTS.havePermission) throw new Error('The source account cannot browse the project');
    const sourceProject = z.object({ key: z.string() }).parse(parseJson(await archive.read(manifest.metadata.project!)));
    if (sourceProject.key !== project) throw new Error('Source project identity mismatch');

    if (!selection && !manifest.inventoryComplete) {
      while (true) {
        const raw = await source.search(project, manifest.cursor);
        const parsed = parseJson(raw);
        const page = z.array(z.object({ id: z.string().regex(/^\d+$/), key: z.string(), self: z.url() }).passthrough()).parse(Array.isArray(parsed) ? parsed : z.object({ issues: z.array(z.unknown()) }).parse(parsed).issues);
        const ref = await archive.write('raw/search/' + manifest.searchPages.length + '.json', raw);
        let lastNumber = manifest.cursor ? keyNumber(manifest.cursor) : 0;
        for (const issue of page) {
          if (!new RegExp('^' + project + '-[1-9]\\d*$').test(issue.key) || new URL(issue.self).origin !== source.server || keyNumber(issue.key) <= lastNumber || manifest.inventory.some(item => item.id === issue.id)) throw new Error('Search did not advance in ascending key order or returned a different source; refusing an incomplete inventory');
          manifest.inventory.push({ id: issue.id, key: issue.key });
          lastNumber = keyNumber(issue.key);
        }
        manifest.searchPages.push(ref);
        if (page.length) manifest.cursor = page.at(-1)!.key;
        else manifest.inventoryComplete = true;
        await archive.save(manifest);
        log('Inventory: ' + manifest.inventory.length + ' accessible issues');
        // Query one empty page to prove exhaustion, rather than assuming page size.
        if (!page.length) break;
      }
    }
    const queue = selection ? [...selection] : manifest.inventory.map(item => item.key);
    const queued = new Set(queue);
    for (const key of queue) {
      const known = Object.values(manifest.issues).find(item => item.key === key);
      let issue;
      if (known) issue = issueSchema.parse(parseJson(await archive.read(known.raw)));
      else {
        const raw = await source.get('/rest/api/3/issue/' + key + '?fields=*all');
        issue = issueSchema.parse(parseJson(raw));
        const expected = manifest.inventory.find(item => item.key === key);
        if (issue.key !== key || issue.fields.project.key !== project || (expected && expected.id !== issue.id)) throw new Error('Source issue identity mismatch: ' + key);
        const folder = 'raw/issues/' + issue.id;
        const rawRef = await archive.write(folder + '/issue.json', raw);
        const comments = issue.fields.comment.total ? await exportPages(source, archive, '/rest/api/3/issue/' + issue.id + '/comment', 'comments', folder + '/comments', issue.fields.comment.total) : [];
        const changelog = await exportPages(source, archive, '/rest/api/3/issue/' + issue.id + '/changelog', 'values', folder + '/changelog');
        const attachments: Record<string, FileRef> = {};
        for (const attachment of issue.fields.attachment) {
          const data = await source.get(attachment.content);
          if (data.length !== attachment.size) throw new Error('Attachment byte count mismatch: ' + key + '/' + attachment.id);
          attachments[attachment.id] = await archive.write('attachments/' + issue.id + '/' + attachment.id + '.bin', data);
          await archive.read(attachments[attachment.id]!);
        }
        // Catch edits occurring while comments/history/binaries were being read.
        const latest = issueSchema.parse(parseJson(await source.get('/rest/api/3/issue/' + issue.id + '?fields=*all')));
        if (latest.id !== issue.id || latest.key !== issue.key || latest.fields.updated !== issue.fields.updated) throw new Error('Source changed during export: ' + key + '; rerun to retry this issue');
        manifest.issues[issue.id] = { id: issue.id, key, sourceUrl: source.server + '/browse/' + key, updated: issue.fields.updated, raw: rawRef, comments, changelog, attachments };
        if (!expected) manifest.inventory.push({ id: issue.id, key });
        await archive.save(manifest);
        log('Exported ' + key + ' (' + Object.keys(manifest.issues).length + ' issues)');
      }
      const parent = issue.fields.parent;
      if (parent && !queued.has(parent.key)) {
        if (!parent.key.startsWith(project + '-')) throw new Error('Cross-project parent needs a separate export: ' + parent.key);
        queue.push(parent.key); queued.add(parent.key);
      }
    }
    manifest.inventoryComplete = true;
    manifest.completedAt = new Date().toISOString();
    await archive.verify(manifest);
    await archive.save(manifest);
    return manifest;
  } finally { await rm(lock, { recursive: true }); }
}

async function exportPages(source: JiraSource, archive: Archive, path: string, field: string, folder: string, expectedTotal?: number) {
  const refs: FileRef[] = [];
  let startAt = 0;
  let total: number | undefined = expectedTotal;
  const ids = new Set<string>();
  while (true) {
    const raw = await source.get(path + '?startAt=' + startAt + '&maxResults=100');
    const page = z.object({ startAt: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).passthrough().parse(parseJson(raw));
    const items = z.array(z.object({ id: z.string() }).passthrough()).parse(page[field]);
    if (page.startAt !== startAt || (total !== undefined && page.total !== total) || (!items.length && startAt < page.total)) throw new Error('Pagination changed or failed to advance: ' + path);
    total = page.total;
    for (const item of items) { if (ids.has(item.id)) throw new Error('Repeated paginated source ID: ' + path); ids.add(item.id); }
    refs.push(await archive.write(folder + '/' + startAt + '.json', raw));
    startAt += items.length;
    if (startAt === total) break;
    if (startAt > total) throw new Error('Pagination exceeded total: ' + path);
  }
  return refs;
}
