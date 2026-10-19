import { assignNoteNames, noteName } from './naming.js';
import { randomUUID } from 'node:crypto';
import { XhsAdapter } from './adapter.js';
import { LIST_URL, openBrowser, ResponseCollector, waitForLogin } from './browser.js';
import { checkSignal, delay, fatal, GuardError, message, NeedsLoginError, StoppedError, StructureError } from './errors.js';
import { extractNote, compactResponses } from './parser.js';
import { exportArchive } from './exporter.js';
import { verifyArtifact } from './files.js';
import { Store } from './store.js';
import type { Config, Job, Note, Snapshot } from './types.js';

export const VERSION = '0.3.0';
export function createJob(config: Config, dates?: [string, string]): Job {
  const now = new Date().toISOString();
  return { schemaVersion: 4, id: 'content-' + now.replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8),
    createdAt: now, updatedAt: now, status: 'running', requestedDates: dates, directoryComplete: false,
    notes: [], completed: [], officialFiles: [], exportWarnings: [], errors: [], programVersion: VERSION,
    config: { browser: config.browser, intervalMs: config.intervalMs, operationTimeoutMs: config.operationTimeoutMs,
      downloadTimeoutMs: config.downloadTimeoutMs, stepRetries: config.stepRetries, noteRestarts: config.noteRestarts } };
}
export async function collect(config: Config, options: { jobId?: string; dates?: [string, string]; retryOnly?: boolean; noteId?: string },
  signal: AbortSignal, log: (s: string) => void, dependencies: { openBrowser?: typeof openBrowser } = {}): Promise<Job> {
  const store = new Store(config.databasePath, config.outputDir);
  let browser: Awaited<ReturnType<typeof openBrowser>> | undefined;
  let job: Job | undefined;
  let onAbort: (() => void) | undefined;
  try {
    // Acquire the browser/profile lock before changing an existing task's state.
    browser = await (dependencies.openBrowser ?? openBrowser)(config);
    job = options.jobId ? store.get(options.jobId) : createJob(config, options.dates);
    if (options.noteId && !job.notes.some(n => n.id === options.noteId)) throw new Error('该笔记不在本批次目录中');
    await store.reconcile(job);
    await store.renameArtifacts(job);
    job.status = 'running'; delete job.lastError; delete job.finishedAt; store.save(job);
    onAbort = () => {
      job!.status = 'cancelled'; job!.lastError = '用户停止，已完成数据保留';
      try { store.save(job!); } catch (error) { log('停止状态保存失败：' + message(error)); }
    };
    signal.addEventListener('abort', onAbort, { once: true });
    const root = store.root(job.id);
    log('任务 ' + job.id + '；浏览器 ' + browser.channel);
    const responses = new ResponseCollector(browser.context);
    const adapter = new XhsAdapter(browser.page, responses, config, signal);
    const waiting = async (): Promise<boolean> => {
      const state = await import('./browser.js').then(m => m.authState(browser!.page));
      if (config.headless && (state === 'login' || state === 'verification')) throw new NeedsLoginError('无头模式需要先执行 login 完成登录／验证');
      const waited = await waitForLogin(browser!.page, log, signal, () => { job!.status = 'waiting_for_user'; store.save(job!); });
      if (waited) { job!.status = 'running'; store.save(job!); await adapter.assertIdentity(job!.identityHint); }
      return waited;
    };
    const guarded = async <T>(task: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        checkSignal(signal);
        try { return await task(); }
        catch (error) {
          if (error instanceof NeedsLoginError) { await waiting(); if (attempt >= config.stepRetries + 1) throw error; continue; }
          // An operation can time out while a login/verification overlay is visible.
          if (await import('./browser.js').then(m => m.authState(browser!.page)).catch(() => 'ready') !== 'ready') {
            await waiting(); if (attempt >= config.stepRetries + 1) throw error; continue;
          }
          if (fatal(error) || attempt >= config.stepRetries) throw error;
          log('步骤重试：' + message(error)); await delay(250 * (attempt + 1), signal);
        }
      }
    };
    await browser.page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
    await waiting();
    await guarded(() => adapter.gotoList());
    const account = await adapter.assertIdentity(job.identityHint);
    job.identityHint ??= account; store.save(job);
    const desired = job.scope?.dates ?? job.requestedDates;
    await guarded(() => adapter.setDates(desired));
    if (!job.directoryComplete) {
      const first = await guarded(() => adapter.readDirectory());
      job.scope = first.scope; store.save(job);
      const notes = new Map<string, Note>();
      for (let number = 1; number <= first.scope.pages; number++) {
        if (number > 1) await guarded(() => adapter.goPage(number));
        const current = await guarded(() => adapter.readDirectory());
        if (current.scope.total !== first.scope.total || current.scope.pages !== first.scope.pages
          || JSON.stringify(current.scope.dates) !== JSON.stringify(first.scope.dates)) throw new GuardError('目录总数或日期范围变化，任务暂停');
        await adapter.assertIdentity(job.identityHint);
        for (const note of current.notes) { if (notes.has(note.id)) throw new GuardError('分页出现重复笔记：' + note.id); notes.set(note.id, note); }
        log(`目录 ${number}/${first.scope.pages}，累计 ${notes.size}/${first.scope.total}`);
      }
      if (notes.size !== first.scope.total) throw new GuardError('笔记目录不完整');
      job.notes = [...notes.values()]; assignNoteNames(job.notes); job.directoryComplete = true; store.save(job);
    } else {
      const current = await guarded(() => adapter.readDirectory());
      if (current.scope.total !== job.scope!.total || JSON.stringify(current.scope.dates) !== JSON.stringify(job.scope!.dates)) throw new GuardError('续采目录总数或日期范围变化，保留旧批次并创建新批次');
    }
    // Always export the first page's list, after applying exactly the job's scope.
    await guarded(() => adapter.goPage(1));
    const priorList = job.officialFiles.find(a => a.path.startsWith('official/note-list.'));
    if (!priorList || !await verifyArtifact(root, priorList)) {
      try {
        const file = await guarded(() => adapter.official(root, 'note-list'));
        job.officialFiles = [...job.officialFiles.filter(a => !a.path.startsWith('official/note-list.')), file];
        job.exportWarnings = job.exportWarnings.filter(e => e.noteId !== '__list__');
      } catch (error) {
        if (fatal(error) || error instanceof NeedsLoginError) throw error;
        job.exportWarnings = [...job.exportWarnings.filter(e => e.noteId !== '__list__'), { noteId: '__list__', message: message(error) }];
        log('列表官方导出警告：' + message(error));
      }
      store.save(job);
    }
    const selected = job.notes.filter(n => options.noteId ? n.id === options.noteId : !options.retryOnly || !job!.completed.includes(n.id));
    if (options.noteId) { job.completed = job.completed.filter(id => id !== options.noteId); store.save(job); }
    const runNote = async (note: Note): Promise<boolean> => {
      for (let restart = 0; restart <= config.noteRestarts; restart++) {
        checkSignal(signal);
        try {
          log(`采集 ${job!.completed.length}/${job!.notes.length}：${note.title || note.id}`);
          await guarded(() => adapter.gotoNote(note)); await adapter.assertIdentity(job!.identityHint);
          const diagnoses = await guarded(() => adapter.diagnoses());
          await guarded(() => adapter.loadAudience());
          let officialFiles: Snapshot['officialFiles'] = [], officialExportError: string | null = null;
          try { officialFiles = [await guarded(() => adapter.official(root, noteName(note)))]; }
          catch (error) {
            if (fatal(error) || error instanceof NeedsLoginError) throw error;
            officialExportError = message(error); log('官方导出警告：' + officialExportError);
          }
          const coreViewScreenshots = [];
          for (const mode of ['按小时', '按天'] as const) {
            log('截图核心观看数：' + mode);
            coreViewScreenshots.push(await guarded(() => adapter.coreScreenshot(root, note, mode)));
          }
          const trendScreenshots = await guarded(() => adapter.trendScreenshot(root, note));
          await responses.flush(); await adapter.assertIdentity(job!.identityHint);
          const snapshot: Snapshot = { url: browser!.page.url(), capturedAt: new Date().toISOString(), identityHint: job!.identityHint!,
            responses: compactResponses(responses.records), diagnoses, officialFiles, officialExportError, coreViewScreenshots, trendScreenshots };
          const row = extractNote(snapshot, note);
          job!.exportWarnings = job!.exportWarnings.filter(e => e.noteId !== note.id);
          if (officialExportError) job!.exportWarnings.push({ noteId: note.id, message: officialExportError });
          const priorPaths = new Set(store.record(job!.id, note.id)?.snapshot.officialFiles.map(a => a.path) ?? []);
          job!.officialFiles = [...job!.officialFiles.filter(a => !priorPaths.has(a.path)), ...officialFiles];
          store.commit(job!, note.id, { row, snapshot });
          return true;
        } catch (error) {
          if (fatal(error) || error instanceof NeedsLoginError) throw error;
          job!.errors = [...job!.errors.filter(e => e.noteId !== note.id), { noteId: note.id, message: message(error) }]; store.save(job!);
          if (restart === config.noteRestarts) { log('保留失败并继续：' + note.id + ' ' + message(error)); return false; }
          log('重新打开详情：' + message(error));
        }
      }
      return false;
    };
    const failed: Note[] = [];
    for (const note of selected) {
      if (job.completed.includes(note.id)) continue;
      if (!await runNote(note)) failed.push(note);
      await delay(config.intervalMs, signal);
    }
    for (const note of failed) { log('批次末尾补采：' + note.id); await runNote(note); await delay(config.intervalMs, signal); }
    // Confirm the account/scope/count again before claiming a complete batch.
    if (job.completed.length === job.notes.length) {
      await guarded(() => adapter.gotoList());
      await guarded(() => adapter.setDates(job!.scope!.dates));
      const finalDirectory = await guarded(() => adapter.readDirectory());
      await adapter.assertIdentity(job.identityHint);
      if (finalDirectory.scope.total !== job.scope!.total || JSON.stringify(finalDirectory.scope.dates) !== JSON.stringify(job.scope!.dates))
        throw new GuardError('采集结束时目录总数或日期发生变化，保留部分批次，请创建新批次');
    }
    job.status = job.completed.length !== job.notes.length ? 'partial' : job.exportWarnings.length ? 'complete_with_warnings' : 'complete';
    job.finishedAt = new Date().toISOString(); store.save(job);
    await exportArchive(store.archive(job), root);
    checkSignal(signal);
    log(`结果：${job.status}，${job.completed.length}/${job.notes.length}；${root}`);
    return job;
  } catch (error) {
    if (job) {
      job.status = error instanceof StoppedError ? 'cancelled' : error instanceof NeedsLoginError ? 'waiting_for_user' : 'partial';
      job.lastError = message(error); store.save(job);
      // Preserve a readable partial report as well as the authoritative SQLite progress.
      if (job.completed.length) await exportArchive(store.archive(job), store.root(job.id)).catch(e => log('部分导出失败：' + message(e)));
      log('任务保留：' + job.id + '；' + message(error));
    }
    throw error;
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    try { await browser?.close(); } finally { store.close(); }
  }
}
