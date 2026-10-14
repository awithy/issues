import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { JiraSource } from './types.js';

const exec = promisify(execFile);

// Raw Jira Cloud REST requests use the existing host's ~/.netrc credentials.
// Credentials are never put on the command line or included in the archive.
export class JiraApiSource implements JiraSource {
  readonly server: string;
  constructor(server: string) {
    const url = new URL(server);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use an HTTPS Jira origin without credentials or a path');
    this.server = url.origin;
  }
  async search(project: string, after?: string, fields = 'summary') {
    if (!/^[A-Z][A-Z0-9]{0,11}$/.test(project) || (after && !new RegExp('^' + project + '-[1-9]\\d*$').test(after))) throw new Error('Invalid project or keyset cursor');
    const jql = 'project = "' + project + '"' + (after ? ' AND key > "' + after + '"' : '') + ' ORDER BY key ASC';
    // Explicit keyset queries avoid broken offset pagination and let HTTP
    // errors remain errors. jira-cli exits nonzero even for a valid empty page.
    const query = new URLSearchParams({ jql, maxResults: '100', fields });
    return this.get('/rest/api/3/search/jql?' + query);
  }
  async get(path: string) {
    const url = new URL(path, this.server);
    if (url.origin !== this.server || url.username || url.password) throw new Error('Refusing a request with credentials in its URL or a different Jira origin');
    try {
      const { stdout } = await exec('curl', ['--netrc', '--location', '--fail', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https', '--max-time', '120', '--retry', '3', '--retry-delay', '1', url.href], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
      // curl does not forward authentication to a different host on redirect.
      return stdout;
    } catch { throw new Error('Jira GET ' + url.pathname + ' failed; check permissions and the matching ~/.netrc credentials'); }
  }
}
