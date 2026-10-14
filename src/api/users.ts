import { readFile } from 'node:fs/promises';
import { z } from 'zod';
export const usersSchema = z.object({ users: z.array(z.object({
  username: z.string().trim().min(1),
  passwordHash: z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/, 'Expected a bcrypt password hash'),
})).min(1) }).superRefine(({ users }, ctx) => {
  if (new Set(users.map(u => u.username)).size !== users.length) ctx.addIssue({ code: 'custom', message: 'Usernames must be unique' });
});
export type User = z.infer<typeof usersSchema>['users'][number];
export async function loadUsers(path: string): Promise<User[]> {
  try { return usersSchema.parse(JSON.parse(await readFile(path, 'utf8'))).users; }
  catch (error) { throw new Error('Cannot load users from ' + path + '. Run npm run user:add -- <username>.', { cause: error }); }
}
