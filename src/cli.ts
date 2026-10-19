#!/usr/bin/env node
import { registerHistory } from './history/command.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import { chromium } from 'playwright';
import { dateRange, initConfig, loadConfig } from './config.js';
import { chromeAvailable, identity, LIST_URL, openBrowser, waitForLogin } from './browser.js';
import { collect, VERSION } from './runner.js';
import { Store } from './store.js';
import { exportArchive, importLegacy } from './exporter.js';
import { message, StoppedError } from './errors.js';
import { acquireLock } from './files.js';

if (Number(process.versions.node.split('.')[0]) !== 24) {
  console.error('xhs-creator-export 需要 Node.js 24 LTS；当前为 ' + process.versions.node + '。请切换 Node.js 版本后运行。');
  process.exit(1);
}

const program = new Command().name('xhs-creator-export').description('XHS Creator Export · 小红书创作者数据导出器').version(VERSION)
  .option('-c, --config <file>', 'YAML 配置路径', 'xhs-creator-export.yaml');
const log = (s: string) => console.log(new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' }) + ' ' + s);
const controller = new AbortController();
let signals = 0;
process.on('SIGINT', () => { if (++signals > 1) process.exit(130); if (program.args[0] === 'history') console.error('安全停止中；再次 Ctrl+C 强制退出'); else log('安全停止中；再次 Ctrl+C 强制退出'); controller.abort(); });
process.on('SIGTERM', () => controller.abort());
const config = () => loadConfig(program.opts().config);
program.command('init').description('创建首次配置（不覆盖已有文件）').action(async () => {
  await initConfig(program.opts().config); log('配置已生成：' + path.resolve(program.opts().config));
});
program.command('doctor').description('检查运行环境、浏览器、目录及 SQLite').option('--launch', '实际启动专用浏览器检查').action(async options => {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('请使用 Node.js 24 LTS');
  const cfg = await config();
  for (const dir of [cfg.profileDir, cfg.outputDir, path.dirname(cfg.databasePath)]) { await fs.mkdir(dir, { recursive: true }); await fs.access(dir, fs.constants.W_OK); }
  const chrome = await chromeAvailable(); const chromiumInstalled = await fs.access(chromium.executablePath()).then(() => true).catch(() => false);
  const store = new Store(cfg.databasePath, cfg.outputDir); store.close();
  if (cfg.browser === 'chrome' && !chrome || cfg.browser === 'chromium' && !chromiumInstalled || cfg.browser === 'auto' && !chrome && !chromiumInstalled)
    throw new Error('浏览器不可用：安装 Chrome，或运行 npx playwright install chromium');
  if (options.launch) { const browser = await openBrowser(cfg); await browser.close(); }
  console.log(JSON.stringify({ node: process.versions.node, chrome, chromiumInstalled, sqlite: 'ok', config: cfg, launched: Boolean(options.launch) }, null, 2));
});
program.command('login').description('首次登录或解决平台验证').action(async () => {
  const cfg = await config(); cfg.headless = false;
  const browser = await openBrowser(cfg);
  try {
    await browser.page.goto(LIST_URL, { waitUntil: 'domcontentloaded' });
    await waitForLogin(browser.page, log, controller.signal);
    log('账号已登录：' + await identity(browser.page));
  } finally { await browser.close(); }
});
program.command('collect').description('采集新批次并自动导出').option('--from <date>', '起始日期 YYYY-MM-DD').option('--to <date>', '结束日期 YYYY-MM-DD').action(async options => {
  const job = await collect(await config(), { dates: dateRange(options.from, options.to) }, controller.signal, log);
  if (job.status === 'partial') process.exitCode = 2;
});
program.command('resume').argument('<jobId>').description('校验并续采指定批次').action(async jobId => {
  const job = await collect(await config(), { jobId }, controller.signal, log); if (job.status === 'partial') process.exitCode = 2;
});
program.command('retry').argument('<jobId>').option('--note <id>', '指定笔记重新采集').description('补采失败、损坏或指定笔记').action(async (jobId, options) => {
  const job = await collect(await config(), { jobId, retryOnly: true, noteId: options.note }, controller.signal, log); if (job.status === 'partial') process.exitCode = 2;
});
program.command('status').argument('[jobId]').description('查看最近或指定任务').action(async jobId => {
  const cfg = await config(); const store = new Store(cfg.databasePath, cfg.outputDir);
  try { const job = store.get(jobId); console.log(JSON.stringify({ id: job.id, status: job.status, completed: job.completed.length,
    expected: job.notes.length, scope: job.scope, warnings: job.exportWarnings, errors: job.errors, lastError: job.lastError, updatedAt: job.updatedAt, output: store.root(job.id) }, null, 2)); }
  finally { store.close(); }
});
program.command('export').argument('[jobId]').description('重新导出任务，或转换旧 content-data.json')
  .option('--legacy <file>', '旧数据文件路径，不能用来续采').option('--out <dir>', '旧数据导出目录（默认原 JSON 所在目录）').action(async (jobId, options) => {
    if (options.legacy) {
      if (jobId) throw new Error('jobId 与 --legacy 不能同时使用');
      const filename = path.resolve(options.legacy), root = options.out ? path.resolve(options.out) : path.dirname(filename);
      if (options.out && root !== path.dirname(filename)) {
        const archive = await importLegacy(filename);
        for (const artifact of await import('./exporter.js').then(m => m.artifactList(archive))) {
          const { safePath } = await import('./files.js'); const target = safePath(root, artifact.path);
          await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(safePath(path.dirname(filename), artifact.path), target);
        }
      }
      log('已导出：' + await exportArchive(await importLegacy(filename), root, true)); return;
    }
    if (!jobId) throw new Error('请提供 jobId 或 --legacy');
    const cfg = await config(); const store = new Store(cfg.databasePath, cfg.outputDir);
    let unlock: (() => Promise<void>) | undefined;
    try { unlock = await acquireLock(cfg.profileDir); const job = store.get(jobId); await store.reconcile(job); await store.renameArtifacts(job); log('已导出：' + await exportArchive(store.archive(job), store.root(job.id))); }
    finally { try { await unlock?.(); } finally { store.close(); } }
  });
registerHistory(program, config, controller.signal);
await program.parseAsync().catch(error => { console.error(message(error)); process.exitCode = error instanceof StoppedError ? 130 : 1; });
