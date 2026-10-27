import { readFile } from 'node:fs/promises';
import { Agent } from 'undici';

export async function createTransport(certPath?: string, keyPath?: string) {
  if (Boolean(certPath) !== Boolean(keyPath)) {
    throw new Error('Supply both --client-cert and --client-key (or ISSUES_CLIENT_CERT and ISSUES_CLIENT_KEY)');
  }
  if (!certPath || !keyPath) return { fetch: globalThis.fetch, close: async () => {} };

  const [cert, key] = await Promise.all([readFile(certPath), readFile(keyPath)]);
  const dispatcher = new Agent({ connect: { cert, key } });
  const fetch: typeof globalThis.fetch = (input, init) => {
    const options = { ...init, dispatcher };
    return globalThis.fetch(input, options);
  };
  return { fetch, close: () => dispatcher.close() };
}
