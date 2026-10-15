import { assignNoteNames, noteName } from './naming.js';
import { extractNote } from './parser.js';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { safeId, safePath, verifyArtifact } from './files.js';
import { StorageError } from './errors.js';
import type { Archive, Job, NoteRecord } from './types.js';

export class Store {
  private db: Database.Database;
  constructor(filename: string, readonly outputDir: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS notes (job_id TEXT NOT NULL, note_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(job_id,note_id));');
  }
  root(id: string): string { return safePath(this.outputDir, safeId(id)); }
  save(job: Job): void {
    job.updatedAt = new Date().toISOString();
    try {
      this.db.prepare('INSERT INTO jobs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at,body=excluded.body')
        .run(job.id, job.updatedAt, JSON.stringify(job));
    } catch (e) { throw new StorageError('保存任务失败：' + String(e)); }
  }
  get(id?: string): Job {
    if (id) safeId(id);
    const row = (id ? this.db.prepare('SELECT body FROM jobs WHERE id=?').get(id)
      : this.db.prepare('SELECT body FROM jobs ORDER BY updated_at DESC LIMIT 1').get()) as { body: string } | undefined;
    if (!row) throw new Error('任务不存在：' + (id ?? '最近任务'));
    return JSON.parse(row.body);
  }
  record(jobId: string, noteId: string): NoteRecord | undefined {
    const row = this.db.prepare('SELECT body FROM notes WHERE job_id=? AND note_id=?').get(jobId, noteId) as { body: string } | undefined;
    return row ? JSON.parse(row.body) : undefined;
  }
  commit(job: Job, noteId: string, record: NoteRecord): void {
    if (record.row['笔记ID'] !== noteId) throw new Error('提交笔记 ID 不一致');
    const previous = JSON.stringify(job);
    try {
      this.db.transaction(() => {
        this.db.prepare('INSERT INTO notes VALUES(?,?,?) ON CONFLICT(job_id,note_id) DO UPDATE SET body=excluded.body')
          .run(job.id, noteId, JSON.stringify(record));
        job.completed = [...new Set([...job.completed, noteId])];
        job.errors = job.errors.filter(e => e.noteId !== noteId);
        this.save(job);
      })();
    } catch (error) { Object.assign(job, JSON.parse(previous)); throw new StorageError('笔记提交失败：' + String(error)); }
  }
  archive(job: Job): Archive {
    const completed = new Set(job.completed);
    if (completed.size !== job.completed.length || job.completed.some(id => !job.notes.some(n => n.id === id))) throw new Error('完成清单不属于笔记目录或存在重复');
    return { schemaVersion: 4, job, records: job.notes.filter(n => completed.has(n.id)).map(({ id }) => {
      const record = this.record(job.id, id);
      if (!record) throw new Error('已完成笔记记录缺失：' + id);
      return record;
    }) };
  }
  async reconcile(job: Job): Promise<string[]> {
    const invalid: string[] = [];
    for (const id of job.completed) {
      const record = this.record(job.id, id);
      const artifacts = record ? [...record.snapshot.officialFiles, ...record.snapshot.coreViewScreenshots, ...record.snapshot.trendScreenshots] : [];
      const requiredViews = record && ['按小时', '按天'].every(mode => record.snapshot.coreViewScreenshots.filter(a => a.mode === mode && a.complete).length === 1);
      const validRecord = record?.row['笔记ID'] === id && requiredViews
        && (record.row['内容类型'] === '图文' || record.row['内容类型'] === '视频' && record.snapshot.trendScreenshots.length > 0);
      if (!validRecord || !await Promise.all(artifacts.map(a => verifyArtifact(this.root(job.id), a))).then(r => r.every(Boolean))) invalid.push(id);
    }
    job.completed = job.completed.filter(id => !invalid.includes(id));
    if (invalid.length) { job.status = 'partial'; this.save(job); }
    return invalid;
  }
  async renameArtifacts(job: Job): Promise<void> {
    const updated = structuredClone(job);
    const records = updated.notes.map(note => ({ note, record: this.record(job.id, note.id) }));
    for (const { note, record } of records) {
      if (!note.listData?.post_time && record) {
        const base = record.snapshot.responses.find(r => r.endpoint.endsWith('/note/base'))?.data?.data?.note_info;
        if (base?.post_time != null) note.listData = { ...note.listData, post_time: base.post_time };
        note.title ||= String(record.row['标题'] || base?.desc || '');
      }
    }
    assignNoteNames(updated.notes);
    const changes = new Map<string, string>();
    const root = this.root(job.id);
    for (const { note, record } of records) {
      if (!record) continue;
      const name = noteName(note);
      for (const a of [...record.snapshot.officialFiles, ...record.snapshot.coreViewScreenshots, ...record.snapshot.trendScreenshots]) {
        const target = a.kind === 'official' ? `official/${name}${path.extname(a.path)}`
          : a.path.startsWith('core-view-trends/') ? `core-view-trends/${a.mode === '按小时' ? 'hour' : 'day'}/${name}/full.png`
          : `trends/${name}/full.png`;
        if (a.path === target || !await verifyArtifact(root, a)) continue;
        // Copy before the database transaction: interruption leaves the old references valid.
        const data = await fs.promises.readFile(safePath(root, a.path));
        await import('./files.js').then(m => m.atomicWrite(safePath(root, target), data));
        changes.set(a.path, target); a.path = target;
      }
      record.row = extractNote(record.snapshot, note);
    }
    for (const a of updated.officialFiles) a.path = changes.get(a.path) ?? a.path;
    this.db.transaction(() => {
      for (const { note, record } of records) if (record) this.db.prepare('UPDATE notes SET body=? WHERE job_id=? AND note_id=?').run(JSON.stringify(record), job.id, note.id);
      this.save(updated);
    })();
    Object.assign(job, updated);
    for (const old of changes.keys()) {
      await fs.promises.rm(safePath(root, old), { force: true });
      if (old.endsWith('/full.png')) await fs.promises.rmdir(path.dirname(safePath(root, old))).catch(() => {});
    }
  }
  close(): void { this.db.close(); }
}
