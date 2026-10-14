import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
export async function readPassword(prompt = 'Password: '): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Set ISSUES_PASSWORD when running non-interactively');
  let muted = false;
  const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve, reject) => {
    rl.on('SIGINT', () => { rl.close(); process.stdout.write('\n'); reject(new Error('Cancelled')); });
    rl.question(prompt, value => { rl.close(); process.stdout.write('\n'); resolve(value); });
    muted = true;
  });
}
