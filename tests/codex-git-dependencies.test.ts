import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexComplete } from '../src/agent/runtime/codex/complete.js';
import { createCodexBackend } from '../src/agent/runtime/codex/runner.js';
import { codexGitDependencies } from '../src/agent/runtime/codex/git-dependencies.js';
import { codexConfinement, sideCallConfinement } from '../src/agent/runtime/codex/sandbox.js';
import type { AgentRunInput } from '../src/agent/types.js';
import { WorkspaceStore } from '../src/workspaces/store.js';
import { FakeCodex } from './fake-codex.js';
import { room } from './runtime-conformance.js';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const input = (extra: Partial<AgentRunInput> = {}): AgentRunInput => ({ prompt: 'hello', requesterName: 'kay', viaAgent: false, context: [], scope: 'folder', signal: new AbortController().signal, onEvent: () => undefined, onFileTouched: () => undefined, canUseTool: async () => true, ...extra });
const profile = (params: Record<string, unknown>) => (params.config as Record<string, { filesystem: Record<string, string>; extends?: string }>)['permissions.beluga']!;

describe('Codex linked Git metadata dependencies', () => {
  let repo: string;
  let other: string;
  let work: string;
  let second: string;
  let fixup: string;
  let common: string;
  let admin: string;
  const store = new WorkspaceStore();

  beforeAll(() => {
    const base = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'codex git dependencies ')));
    repo = path.join(base, 'original repo');
    other = path.join(base, 'untrusted repo');
    for (const dir of [repo, other]) {
      mkdirSync(dir);
      git(dir, 'init');
      git(dir, 'commit', '--allow-empty', '-m', 'initial');
    }
    work = path.join(base, 'managed worktree');
    second = path.join(base, 'additional worktree');
    fixup = path.join(base, 'hidden fixup');
    for (const [i, dir] of [work, second, fixup].entries()) git(repo, 'worktree', 'add', '-b', `task-${i}`, dir);
    common = realpathSync(git(work, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    admin = realpathSync(git(work, 'rev-parse', '--absolute-git-dir'));
  });

  beforeEach(() => {
    // Protected host state supplies the expected repository; the hidden fixup has no record.
    store.saveRecords([{ id: 'task', projectRoot: repo, name: 'task', path: work, kind: 'worktree', createdAt: 0 }]);
  });

  const run = async (cwd: string, extra: Partial<AgentRunInput> = {}, additionalDirectories: string[] = []) => {
    const codex = new FakeCodex();
    await createCodexBackend({ cwd, autoEdit: true, additionalDirectories, bridge: room, connect: codex.connect }).run(input(extra));
    return codex;
  };

  it('registers Git-discovered external metadata read-only, retaining secret denials', async () => {
    const codex = await run(work);
    const p = profile(codex.sent('thread/start')[0]!);
    expect(p.filesystem[admin]).toBe('read');
    expect(p.filesystem[common]).toBe('read');
    expect(p.filesystem[repo]).toBeUndefined();
    expect(p.filesystem[work]).toBe('write');
    expect(p.filesystem[`${work}/**/.env*`]).toBe('deny');
    expect(p.filesystem[`${common}/**/.env*`]).toBe('deny');
    expect(p.filesystem[path.join(os.homedir(), '.ssh')]).toBe('deny');
    expect(codex.sent('turn/start')[0]!.sandboxPolicy).toBeUndefined();
  });

  it('does not reopen a normal repository’s in-workspace metadata', async () => {
    const p = profile((await run(repo)).sent('thread/start')[0]!);
    expect(p.filesystem[common]).toBeUndefined();
    expect(p.filesystem[repo]).toBe('write');
  });

  it('includes additional and unrecorded fixup worktrees sharing the trusted repository', async () => {
    const codex = await run(work, { place: { cwd: work, additionalDirectories: [second], autoEdit: false, fixup, onSession: () => undefined } });
    const p = profile(codex.sent('thread/start')[0]!);
    for (const dir of [work, second, fixup]) {
      expect(p.filesystem[realpathSync(git(dir, 'rev-parse', '--absolute-git-dir'))]).toBe('read');
    }
    expect(p.filesystem[common]).toBe('read');
    expect(p.filesystem[fixup]).toBe('write');
    expect(p.filesystem[work]).toBe('read');
  });

  it('retains read-only metadata while planning and when reopening the thread for work', async () => {
    const codex = await run(work, { plan: true, askUser: async () => ({ kind: 'plan', approve: true, feedback: '' }) });
    const planned = profile(codex.sent('thread/start')[0]!);
    const resumed = profile(codex.sent('thread/resume')[0]!);
    expect(planned.extends).toBe(':read-only');
    expect(resumed.extends).toBe(':workspace');
    for (const p of [planned, resumed]) {
      expect(p.filesystem[admin]).toBe('read');
      expect(p.filesystem[common]).toBe('read');
    }
  });

  it('gives Git metadata to tool-bearing side calls, never tool-free calls', async () => {
    for (const tools of [['Bash'], []]) {
      const codex = new FakeCodex();
      await codexComplete({ cwd: work, system: 'Review', prompt: 'hello', tools }, { connect: codex.connect });
      const p = profile(codex.sent('thread/start')[0]!);
      expect(p.filesystem[common]).toBe(tools.length ? 'read' : undefined);
      expect(p.filesystem[admin]).toBe(tools.length ? 'read' : undefined);
    }
  });

  it('does not trust a pointer redirected to another repository', async () => {
    const pointer = path.join(work, '.git');
    const original = readFileSync(pointer);
    try {
      rmSync(pointer);
      writeFileSync(pointer, `gitdir: ${path.join(other, '.git')}\n`);
      const p = profile((await run(work)).sent('thread/start')[0]!);
      expect(p.filesystem[common]).toBeUndefined();
      expect(p.filesystem[path.join(other, '.git')]).toBeUndefined();
    } finally {
      writeFileSync(pointer, original);
    }
  });

  it('deduplicates common metadata across worktrees and Windows path spellings', async () => {
    const folders = process.platform === 'win32' ? [work.replaceAll('\\', '/').toUpperCase(), second, work] : [work, second, work];
    const deps = await codexGitDependencies(folders);
    expect(deps).toHaveLength(3);
    expect(deps.filter((p) => p === common)).toHaveLength(1);
    expect(deps).toContain(admin);
  });

  it('uses the recorded expected repository even if the target is registered in another known repository', async () => {
    store.saveRecords([
      { id: 'task', projectRoot: other, name: 'task', path: work, kind: 'worktree', createdAt: 0 },
      { id: 'second', projectRoot: repo, name: 'second', path: second, kind: 'worktree', createdAt: 0 },
    ]);
    expect(await codexGitDependencies([work])).toEqual([]);
  });

  it('checks the expected repository through workspace directory aliases too', async () => {
    const alias = path.join(path.dirname(work), 'workspace alias');
    symlinkSync(work, alias, process.platform === 'win32' ? 'junction' : 'dir');
    store.saveRecords([
      { id: 'task', projectRoot: other, name: 'task', path: alias, kind: 'worktree', createdAt: 0 },
      { id: 'second', projectRoot: repo, name: 'second', path: second, kind: 'worktree', createdAt: 0 },
    ]);
    expect(await codexGitDependencies([work])).toEqual([]);
  });

  it('does not grant dependencies without a trusted host repository record', async () => {
    store.saveRecords([]);
    expect(await codexGitDependencies([work])).toEqual([]);
  });

  it('supports a trusted repository whose common Git directory is separate from its checkout', async () => {
    const dir = path.join(path.dirname(work), 'separate checkout');
    const metadata = path.join(path.dirname(work), 'separate metadata');
    const linked = path.join(path.dirname(work), 'separate linked worktree');
    mkdirSync(dir);
    git(dir, 'init', '--separate-git-dir', metadata);
    git(dir, 'commit', '--allow-empty', '-m', 'initial');
    git(dir, 'worktree', 'add', '-b', 'separate-task', linked);
    store.saveRecords([{ id: 'separate', projectRoot: dir, name: 'separate', path: linked, kind: 'worktree', createdAt: 0 }]);
    const deps = await codexGitDependencies([linked]);
    expect(deps).toEqual([realpathSync(metadata), realpathSync(git(linked, 'rev-parse', '--absolute-git-dir'))]);
    expect(deps).not.toContain(dir);
  });

  it.skipIf(process.platform === 'win32')('rejects symlinked pointer files even when they point to a registered worktree', async () => {
    const fake = path.join(path.dirname(work), 'symlinked pointer worktree');
    mkdirSync(fake);
    // File symlinks require privileges on Windows; directory aliases are exercised above there.
    symlinkSync(path.join(work, '.git'), path.join(fake, '.git'));
    expect(await codexGitDependencies([fake])).toEqual([]);
  });

  it('rejects a copied pointer whose admin backlink names a different worktree', async () => {
    const fake = path.join(path.dirname(work), 'copied worktree');
    mkdirSync(fake);
    writeFileSync(path.join(fake, '.git'), readFileSync(path.join(work, '.git')));
    expect(await codexGitDependencies([fake])).toEqual([]);
  });

  it('accepts a relative Git pointer and rejects missing or malformed ones', async () => {
    const pointer = path.join(work, '.git');
    const original = readFileSync(pointer);
    rmSync(pointer);
    try {
      for (const target of ['malformed', 'gitdir: missing-directory']) {
        writeFileSync(pointer, `${target}\n`);
        expect(await codexGitDependencies([work])).toEqual([]);
      }
      writeFileSync(pointer, `gitdir: ${path.relative(work, admin).replaceAll('\\', '/')}\n`);
      expect(await codexGitDependencies([work])).toEqual([common, admin]);
    } finally {
      writeFileSync(pointer, original);
    }
  });

  it('ignores inherited Git directory overrides during discovery', async () => {
    vi.stubEnv('GIT_DIR', path.join(other, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other);
    try {
      expect(await codexGitDependencies([work])).toEqual([common, admin]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('retains metadata reads and approval policy on an explicitly resumed read-only conversation', async () => {
    const first = await run(work);
    const resume = String(first.sent('turn/start')[0]!.threadId);
    const codex = new FakeCodex();
    await createCodexBackend({ cwd: work, autoEdit: false, additionalDirectories: [], bridge: room, connect: codex.connect }).run(input({ place: { cwd: work, additionalDirectories: [], autoEdit: false, resume, onSession: () => undefined } }));
    const params = codex.sent('thread/resume')[0]!;
    expect(params.approvalPolicy).toBe('on-request');
    expect(profile(params).filesystem[common]).toBe('read');
    expect(profile(params).filesystem[work]).toBe('read');
  });

  it('keeps restricted runs confined to workspace writes, with metadata read-only', async () => {
    const codex = await run(work, { viaAgent: true });
    const params = codex.sent('thread/start')[0]!;
    const p = profile(params);
    expect(params.approvalPolicy).toBe('never');
    expect(p.filesystem[admin]).toBe('read');
    expect(p.filesystem[common]).toBe('read');
    expect(p.filesystem[repo]).toBeUndefined();
    expect(Object.entries(p.filesystem).filter(([, mode]) => mode === 'write')).toEqual([[work, 'write']]);
    expect(p.filesystem[`${common}/**/*.key`]).toBe('deny');
  });

  it('never reopens credential stores through dependency grants, including in tool-free calls', () => {
    const secret = path.join(os.homedir(), '.ssh');
    const c = codexConfinement('own', 'full', { cwd: work, folders: [], writable: [work], readDependencies: [secret, path.join(secret, 'metadata')] });
    const p = profile({ config: c.config });
    expect(p.filesystem[secret]).toBe('deny');
    expect(p.filesystem[path.join(secret, 'metadata')]).toBeUndefined();
    const side = sideCallConfinement(work, { readDependencies: [common, admin] });
    expect(profile({ config: side.config }).filesystem[common]).toBeUndefined();
  });
});
