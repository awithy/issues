import type { Attachment } from './types.js';

const imageTypes: Record<string, string> = {
  png: 'image/png', apng: 'image/apng', jpg: 'image/jpeg', jpeg: 'image/jpeg', jfif: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
};
const allowedTypes = new Set([...Object.values(imageTypes), 'image/vnd.microsoft.icon']);

// Only raster formats: HTML and SVG must remain downloads, never same-origin inline documents.
export function attachmentImageType(file: Pick<Attachment, 'filename' | 'contentType'>): string | undefined {
  const contentType = file.contentType.toLowerCase().split(';')[0]!.trim();
  if (allowedTypes.has(contentType)) return contentType;
  const extension = file.filename.split('.').pop()?.toLowerCase() || '';
  return Object.hasOwn(imageTypes, extension) ? imageTypes[extension] : undefined;
}
