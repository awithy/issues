import { z } from 'zod';

const person = z.object({ displayName: z.string().optional(), accountId: z.string().optional(), emailAddress: z.string().optional() }).passthrough();
const named = z.object({ id: z.string(), name: z.string() }).passthrough();
export const statusSchema = named.extend({ statusCategory: z.object({ key: z.string() }).passthrough() });
const attachmentSchema = z.object({ id: z.string().regex(/^\d+$/), filename: z.string(), size: z.number().int().nonnegative(), mimeType: z.string(), content: z.url() }).passthrough();
export const commentSchema = z.object({ id: z.string(), author: person.optional(), created: z.string(), updated: z.string().optional(), body: z.unknown() }).passthrough();
export const issueSchema = z.object({
  id: z.string().regex(/^\d+$/), key: z.string().regex(/^[A-Z][A-Z0-9]*-[1-9]\d*$/),
  fields: z.object({
    summary: z.string(), description: z.unknown(), created: z.string(), updated: z.string(), resolutiondate: z.string().nullable(),
    project: named.extend({ key: z.string() }), issuetype: named, status: statusSchema,
    assignee: person.nullable(), reporter: person.nullable(), creator: person.nullable(),
    priority: named.nullable(), resolution: named.nullable(), labels: z.array(z.string()),
    parent: z.object({ id: z.string(), key: z.string() }).passthrough().optional(),
    attachment: z.array(attachmentSchema), comment: z.object({ total: z.number().int().nonnegative() }).passthrough(),
    issuelinks: z.array(z.object({
      id: z.string(), type: named.extend({ inward: z.string(), outward: z.string() }),
      inwardIssue: z.object({ id: z.string(), key: z.string() }).passthrough().optional(),
      outwardIssue: z.object({ id: z.string(), key: z.string() }).passthrough().optional(),
    }).passthrough()),
  }).passthrough(),
}).passthrough();
export type JiraIssue = z.infer<typeof issueSchema>;
export type JiraComment = z.infer<typeof commentSchema>;
export type JiraAttachment = z.infer<typeof attachmentSchema>;
export interface FileRef { path: string; size: number; sha256: string }
export interface ExportedIssue {
  id: string; key: string; updated: string; sourceUrl: string;
  raw: FileRef; comments: FileRef[]; changelog: FileRef[];
  attachments: Record<string, FileRef>;
}
export interface Manifest {
  version: 1; server: string; project: string; selection: string[] | null;
  startedAt: string; completedAt?: string; scope: 'accessible';
  metadata: Record<string, FileRef>;
  inventory: { id: string; key: string }[]; inventoryComplete: boolean; cursor?: string;
  searchPages: FileRef[]; issues: Record<string, ExportedIssue>;
}
export interface JiraSource {
  server: string;
  search(project: string, after?: string, fields?: string): Promise<Buffer>;
  get(path: string): Promise<Buffer>;
}
export const parseJson = (raw: Buffer): unknown => JSON.parse(raw.toString('utf8'));
export function keyNumber(key: string) { return Number(key.slice(key.lastIndexOf('-') + 1)); }
export function timestamp(value: string) {
  const normalized = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  return new Date(z.iso.datetime({ offset: true }).parse(normalized)).toISOString();
}
export function personName(value: z.infer<typeof person> | null | undefined) {
  return value?.displayName || value?.emailAddress || value?.accountId || '';
}
