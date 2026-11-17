import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { belugaHomeDir } from '../../../core/shares.js';
import { WorkspaceStore } from '../../../workspaces/store.js';

const exec = promisify(execFile);
const key = (p: string): string => process.platform === 'win32' ? p.toLowerCase() : p;
const same = (a: string, b: string): boolean => key(a) === key(b);

/** Git discovery only: no hooks, shell, or inherited Git directory/config overrides. */
async function git(cwd: string, args: readonly string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('GIT_')));
  const { stdout } = await exec('git', [...args], { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull }, timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true });
  return stdout;
}

/**
 * External metadata for linked worktrees of repositories Beluga knows on the host. Never trust
 * a worktree's pointer alone: check its common directory against protected workspace records,
 * Git's registration, and the admin directory's backlink. Hidden fixups need no workspace record
 * of their own, but must be registered in one of those repositories too. No metadata writes.
 */
export async function codexGitDependencies(folders: readonly string[]): Promise<string[]> {
  const records = await Promise.all(new WorkspaceStore(belugaHomeDir()).loadRecords().filter((r) => r.projectRoot && !r.archived).map(async (r) => ({ ...r, path: await realpath(r.path).catch(() => path.resolve(r.path)) })));
  const repositories = [...new Set(records.map((r) => r.projectRoot))];
  const discovered = new Map<string, Promise<{ common: string; worktrees: string[] } | undefined>>();
  const repository = (root: string) => {
    let found = discovered.get(root);
    if (!found) {
      found = (async () => {
        const common = await realpath((await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim());
        const listed = await git(root, ['worktree', 'list', '--porcelain', '-z']);
        const worktrees = listed.split('\0').filter((field) => field.startsWith('worktree ')).map((field) => field.slice(9));
        return { common, worktrees };
      })().catch(() => undefined);
      discovered.set(root, found);
    }
    return found;
  };
  const dependencies = new Map<string, string>();
  for (const folder of folders) {
    try {
      // Ordinary repos need no external dependency. Reject symlinked pointer files as well.
      if (!(await lstat(path.join(folder, '.git'))).isFile()) continue;
      const cwd = await realpath(folder);
      const [gitDir, commonDir, top] = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'])).trim().split(/\r?\n/);
      if (!gitDir || !commonDir || !top || !same(await realpath(top), cwd)) continue;
      const admin = await realpath(gitDir);
      const common = await realpath(commonDir);
      if (!same(path.dirname(admin), path.join(common, 'worktrees'))) continue;
      const backlink = (await readFile(path.join(admin, 'gitdir'), 'utf8')).trim();
      if (!same(await realpath(path.resolve(admin, backlink)), await realpath(path.join(cwd, '.git')))) continue;
      const expected = records.filter((r) => same(path.resolve(r.path), cwd)).map((r) => r.projectRoot);
      // A recorded workspace must belong to its recorded repo; hidden integration worktrees
      // instead establish that association through the trusted repo's worktree registration.
      for (const root of expected.length ? expected : repositories) {
        const repo = await repository(root);
        if (!repo || !same(repo.common, common)) continue;
        const registered = await Promise.all(repo.worktrees.map((p) => realpath(p).catch(() => '')));
        if (!registered.some((p) => same(p, cwd))) continue;
        for (const dep of [common, admin]) dependencies.set(key(dep), dep);
        break;
      }
    } catch {
      // Missing, malformed or untrusted metadata never grants another filesystem root.
    }
  }
  return [...dependencies.values()];
}
