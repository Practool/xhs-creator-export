import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { checkId, HistoryError, noSymlinks, readJson, sha } from './safety.js';
import type { Source } from './types.js';

const schema = z.object({
  schemaVersion: z.literal(4).optional(),
  job: z.object({ schemaVersion:z.literal(4).optional(), errors:z.array(z.object({noteId:z.string(),message:z.string()}).passthrough()).optional(), id: z.string(), notes: z.array(z.object({ id: z.string() }).passthrough()).max(100000),
    completed: z.array(z.string()).max(100000), status: z.enum(['running', 'waiting_for_user', 'partial', 'complete_with_warnings', 'complete', 'cancelled']),
    identityHint: z.string().max(1000).optional() }).passthrough(),
  records: z.array(z.object({ row: z.record(z.string(), z.unknown()), snapshot: z.object({capturedAt:z.string().optional(),identityHint:z.string().max(1000).optional(),responses:z.array(z.object({endpoint:z.string(),data:z.unknown()}).passthrough()).max(1200).optional(),officialFiles:z.array(z.object({path:z.string()}).passthrough()).optional(),coreViewScreenshots:z.array(z.object({path:z.string()}).passthrough()).optional(),trendScreenshots:z.array(z.object({path:z.string()}).passthrough()).optional()}).passthrough() }).passthrough()).max(100000),
}).passthrough();
export async function discover(outputDir: string, job?: string): Promise<string[]> {
  await noSymlinks(outputDir);
  if (job) return [checkId(job)];
  const entries = await fs.readdir(outputDir, { withFileTypes: true });
  return entries.filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => e.name).filter(n => /^[a-zA-Z0-9_-]{1,150}$/.test(n)).sort();
}
export async function readSource(outputDir: string, jobId: string): Promise<Source> {
  checkId(jobId);
  const root = path.join(outputDir, jobId);
  const input = await readJson(path.join(root, 'content-data.json'));
  const parsed = schema.safeParse(input.value);
  if (!parsed.success || parsed.data.job.id !== jobId) throw new HistoryError('INVALID_SCHEMA', '仅支持与目录 ID 一致的 schemaVersion 4 Job（或缺少版本的同形旧文件）。');
  const archive = parsed.data;
  const ids = archive.job.notes.map(n => checkId(n.id));
  if (new Set(ids).size !== ids.length || new Set(archive.job.completed).size !== archive.job.completed.length
    || archive.job.completed.some(id => !ids.includes(id))) throw new HistoryError('INVALID_SCHEMA', '目录或完成清单重复、或引用了不存在的笔记。');
  const reportPath = path.join(root, 'validation.json');
  let validation: any = null, reportBytes: Buffer = Buffer.alloc(0);
  try {
    const report = await readJson(reportPath, 4 * 1024 * 1024); validation = report.value; reportBytes = report.bytes;
    if (!z.object({jobId:z.literal(jobId),schemaVersion:z.literal(4).optional(),complete:z.boolean().optional(),rows:z.number().int().nonnegative().optional(),invalidArtifacts:z.array(z.string()).optional()}).passthrough().safeParse(validation).success) throw new HistoryError('INVALID_SCHEMA', '完整性报告与 Job ID / Schema 不一致。');
  } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
  return { jobId, root, archive, validation, fingerprint: sha(Buffer.concat([input.bytes, Buffer.from('\n--validation--\n'), reportBytes])) };
}
