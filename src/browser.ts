import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium, type BrowserContext, type Page, type Request } from 'playwright';
import { acquireLock } from './files.js';
import { checkSignal, delay, NeedsLoginError, GuardError } from './errors.js';
import { redact, localTime } from './parser.js';
import type { Config, ResponseRecord } from './types.js';

export const ORIGIN = 'https://creator.xiaohongshu.com';
export const LIST_URL = ORIGIN + '/statistics/data-analysis';
export function validDetailUrl(value: string, origin = ORIGIN): boolean {
  try { const u = new URL(value); return u.origin === origin && u.pathname === '/statistics/note-detail' && /^[a-zA-Z0-9_-]+$/.test(u.searchParams.get('noteId') || ''); }
  catch { return false; }
}
export async function chromeAvailable(): Promise<boolean> {
  const candidates = process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32' ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean).map(p => path.join(p!, 'Google/Chrome/Application/chrome.exe'))
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  return (await Promise.all(candidates.map(p => fs.access(p).then(() => true).catch(() => false)))).some(Boolean);
}
export async function openBrowser(config: Config): Promise<{ context: BrowserContext; page: Page; close: () => Promise<void>; channel: string }> {
  const unlock = await acquireLock(config.profileDir);
  try {
    const useChrome = config.browser === 'chrome' || config.browser === 'auto' && await chromeAvailable();
    const context = await chromium.launchPersistentContext(config.profileDir, {
      channel: useChrome ? 'chrome' : undefined, headless: config.headless,
      acceptDownloads: true, viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      args: ['--disable-extensions'], locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    });
    context.setDefaultTimeout(config.operationTimeoutMs);
    context.setDefaultNavigationTimeout(config.operationTimeoutMs);
    const page = context.pages()[0] ?? await context.newPage();
    for (const extra of context.pages().slice(1)) await extra.close();
    return { context, page, channel: useChrome ? 'chrome' : 'chromium', close: async () => { try { await context.close(); } finally { await unlock(); } } };
  } catch (error) { await unlock(); throw error; }
}
export class ResponseCollector {
  records: ResponseRecord[] = [];
  private generation = 0;
  private noteId?: string;
  private requests = new WeakMap<Request, { generation: number; noteId?: string }>();
  private pending = new Set<Promise<void>>();
  private active = new Map<Request, number>();
  private lastActivity = Date.now();
  private failures: string[] = [];
  private expectedList?: { dates: [string, string]; page: number };
  private conflict?: GuardError;
  constructor(context: BrowserContext, readonly origin = ORIGIN) {
    context.on('request', request => {
      if (!this.eligible(request.url())) return;
      this.requests.set(request, { generation: this.generation, noteId: this.noteId });
      this.active.set(request, this.generation); this.lastActivity = Date.now();
    });
    const finished = (request: Request) => {
      if (this.active.get(request) === this.generation) this.lastActivity = Date.now();
      this.active.delete(request);
    };
    context.on('requestfinished', finished); context.on('requestfailed', finished);
    context.on('response', response => {
      const owner = this.requests.get(response.request());
      if (!owner || owner.generation !== this.generation) return;
      const task = (async () => {
        try {
          const data = await response.json();
          if (owner.generation !== this.generation) return;
          const u = new URL(response.url());
          const queryId = u.searchParams.get('noteId') || u.searchParams.get('note_id');
          let bodyId: string | undefined;
          try { const body = response.request().postDataJSON(); bodyId = body?.note_id || body?.noteId; } catch { /* not a JSON body */ }
          const responseId = data?.data?.note_info?.id;
          if (owner.noteId && [queryId, bodyId].some(id => id && id !== owner.noteId)) return;
          if (owner.noteId && responseId && responseId !== owner.noteId) {
            this.conflict = new GuardError('详情响应笔记 ID 不一致'); return;
          }
          if (this.records.length >= 1200) { this.failures.push('响应数量超过上限'); return; }
          let filters: ResponseRecord['filters'];
          if (u.pathname.endsWith('/note/analyze/list')) {
            filters = { from: localTime(Number(u.searchParams.get('post_begin_time'))) ?? undefined,
              to: localTime(Number(u.searchParams.get('post_end_time'))) ?? undefined,
              page: Number(u.searchParams.get('page_num')), size: Number(u.searchParams.get('page_size')), type: u.searchParams.get('type') ?? undefined };
            if (!u.searchParams.has('post_begin_time')) delete filters.from;
            if (!u.searchParams.has('post_end_time')) delete filters.to;
            filters.from = filters.from?.slice(0, 10); filters.to = filters.to?.slice(0, 10);
          }
          this.records.push({ endpoint: u.origin + u.pathname, status: response.status(), capturedAt: new Date().toISOString(), noteId: owner.noteId, data: redact(data), filters });
          this.lastActivity = Date.now();
        } catch { if (owner.generation === this.generation) this.failures.push('相关响应不是有效 JSON'); }
      })();
      this.pending.add(task); void task.finally(() => this.pending.delete(task));
    });
  }
  private eligible(value: string): boolean {
    try {
      const u = new URL(value); const host = new URL(this.origin).hostname;
      return (u.hostname === host || this.origin === ORIGIN && /(^|\.)xiaohongshu\.com$/.test(u.hostname))
        && /\/note\/(?:base|analyze\/list|audience\/source(?:\/detail)?)$/.test(u.pathname);
    } catch { return false; }
  }
  begin(noteId?: string): void { this.generation++; this.noteId = noteId; this.records = []; this.failures = []; this.expectedList = undefined; this.conflict = undefined; }
  expectList(dates: [string, string], page: number): void { this.expectedList = { dates, page }; }
  async flush(): Promise<void> { await Promise.all([...this.pending]); if (this.conflict) throw this.conflict; if (this.failures.includes('响应数量超过上限')) throw new Error('响应采集溢出'); }
  async settle(timeout: number, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (![...this.active.values()].includes(this.generation) && !this.pending.size && Date.now() - this.lastActivity >= 300) return;
      await delay(100, signal);
    }
    throw new Error('相关数据请求未完成');
  }
  get(suffix: string): any {
    if (this.conflict) throw this.conflict;
    return [...this.records].reverse().find(r => r.endpoint.endsWith(suffix) && r.status >= 200 && r.status < 300 && r.data?.success === true
      && (suffix !== '/note/analyze/list' || !this.expectedList || r.filters?.from === this.expectedList.dates[0]
        && r.filters?.to === this.expectedList.dates[1] && r.filters?.page === this.expectedList.page && r.filters?.type === '0'))?.data?.data;
  }
  currentListPage(): number | undefined {
    const data = this.get('/note/analyze/list');
    return [...this.records].reverse().find(r => r.data?.data === data)?.filters?.page;
  }
  currentListSize(): number | undefined {
    const data = this.get('/note/analyze/list');
    return [...this.records].reverse().find(r => r.data?.data === data)?.filters?.size;
  }
  async wait(suffix: string, timeout: number, signal?: AbortSignal): Promise<any> {
    const deadline = Date.now() + timeout;
    do {
      checkSignal(signal);
      const data = this.get(suffix); if (data != null) return data;
      await delay(100, signal);
    } while (Date.now() < deadline);
    throw new Error('相关数据未就绪：' + suffix + (this.failures.length ? '；' + this.failures.at(-1) : ''));
  }
}
export async function authState(page: Page): Promise<'login' | 'verification' | 'loading' | 'ready'> {
  if (page.isClosed()) throw new GuardError('浏览器页面已关闭');
  const text = await page.locator('body').innerText({ timeout: 5000 });
  if (/扫码登录|手机号登录|登录后查看|请先登录/.test(text) || /\/(?:login|signin)(?:[/?#]|$)/.test(page.url())) return 'login';
  if (/请完成(?:安全)?验证|拖动滑块|滑动验证|点击完成验证|安全验证|验证码登录/.test(text)
    || await page.locator('[class*="captcha"], [id*="captcha"], iframe[src*="captcha"]').filter({ visible: true }).count()) return 'verification';
  return text.includes('发布笔记') ? 'ready' : 'loading';
}
export async function identity(page: Page): Promise<string> {
  const text = await page.locator('body').innerText();
  const prefix = text.split('发布笔记')[0].trim();
  if (!text.includes('发布笔记') || prefix.length < 1 || prefix.length > 400) throw new GuardError('无法可靠识别账号，请确认已登录创作平台');
  return prefix.replace(/\s+/g, ' ');
}
export async function waitForLogin(page: Page, log: (s: string) => void, signal?: AbortSignal, onWait?: () => void): Promise<boolean> {
  let waited = false;
  let loadingSince = Date.now();
  let previous = '';
  for (;;) {
    checkSignal(signal);
    const state = await authState(page);
    if (state === 'ready') return waited;
    if (state === 'loading') {
      if (Date.now() - loadingSince > 30000) throw new GuardError('创作平台未加载或页面结构无法识别，请检查网络');
    } else {
      loadingSince = Date.now();
      if (!waited) { waited = true; onWait?.(); }
      if (previous !== state) log(state === 'verification' ? '等待平台验证：请在专用浏览器完成验证，完成后自动继续。' : '等待首次登录／登录续期：请在专用浏览器扫码登录，完成后自动继续。');
    }
    previous = state;
    await delay(state === 'loading' ? 150 : 1000, signal);
  }
}
export async function assertAuthenticated(page: Page): Promise<void> {
  const state = await authState(page);
  if (state === 'login' || state === 'verification') throw new NeedsLoginError('需要登录或平台验证');
}
