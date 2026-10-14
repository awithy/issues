#!/usr/bin/env node
import { Command } from 'commander';
import { Archive } from './jira/archive.js';
import { exportProject } from './jira/export.js';
import { planExport } from './jira/plan.js';
import { JiraApiSource } from './jira/source.js';
import { checkSource } from './jira/check-source.js';
import { destinationClient } from './jira/destination.js';
import { applyPlan, preflight, verifyDestination } from './jira/import.js';

const program = new Command().name('jira-migrate').description('Jira export, offline planning, destination preflight and resumable Issues API import.');
program.command('export').requiredOption('--server <origin>', 'Jira Cloud HTTPS origin; authenticated with its ~/.netrc entry')
  .requiredOption('--project <key>', 'Source project key').requiredOption('--out <directory>', 'Private durable export directory (never commit it)')
  .option('--keys <keys>', 'Comma-separated pilot keys; include required link endpoints; parents are fetched automatically')
  .action(async options => {
    const manifest = await exportProject(new JiraApiSource(options.server), options.out, options.project.toUpperCase(), options.keys?.split(',').map((key: string) => key.trim().toUpperCase()), message => console.error(message));
    console.log(JSON.stringify({ directory: new Archive(options.out).root, server: manifest.server, project: manifest.project, issues: Object.keys(manifest.issues).length, attachments: Object.values(manifest.issues).reduce((count, issue) => count + Object.keys(issue.attachments).length, 0), startedAt: manifest.startedAt, completedAt: manifest.completedAt, scope: manifest.scope, pilot: !!manifest.selection }, null, 2));
  });
program.command('verify <directory>').description('Verify every archived raw response and binary against its recorded SHA-256')
  .action(async directory => {
    const archive = new Archive(directory);
    const manifest = await archive.manifest();
    if (!manifest) throw new Error('Export manifest not found');
    console.log(JSON.stringify({ ...await archive.verify(manifest), issues: Object.keys(manifest.issues).length, complete: !!manifest.completedAt }, null, 2));
  });
program.command('plan <directory>').description('Verify the export and write plan.json with Markdown, native field templates, source IDs and blockers')
  .action(async directory => {
    const plan = await planExport(directory);
    const archive = new Archive(directory);
    await archive.json('plan.json', plan);
    console.log(JSON.stringify({ path: archive.path('plan.json'), issues: plan.issues.length, statuses: plan.statuses, links: plan.links.length, mediaReferences: plan.issues.reduce((count, issue) => count + issue.media.length, 0), blockers: plan.blockers, warnings: plan.warnings }, null, 2));
    if (plan.blockers.length) process.exitCode = 1;
  });
program.command('check-source <directory>').description('Compare a full export with fresh accessible Jira keys/updated timestamps; archive evidence separately')
  .requiredOption('--out <directory>', 'Private source-check evidence directory, separate from the export')
  .action(async (directory, options) => {
    const manifest = await new Archive(directory).manifest();
    if (!manifest) throw new Error('Export manifest not found');
    const { pages, ...result } = await checkSource(directory, options.out, new JiraApiSource(manifest.server));
    console.log(JSON.stringify({ ...result, pages: pages.length, evidence: new Archive(options.out).path('source-check.json') }, null, 2));
    if (!result.unchanged) process.exitCode = 1;
  });
for (const command of ['preflight', 'apply', 'verify-destination'] as const) {
  const entry = program.command(command + ' <directory>')
    .description(command === 'apply' ? 'Import a verified export through the Issues API, then verify all destination content' : command === 'preflight' ? 'Read-only destination checks, including collisions and manifest ownership' : 'Read back and verify fields, source identities, relationships and attachment SHA-256')
    .requiredOption('--state <directory>', 'Separate private destination-bound manifest directory; reuse for reruns and pilot-to-full expansion')
    .option('--api <url>', 'Issues API URL; defaults to ISSUES_API_URL or the saved issctl session');
  if (command === 'apply') entry.requiredOption('--yes', 'Authorize destination project/status/issue/file/link writes');
  entry.action(async (directory, options) => {
    const plan = await planExport(directory);
    const api = await destinationClient(options.api);
    if (command === 'apply') console.log(JSON.stringify(await applyPlan(api, plan, directory, options.state, message => console.error(message)), null, 2));
    else if (command === 'verify-destination') console.log(JSON.stringify(await verifyDestination(api, plan, options.state), null, 2));
    else {
      const result = await preflight(api, plan, options.state);
      console.log(JSON.stringify({ apiUrl: api.baseUrl, username: result.username, projectId: result.project?.projectId, existingIssues: result.issues.length, plannedIssues: plan.issues.length, statuses: result.statuses, resumed: !!result.state, permissionModel: 'All authenticated users have the same project/issue/file write access; no separate write ACL exists.' }, null, 2));
    }
  });
}
try { await program.parseAsync(); }
catch (error) { console.error('Error: ' + (error instanceof Error ? error.message : String(error))); process.exitCode = 1; }
