import { z } from 'zod';
import type { JiraAttachment } from './types.js';

interface Node { type: string; text?: string; attrs?: Record<string, unknown>; content?: Node[]; marks?: { type: string; attrs?: Record<string, unknown> }[] }
const nodeSchema: z.ZodType<Node> = z.lazy(() => z.object({
  type: z.string(), text: z.string().optional(), attrs: z.record(z.string(), z.unknown()).optional(),
  content: z.array(nodeSchema).optional(), marks: z.array(z.object({ type: z.string(), attrs: z.record(z.string(), z.unknown()).optional() })).optional(),
}));
export interface MediaReference { mediaId: string; attachmentId: string; filename: string; placeholder: string }
export const escapeMarkdown = (text: string) => text.replace(/([\\`*_[\]<>#|~])/g, '\\$1');
function url(value: unknown) {
  if (typeof value !== 'string' || !/^(https?:|mailto:)/i.test(value)) throw new Error('Unsupported or unsafe ADF link URL');
  return value.replace(/[\s()<>]/g, char => encodeURIComponent(char).replace(/[()]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase()));
}
function ticks(text: string, minimum: number) {
  return '`'.repeat(Math.max(minimum, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
}

function wrapped(text: string, syntax: string) {
  const [, leading, body, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return leading + (body ? syntax + body + syntax : '') + trailing;
}

export function adfToMarkdown(value: unknown, attachments: JiraAttachment[], media: MediaReference[] = []) {
  if (value === null || value === undefined) return '';
  const root = nodeSchema.parse(value);
  if (root.type !== 'doc') throw new Error('Expected an ADF document');
  const inline = (node: Node): string => (node.content ?? []).map(render).join('');
  const blocks = (node: Node): string => (node.content ?? []).map(render).filter(Boolean).join('\n\n');
  function render(node: Node): string {
    switch (node.type) {
      case 'doc': case 'listItem': case 'tableCell': case 'tableHeader': return blocks(node);
      case 'paragraph': return inline(node);
      case 'text': {
        const raw = node.text ?? '';
        const code = node.marks?.some(mark => mark.type === 'code');
        const fence = ticks(raw, 1);
        let text = code ? fence + ' ' + raw + ' ' + fence : escapeMarkdown(raw);
        for (const mark of node.marks ?? []) {
          switch (mark.type) {
            case 'code': break;
            case 'strong': text = wrapped(text, '**'); break;
            case 'em': text = wrapped(text, '*'); break;
            case 'strike': text = wrapped(text, '~~'); break;
            case 'link': text = '[' + text + '](' + url(mark.attrs?.href) + ')'; break;
            default: throw new Error('Unsupported ADF mark: ' + mark.type);
          }
        }
        return text;
      }
      case 'heading': {
        const level = Number(node.attrs?.level);
        if (!Number.isInteger(level) || level < 1 || level > 6) throw new Error('Invalid ADF heading level');
        return '#'.repeat(level) + ' ' + inline(node);
      }
      case 'hardBreak': return '  \n';
      case 'rule': return '---';
      case 'blockquote': return blocks(node).split('\n').map(line => '> ' + line).join('\n');
      case 'codeBlock': {
        const text = (node.content ?? []).map(child => { if (child.type !== 'text') throw new Error('Unexpected node in code block'); return child.text ?? ''; }).join('');
        const fence = ticks(text, 3);
        const language = String(node.attrs?.language ?? '').replace(/[^a-zA-Z0-9_+-]/g, '');
        return fence + language + '\n' + text + (text.endsWith('\n') ? '' : '\n') + fence;
      }
      case 'bulletList': case 'orderedList': {
        const start = Number(node.attrs?.order ?? 1);
        return (node.content ?? []).map((item, index) => {
          if (item.type !== 'listItem') throw new Error('Unexpected node in list');
          const prefix = node.type === 'bulletList' ? '- ' : (start + index) + '. ';
          const lines = render(item).split('\n');
          return prefix + lines[0] + lines.slice(1).map(line => '\n' + (line ? ' '.repeat(prefix.length) + line : '')).join('');
        }).join('\n');
      }
      case 'mention': {
        const label = String(node.attrs?.text ?? node.attrs?.id ?? 'Unknown person');
        return escapeMarkdown(label.startsWith('@') ? label : '@' + label);
      }
      case 'inlineCard': case 'blockCard': {
        const link = url(node.attrs?.url);
        return '[' + escapeMarkdown(String(node.attrs?.url)) + '](' + link + ')';
      }
      case 'mediaSingle': case 'mediaGroup': return blocks(node);
      case 'media': {
        if (node.attrs?.type !== 'file') throw new Error('Unsupported external ADF media');
        const filename = String(node.attrs?.alt ?? '');
        const matches = attachments.filter(attachment => attachment.filename === filename);
        if (!filename || matches.length !== 1) throw new Error('Missing or ambiguous media attachment: ' + (filename || String(node.attrs?.id)));
        const attachment = matches[0]!;
        const mediaId = String(node.attrs?.id ?? '');
        if (!mediaId) throw new Error('Missing ADF media identity');
        const placeholder = 'attachment://' + attachment.id;
        const existing = media.find(item => item.mediaId === mediaId);
        if (existing && existing.attachmentId !== attachment.id) throw new Error('Conflicting ADF media mapping');
        if (!existing) media.push({ mediaId, attachmentId: attachment.id, filename, placeholder });
        return '![' + escapeMarkdown(filename) + '](' + placeholder + ')';
      }
      case 'table': {
        const rows = (node.content ?? []).map(row => {
          if (row.type !== 'tableRow') throw new Error('Unexpected node in table');
          return (row.content ?? []).map(cell => {
            if (!['tableCell', 'tableHeader'].includes(cell.type) || Number(cell.attrs?.colspan ?? 1) !== 1 || Number(cell.attrs?.rowspan ?? 1) !== 1) throw new Error('Unsupported merged ADF table cell');
            // GFM cells cannot contain block structure. Keep all text readable;
            // raw ADF retains the original layout. Escape even pipes in code.
            return render(cell).replace(/\n+/g, ' / ').replace(/(?<!\\)\|/g, '\\|');
          });
        });
        const width = Math.max(0, ...rows.map(row => row.length));
        if (!width) return '';
        if (rows.some(row => row.length !== width)) throw new Error('Uneven ADF table rows');
        const hasHeader = node.content?.[0]?.content?.every(cell => cell.type === 'tableHeader');
        const header = hasHeader ? rows.shift()! : Array<string>(width).fill('');
        const line = (row: string[]) => '| ' + row.join(' | ') + ' |';
        return [line(header), line(Array<string>(width).fill('---')), ...rows.map(line)].join('\n');
      }
      default: throw new Error('Unsupported ADF node: ' + node.type);
    }
  }
  return render(root).trim();
}
