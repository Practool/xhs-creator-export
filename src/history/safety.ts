import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export class HistoryError extends Error {
  constructor(readonly code: string, readonly action: string) { super(`${code}: ${action}`); }
}
export function problem(error: unknown): HistoryError {
  if (error instanceof HistoryError) return error;
  const code = (error as any)?.code;
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') return new HistoryError('DB_LOCKED', '关闭其他历史写入进程后重试。');
  if (code === 'SQLITE_READONLY' || code === 'EACCES' || code === 'EPERM') return new HistoryError('READ_ONLY', '检查私有目录写权限后重试。');
  if (code === 'ENOENT') return new HistoryError('SOURCE_MISSING', '检查配置路径及本地 Job 文件。');
  return new HistoryError('HISTORY_FAILED', '运行 history verify；保留原文件，不要删除数据库。');
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
export function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw new HistoryError('CANCELLED', '同步已安全停止；重新执行相同命令即可继续。'); }
export function checkId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(value)) throw new HistoryError('INVALID_ID', '使用原始 Job 或笔记稳定 ID。');
  return value;
}
// Reject symlinks in every existing path component, including aliases of Git worktrees.
export async function noSymlinks(filename: string): Promise<void> {
  let current = path.parse(path.resolve(filename)).root;
  for (const part of path.resolve(filename).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = await fs.lstat(current).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
    if (st?.isSymbolicLink()) throw new HistoryError('UNSAFE_PATH', '路径不能包含符号链接。');
  }
}
export async function privateDestination(filename: string): Promise<void> {
  filename = path.resolve(filename);
  if(filename.split(path.sep).some(part=>part.toLowerCase()==='.git')) throw new HistoryError('UNSAFE_PATH', '不能向 Git 元数据目录写入历史数据。');
  await noSymlinks(filename);
  let ancestor = filename;
  while (!await fs.stat(ancestor).then(s => s.isDirectory()).catch(() => false)) {
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  let repo: string;
  try { repo = execFileSync('git', ['-C', ancestor, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch {
    let parent=ancestor;
    for (;;) {
      if(await fs.lstat(path.join(parent,'.git')).then(()=>true).catch(()=>false)) throw new HistoryError('PUBLIC_OUTPUT', '检测到 Git 工作区但无法核验忽略规则；使用仓库外私人目录或安装 Git。');
      const next=path.dirname(parent);if(next===parent)break;parent=next;
    }
    return;
  }
  const relative = path.relative(repo, filename);
  let ignored = false;
  try { execFileSync('git', ['-C', repo, 'check-ignore', '-q', '--', relative], { stdio: 'ignore' }); ignored = true; } catch { /* reject */ }
  const tracked = execFileSync('git', ['-C', repo, 'ls-files', '-z', '--', relative], { encoding: 'utf8' });
  if (!ignored || tracked) throw new HistoryError('PUBLIC_OUTPUT', '请选择仓库外或已被 Git 忽略、未跟踪的私人目录。');
}
export async function readJson(filename: string, limit = 32 * 1024 * 1024): Promise<{ value: any; bytes: Buffer }> {
  await noSymlinks(filename);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit || !before.size) throw new HistoryError('INVALID_SOURCE', '源文件必须是大小受限的非空普通 JSON 文件。');
    // Bounded allocation even if another process grows the file while it is being read.
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const r = await handle.read(bytes, length, bytes.length - length, null); if (!r.bytesRead) break; length += r.bytesRead; }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new HistoryError('SOURCE_CHANGED', '源文件在读取时变化；等待采集或导出结束后重新同步。');
    const content = bytes.subarray(0, length);
    try { return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content)), bytes: content }; }
    catch { throw new HistoryError('INVALID_JSON', '修复或重新导出该 Job 的 JSON 后重试。'); }
  } finally { await handle.close(); }
}
