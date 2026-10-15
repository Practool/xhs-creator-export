import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StorageError } from './errors.js';
import type { Artifact } from './types.js';

export function safePath(root: string, relative: string): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\')) throw new Error('非法相对路径');
  const result = path.resolve(root, relative);
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new Error('路径越界');
  return result;
}
export function safeId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,150}$/.test(id)) throw new Error('非法任务或笔记 ID');
  return id;
}
export async function atomicWrite(filename: string, data: string | Buffer): Promise<void> {
  const tmp = filename + '.' + randomUUID() + '.tmp';
  try {
    await fs.mkdir(path.dirname(filename), { recursive: true });
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.rename(tmp, filename);
  } catch (error) {
    throw new StorageError('文件保存失败：' + (error instanceof Error ? error.message : String(error)));
  } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}
export function digest(data: Buffer): string { return createHash('sha256').update(data).digest('hex'); }
export async function saveArtifact(root: string, relative: string, data: Buffer, extra: Partial<Artifact> = {}): Promise<Artifact> {
  if (!data.length) throw new Error('产物文件为空');
  await atomicWrite(safePath(root, relative), data);
  return { ...extra, path: relative, size: data.length, sha256: digest(data), kind: extra.kind ?? 'screenshot' };
}
export async function verifyArtifact(root: string, artifact: Artifact): Promise<boolean> {
  try {
    const data = await fs.readFile(safePath(root, artifact.path));
    return data.length === artifact.size && digest(data) === artifact.sha256;
  } catch { return false; }
}
export async function acquireLock(profileDir: string): Promise<() => Promise<void>> {
  await fs.mkdir(profileDir, { recursive: true });
  const filename = path.join(profileDir, '.xhs-task.lock');
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(filename, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });
      return async () => {
        const current = JSON.parse(await fs.readFile(filename, 'utf8').catch(() => '{}'));
        if (current.token === token) await fs.rm(filename, { force: true });
      };
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      const current = JSON.parse(await fs.readFile(filename, 'utf8').catch(() => '{}'));
      if (!Number.isInteger(current.pid)) throw new Error('任务锁损坏，请确认没有其他任务后删除：' + filename);
      let live = true;
      try { process.kill(current.pid, 0); } catch (e: any) { live = e.code !== 'ESRCH'; }
      if (live) throw new Error('此浏览器目录已有任务运行，PID：' + current.pid);
      await fs.rm(filename, { force: true });
    }
  }
  throw new Error('无法获取任务锁');
}
