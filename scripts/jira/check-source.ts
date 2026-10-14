import { z } from 'zod';
import { Archive } from './archive.js';
import { keyNumber, parseJson, timestamp } from './types.js';
import type { FileRef, JiraSource } from './types.js';

// Observational delta check, not a source lock or a point-in-time guarantee.
export async function checkSource(root: string, out: string, source: JiraSource) {
  const archive = new Archive(root);
  const manifest = await archive.manifest();
  if (!manifest?.completedAt || !manifest.inventoryComplete || manifest.selection) throw new Error('Source comparison requires a completed full-project export');
  if (source.server !== manifest.server) throw new Error('Source instance differs from the archive');
  const evidence = new Archive(out);
  if (evidence.root === archive.root) throw new Error('Source check evidence must be separate from the immutable export');
  await archive.verify(manifest);
  await evidence.init();
  const startedAt = new Date().toISOString();
  const pages: FileRef[] = [];
  const inventory = new Map<string, { key: string; updated: string }>();
  let cursor: string | undefined;
  while (true) {
    const raw = await source.search(manifest.project, cursor, 'updated');
    const parsed = parseJson(raw);
    const page = z.array(z.object({ id: z.string(), key: z.string(), self: z.url(), fields: z.object({ updated: z.string() }) })).parse(Array.isArray(parsed) ? parsed : z.object({ issues: z.array(z.unknown()) }).parse(parsed).issues);
    pages.push(await evidence.write('pages/' + pages.length + '.json', raw));
    let last = cursor ? keyNumber(cursor) : 0;
    for (const issue of page) {
      if (!new RegExp('^' + manifest.project + '-[1-9]\\d*$').test(issue.key) || new URL(issue.self).origin !== source.server || keyNumber(issue.key) <= last || inventory.has(issue.id)) throw new Error('Source comparison inventory failed to advance or changed identity');
      inventory.set(issue.id, { key: issue.key, updated: timestamp(issue.fields.updated) });
      last = keyNumber(issue.key);
    }
    if (!page.length) break;
    cursor = page.at(-1)!.key;
  }
  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  for (const [id, issue] of inventory) {
    const original = manifest.issues[id];
    if (!original) added.push(issue.key);
    else if (original.key !== issue.key || timestamp(original.updated) !== issue.updated) changed.push(issue.key);
  }
  for (const original of Object.values(manifest.issues)) if (!inventory.has(original.id)) removed.push(original.key);
  const result = { server: source.server, project: manifest.project, exportCompletedAt: manifest.completedAt, startedAt, completedAt: new Date().toISOString(), issues: inventory.size,
    unchanged: !added.length && !removed.length && !changed.length, added, removed, changed, pages,
    warning: 'Accessible records only. This paginated observation is not a Jira freeze or a point-in-time snapshot; absence may mean reduced account visibility.' };
  await evidence.json('source-check.json', result);
  return result;
}
