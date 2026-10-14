import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, resolve, sep } from 'node:path';
import type { FileRef, Manifest } from './types.js';

export const checksum = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
export class Archive {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  path(relative: string) {
    const path = resolve(this.root, relative);
    if (!path.startsWith(this.root + sep)) throw new Error('Archive path escapes the export directory');
    return path;
  }
  async init() { await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700); }
  async write(path: string, data: Buffer): Promise<FileRef> {
    const destination = this.path(path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination + '.tmp', data, { mode: 0o600 });
    await rename(destination + '.tmp', destination);
    return { path, size: data.length, sha256: checksum(data) };
  }
  async json(path: string, value: unknown) { return this.write(path, Buffer.from(JSON.stringify(value, null, 2) + '\n')); }
  async read(ref: FileRef) {
    const data = await readFile(this.path(ref.path));
    if (data.length !== ref.size || checksum(data) !== ref.sha256) throw new Error('Archive checksum mismatch: ' + ref.path);
    return data;
  }
  async manifest(): Promise<Manifest | undefined> {
    let data: string;
    try { data = await readFile(this.path('manifest.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const value = JSON.parse(data) as Manifest;
    if (value.version !== 1 || value.scope !== 'accessible') throw new Error('Unsupported export manifest');
    return value;
  }
  async save(manifest: Manifest) { await this.json('manifest.json', manifest); }
  async verify(manifest: Manifest) {
    const refs = [...Object.values(manifest.metadata), ...manifest.searchPages];
    for (const issue of Object.values(manifest.issues)) refs.push(issue.raw, ...issue.comments, ...issue.changelog, ...Object.values(issue.attachments));
    for (const ref of refs) await this.read(ref);
    return { files: refs.length, bytes: refs.reduce((sum, ref) => sum + ref.size, 0) };
  }
}
