import { noteName, safeFilename } from './naming.js';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import sharp from 'sharp';
import { ORIGIN, LIST_URL, assertAuthenticated, identity, ResponseCollector, validDetailUrl } from './browser.js';
import { checkSignal, delay, GuardError, StructureError, retry } from './errors.js';
import { saveArtifact, safeId } from './files.js';
import { diagnosisLabels } from './parser.js';
import { validateOfficialFile } from './exporter.js';
import { saveDownload } from './download.js';
import type { Artifact, Config, Note, Scope } from './types.js';

const DATE_INPUT = 'input';
export class XhsAdapter {
  constructor(readonly page: Page, readonly responses: ResponseCollector, readonly config: Config,
    readonly signal?: AbortSignal, readonly origin = ORIGIN) {}
  private async visible(locator: Locator): Promise<Locator[]> {
    const all = await locator.all(); const result: Locator[] = [];
    for (const item of all) if (await item.isVisible()) result.push(item);
    return result;
  }
  private async exact(label: string, scope: Locator = this.page.locator('body')): Promise<Locator> {
    const candidates = await this.visible(scope.getByText(label, { exact: true }));
    if (!candidates.length) throw new StructureError('找不到页面控件：' + label);
    if (candidates.length !== 1) throw new StructureError('页面控件不唯一：' + label + '；请维护站点适配规则');
    return candidates[0];
  }
  async ready(marker: string): Promise<void> {
    await assertAuthenticated(this.page);
    const deadline = Date.now() + this.config.operationTimeoutMs;
    do {
      checkSignal(this.signal); await assertAuthenticated(this.page);
      if (await this.page.getByText(marker, { exact: true }).first().isVisible().catch(() => false)
        && !await this.page.locator('[aria-busy="true"], .d-loading, .ant-spin-spinning').filter({ visible: true }).count()) return;
      await delay(150, this.signal);
    } while (Date.now() < deadline);
    throw new Error('页面未就绪：' + marker);
  }
  async gotoList(): Promise<void> {
    this.responses.begin();
    await this.page.goto(this.origin + new URL(LIST_URL).pathname, { waitUntil: 'domcontentloaded' });
    await this.ready('笔记数据');
    await this.responses.wait('/note/analyze/list', this.config.operationTimeoutMs, this.signal);
  }
  async gotoNote(note: Note): Promise<void> {
    if (!validDetailUrl(note.url, this.origin)) throw new GuardError('非法详情地址');
    this.responses.begin(note.id);
    await this.page.goto(note.url, { waitUntil: 'domcontentloaded' });
    await this.ready('核心数据');
    const base = await this.responses.wait('/note/base', this.config.operationTimeoutMs, this.signal);
    if (base.note_info?.id !== note.id) throw new GuardError('详情笔记 ID 不一致');
  }
  async assertIdentity(expected?: string): Promise<string> {
    await assertAuthenticated(this.page);
    const current = await identity(this.page);
    if (expected && current !== expected) throw new GuardError('账号发生变化，任务暂停');
    return current;
  }
  async dates(): Promise<[string, string]> {
    const values = await this.page.locator(DATE_INPUT).evaluateAll(inputs => inputs.filter(el => (el as HTMLElement).getClientRects().length)
      .map(el => (el as HTMLInputElement).value).filter(v => /^\d{4}-\d{2}-\d{2}$/.test(v)));
    if (values.length !== 2) throw new StructureError('日期控件结构变化：需要两个日期输入框');
    return [values[0], values[1]];
  }
  private async dateInputs(): Promise<Locator[]> {
    const inputs = await this.visible(this.page.locator(DATE_INPUT));
    const result: Locator[] = [];
    for (const input of inputs) if (/^\d{4}-\d{2}-\d{2}$/.test(await input.inputValue())) result.push(input);
    if (result.length !== 2) throw new StructureError('无法定位日期输入框');
    return result;
  }
  private async calendarCells(): Promise<{ date: string; disabled: boolean; selector: string; inMonth: boolean }[]> {
    return this.page.evaluate(() => {
      const result: { date: string; disabled: boolean; selector: string; inMonth: boolean }[] = [];
      // Observed creator-platform calendar: Monday-first 6-week grid, no date attributes.
      for (const calendar of document.querySelectorAll('.d-datepicker-calendar')) {
        if (!(calendar instanceof HTMLElement) || !calendar.getClientRects().length) continue;
        const header = calendar.querySelector('.d-datepicker-header-main')?.textContent?.match(/(\d{4})年\s*(\d{1,2})月/);
        if (!header) continue;
        const year = Number(header[1]), month = Number(header[2]) - 1;
        const offset = (new Date(Date.UTC(year, month, 1)).getUTCDay() + 6) % 7;
        const cells = [...calendar.querySelectorAll('.d-datepicker-cell')];
        if (cells.length !== 42 && cells.length !== 35) continue;
        for (let index = 0; index < cells.length; index++) {
          const cell = cells[index]; const date = new Date(Date.UTC(year, month, 1 - offset + index));
          if (Number(cell.textContent?.trim()) !== date.getUTCDate()) throw new Error('日历网格顺序变化');
          const id = 'date-' + result.length; cell.setAttribute('data-xhs-date', id);
          result.push({ date: date.toISOString().slice(0, 10), disabled: /(?:^|\s)disabled(?:\s|$)/.test(cell.className),
            inMonth: date.getUTCMonth() === month, selector: '[data-xhs-date="' + id + '"]' });
        }
      }
      if (result.length) return result;
      for (const el of document.querySelectorAll('[title], [aria-label], [data-date]')) {
        if (!(el instanceof HTMLElement) || !el.getClientRects().length) continue;
        const label = el.getAttribute('data-date') || el.getAttribute('title') || el.getAttribute('aria-label') || '';
        const match = label.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?$/);
        if (!match) continue;
        const date = match[1] + '-' + match[2].padStart(2, '0') + '-' + match[3].padStart(2, '0');
        const ancestry = [el, el.parentElement, el.parentElement?.parentElement].filter(Boolean) as HTMLElement[];
        const disabled = ancestry.some(n => n.getAttribute('aria-disabled') === 'true' || n.hasAttribute('disabled') || /disabled|unavailable/.test(n.className));
        const id = 'date-' + result.length; el.setAttribute('data-xhs-date', id);
        result.push({ date, disabled, inMonth: !/other-month|prev-month|next-month/.test(el.className), selector: '[data-xhs-date="' + id + '"]' });
      }
      return result;
    });
  }
  private async calendarPrev(): Promise<Locator | undefined> {
    const calendar = (await this.visible(this.page.locator('.d-datepicker-calendar')))[0];
    if (calendar) return calendar.locator('.d-datepicker-header > div').nth(1).locator('.d-icon');
    const selectors = '[aria-label="上个月"], [aria-label="Previous month"], [title="上个月"], [title="Previous month"], .d-date-picker-header-prev-btn, .d-datepicker-prev-month, .ant-picker-header-prev-btn, .el-date-picker__prev-btn.prev-month, .el-picker-panel__icon-btn.arrow-left';
    return (await this.visible(this.page.locator(selectors)))[0];
  }
  private async platformBounds(): Promise<[string, string]> {
    const inputs = await this.dateInputs();
    const min = await inputs[0].getAttribute('min'), max = await inputs[1].getAttribute('max');
    if (min && max && /^\d{4}-\d{2}-\d{2}$/.test(min) && /^\d{4}-\d{2}-\d{2}$/.test(max)) return [min, max];
    const prior = await this.dates();
    await inputs[1].click();
    let cells = await this.calendarCells();
    if (!cells.length) { await this.page.keyboard.press('Escape'); throw new StructureError('无法从平台日期控件发现允许范围；请使用 --from/--to，或更新日历适配'); }
    // The currently opened end calendar must expose a boundary, not just arbitrary month cells.
    const enabled = cells.filter(c => !c.disabled && c.inMonth).map(c => c.date).sort();
    const latest = enabled.at(-1);
    if (!latest || !cells.some(c => c.inMonth && c.disabled && c.date > latest)) {
      await this.page.keyboard.press('Escape');
      throw new StructureError('平台结束日期边界不可确认，请显式指定 --from/--to');
    }
    await this.page.keyboard.press('Escape'); await inputs[0].click();
    let earliest: string | undefined;
    for (let month = 0; month < 240; month++) {
      cells = await this.calendarCells();
      const available = cells.filter(c => !c.disabled && c.inMonth).map(c => c.date).sort();
      if (available.length) earliest = available[0];
      const boundary = earliest;
      if (boundary && cells.some(c => c.inMonth && c.disabled && c.date < boundary)) { await this.page.keyboard.press('Escape'); return [boundary, latest]; }
      const previous = await this.calendarPrev();
      if (!previous || !await previous.isEnabled() || await previous.getAttribute('aria-disabled') === 'true'
        || /disabled/.test(await previous.getAttribute('class') || '')) {
        await this.page.keyboard.press('Escape');
        if (earliest) return [earliest, latest];
        break;
      }
      const before = cells.map(c => c.date).join(',');
      await previous.click(); await delay(100, this.signal);
      const after = (await this.calendarCells()).map(c => c.date).join(',');
      if (before === after) throw new StructureError('日历翻月未变化');
    }
    await this.page.keyboard.press('Escape');
    if (JSON.stringify(prior) !== JSON.stringify(await this.dates())) throw new GuardError('发现日期范围时筛选意外变化');
    throw new StructureError('无法确认平台最早日期，请显式指定 --from/--to');
  }
  private async setDate(index: number, value: string): Promise<void> {
    const input = (await this.dateInputs())[index];
    if (await input.inputValue() === value) return;
    if (!await input.getAttribute('readonly')) {
      await input.fill(value); await input.press('Enter'); await input.blur();
    } else {
      await input.click();
      for (let attempt = 0; attempt < 240; attempt++) {
        const cells = await this.calendarCells();
        const target = cells.find(c => c.date === value && !c.disabled);
        if (target) { await this.page.locator(target.selector).click(); break; }
        if (!cells.length) throw new StructureError('未识别日历日期单元格');
        const needPrev = value < cells.map(c => c.date).sort()[0];
        const next = (await this.visible(this.page.locator('[aria-label="下个月"], [aria-label="Next month"], [title="下个月"], .d-date-picker-header-next-btn, .ant-picker-header-next-btn, .el-date-picker__next-btn.next-month')))[0];
        const button = needPrev ? await this.calendarPrev() : next;
        if (!button || !await button.isEnabled()) throw new GuardError('平台不接受指定日期：' + value);
        await button.click(); await delay(100, this.signal);
      }
    }
    if (await input.inputValue() !== value) throw new GuardError('平台不接受指定日期：' + value);
    // Finish the intermediate range request before applying the other endpoint.
    await delay(300, this.signal);
    await this.responses.settle(this.config.operationTimeoutMs, this.signal);
  }
  async setDates(requested?: [string, string]): Promise<[string, string]> {
    const target = requested ?? await this.platformBounds();
    const prior = await this.dates();
    // Set end first when moving the entire interval later, otherwise start first.
    const order = target[0] > prior[1] ? [1, 0] : [0, 1];
    for (const index of order) await this.setDate(index, target[index]);
    const query = (await this.visible(this.page.getByRole('button', { name: /^(查询|筛选|搜索)$/ })))[0];
    if (query) await query.click();
    await this.page.keyboard.press('Escape');
    if (JSON.stringify(await this.dates()) !== JSON.stringify(target)) throw new GuardError('实际生效日期不一致');
    // Reload the selected page to discard old responses and obtain a fresh confirmed directory.
    this.responses.begin(); this.responses.expectList(target, 1);
    await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this.ready('笔记数据');
    await this.responses.settle(this.config.operationTimeoutMs, this.signal);
    if (JSON.stringify(await this.dates()) !== JSON.stringify(target)) {
      // Some SPAs do not persist filters across reload; reapply without reloading again.
      this.responses.begin(); this.responses.expectList(target, 1);
      for (const index of order) await this.setDate(index, target[index]);
      const button = (await this.visible(this.page.getByRole('button', { name: /^(查询|筛选|搜索)$/ })))[0];
      if (button) await button.click();
      await this.page.keyboard.press('Escape');
    }
    await this.responses.wait('/note/analyze/list', this.config.operationTimeoutMs, this.signal);
    if (JSON.stringify(await this.dates()) !== JSON.stringify(target)) throw new GuardError('日期筛选未生效');
    await this.goPage(1);
    return target;
  }
  async readDirectory(): Promise<{ notes: Note[]; scope: Scope; identityHint: string }> {
    await assertAuthenticated(this.page);
    await this.responses.settle(this.config.operationTimeoutMs, this.signal);
    const data = await this.responses.wait('/note/analyze/list', this.config.operationTimeoutMs, this.signal);
    if (!Array.isArray(data.note_infos)) throw new StructureError('笔记列表响应结构变化');
    // A response event can precede the Vue render; wait for the exact directory projection.
    const deadline = Date.now() + this.config.operationTimeoutMs;
    for (;;) {
      const rowTexts = await this.page.locator('tr, [role="row"]').filter({ hasText: '分析详情' }).allInnerTexts();
      const body = await this.page.locator('body').innerText();
      const match = body.match(/共\s*([\d,]+)\s*条/);
      if (rowTexts.length === data.note_infos.length && rowTexts.every((text, index) => !data.note_infos[index].title || text.includes(data.note_infos[index].title))
        && match && Number(match[1].replaceAll(',', '')) === data.total) break;
      if (Date.now() > deadline) throw new Error('列表 DOM 与实际筛选响应未对齐');
      await delay(100, this.signal);
    }
    const text = await this.page.locator('body').innerText();
    const total = text.match(/共\s*([\d,]+)\s*条(?:[,，\s]*([\d,]+)\s*页)?/);
    if (!total) throw new StructureError('无法核对平台列表总数');
    const count = Number(total[1].replaceAll(',', ''));
    const rows = this.page.locator('tr, [role="row"]').filter({ hasText: '分析详情' });
    const visibleRows = await this.visible(rows);
    if (count && (!data.note_infos.length || visibleRows.length !== data.note_infos.length)) throw new Error('页面列表与响应未对齐');
    const notes: Note[] = [];
    for (let i = 0; i < data.note_infos.length; i++) {
      const info = data.note_infos[i]; const id = safeId(String(info.id || ''));
      const postDate = new Date(info.post_time).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const selectedDates = await this.dates();
      if (!Number.isFinite(info.post_time) || postDate < selectedDates[0] || postDate > selectedDates[1]) throw new GuardError('列表返回范围外笔记，筛选未生效：' + id);
      const rowText = await visibleRows[i].innerText();
      if (info.title && !rowText.includes(info.title)) throw new Error('列表行与响应顺序尚未对齐');
      const links = visibleRows[i].getByText('分析详情', { exact: true });
      const href = await links.first().getAttribute('href');
      const url = href ? new URL(href, this.origin).href : this.origin + '/statistics/note-detail?noteId=' + encodeURIComponent(id);
      if (!validDetailUrl(url, this.origin) || new URL(url).searchParams.get('noteId') !== id) throw new GuardError('目录详情地址与 ID 不一致');
      notes.push({ id, url, title: info.title, listData: info, listText: rowText });
    }
    const size = Number(data.page_size || data.pageSize || this.responses.currentListSize());
    if (!total[2] && (!Number.isInteger(size) || size <= 0)) throw new StructureError('无法可靠核对总页数');
    const pages = total[2] ? Number(total[2].replaceAll(',', '')) : Math.max(1, Math.ceil(count / size));
    return { notes, scope: { dates: await this.dates(), total: count, pages, restriction: '仅平台实际允许的笔记范围' }, identityHint: await identity(this.page) };
  }
  async goPage(number: number): Promise<void> {
    const active = this.page.locator('.d-pagination-page-active, .d-pagination-page[class~="--color-bg-primary-light"], .ant-pagination-item-active, [aria-current="page"], .el-pager .is-active');
    const pageText = async () => {
      if (!await active.count()) return '';
      const content = active.first().locator('.d-pagination-page-content');
      return await content.count() ? content.innerText() : active.first().innerText().catch(() => '');
    };
    const current = await pageText();
    if (current.trim() === String(number)) return;
    if (!current && this.responses.currentListPage() === number) return;
    const prior = JSON.stringify(this.responses.get('/note/analyze/list')?.note_infos?.map((n: any) => n.id));
    const dButton = this.page.locator('.d-pagination-page').filter({ has: this.page.locator('.d-pagination-page-content').filter({ hasText: new RegExp('^' + number + '$') }) });
    const button = await dButton.count() ? dButton : this.page.locator('.ant-pagination-item, .el-pager li').filter({ hasText: new RegExp('^\\s*' + number + '\\s*$') });
    const buttons = await this.visible(button);
    const dates = await this.dates();
    this.responses.begin(); this.responses.expectList(dates, number);
    if (buttons.length === 1) await buttons[0].click();
    else {
      const input = this.page.locator('.d-pagination-goto input, .ant-pagination-options-quick-jumper input, .el-pagination__jump input');
      if (!await input.isVisible()) {
        if (number === 1 && !current && prior === '[]') return;
        throw new StructureError('找不到分页控件：' + number);
      }
      await input.fill(String(number)); await input.press('Enter');
    }
    const data = await this.responses.wait('/note/analyze/list', this.config.operationTimeoutMs, this.signal);
    if (JSON.stringify(data.note_infos?.map((n: any) => n.id)) === prior) throw new GuardError('分页后笔记列表未变化');
    const deadline = Date.now() + this.config.operationTimeoutMs;
    while (Date.now() < deadline) {
      if ((await pageText()).trim() === String(number)) return;
      await delay(100, this.signal);
    }
    throw new GuardError('分页选中状态未确认');
  }
  async diagnoses(): Promise<{ label: string; available: boolean; text: string }[]> {
    const result = [];
    for (const label of diagnosisLabels) {
      checkSignal(this.signal); await assertAuthenticated(this.page);
      const found = await this.visible(this.page.getByText(label, { exact: true }));
      if (!found.length) { result.push({ label, available: false, text: '' }); continue; }
      if (found.length !== 1) throw new StructureError('诊断控件不唯一：' + label);
      await retry(async () => {
        await found[0].click(); await delay(250, this.signal);
        if (!await this.selected(found[0])) throw new Error('诊断选中状态未确认：' + label);
      }, this.config.stepRetries, this.signal);
      const text = await this.page.locator('body').innerText();
      const begin = text.lastIndexOf('笔记诊断'), end = text.indexOf('核心数据', begin + 4);
      if (begin < 0 || end < 0) throw new StructureError('诊断内容区域未识别');
      result.push({ label, available: true, text: text.slice(begin, end) });
    }
    return result;
  }
  private async selected(locator: Locator): Promise<boolean> {
    return locator.evaluate(el => {
      let node: Element | null = el;
      for (let i = 0; node && i < 4; i++, node = node.parentElement) {
        if (['aria-selected', 'aria-pressed', 'data-selected', 'data-active'].some(a => node!.getAttribute(a) === 'true')
          || /(?:^|[\s_-])(?:active|selected|checked|current)(?:$|[\s_-])/.test(node.getAttribute('class') || '')
          || node.querySelector('input:checked')) return true;
        if (node.querySelectorAll('[role="tab"],button').length > 1) break;
      }
      return false;
    });
  }
  private async watchConfirmed(watch: Locator, region: Locator): Promise<boolean> {
    if (await this.selected(watch)) return true;
    return /数据量过少|暂无数据|观看数不足/.test(await region.innerText())
      && await watch.evaluate(el => !!el.closest('.info-container-disabled'));
  }
  private async chartReady(region: Locator): Promise<void> {
    await this.page.mouse.move(5, 5);
    const deadline = Date.now() + this.config.operationTimeoutMs;
    let previous = '', stable = 0;
    while (Date.now() < deadline) {
      checkSignal(this.signal);
      const state = await region.evaluate(el => {
        const text = (el as HTMLElement).innerText;
        if (/数据量过少|暂无数据|观看数不足|暂时无法分析/.test(text)) return 'unavailable';
        const canvases = [...el.querySelectorAll('canvas')].filter(c => c.width > 100 && c.height > 100);
        if (canvases.length) {
          try {
            return canvases.map(c => {
              const pixels = c.getContext('2d')?.getImageData(0, 0, c.width, c.height).data;
              if (!pixels) return '';
              let hash = 0, nonempty = false;
              for (let i = 0; i < pixels.length; i += 16) {
                hash = ((hash * 31) ^ pixels[i] ^ pixels[i + 1] ^ pixels[i + 2] ^ pixels[i + 3]) | 0;
                if (pixels[i + 3] && Math.min(pixels[i], pixels[i + 1], pixels[i + 2]) < 245) nonempty = true;
              }
              return nonempty ? String(hash) : '';
            }).join('|');
          } catch { return ''; }
        }
        const svg = [...el.querySelectorAll('svg')].find(s => s.getBoundingClientRect().width > 100 && s.getBoundingClientRect().height > 100);
        return svg?.outerHTML || '';
      });
      if (state === 'unavailable') return;
      if (state && state === previous) stable++; else stable = 0;
      if (stable >= 2) return;
      previous = state; await delay(200, this.signal);
    }
    throw new Error('图表未完成绘制或持续变化');
  }
  private async markRegion(label: string, kind: 'core' | 'trend'): Promise<Locator> {
    const candidates = await this.visible(this.page.getByText(label, { exact: true }));
    let marked = false;
    const attribute = 'data-xhs-region';
    for (const anchor of candidates) {
      if (kind === 'trend' && await anchor.evaluate(el => !!el.closest('button,[role="tab"]'))) continue;
      marked = await anchor.evaluate((el, options) => {
      for (let node: HTMLElement | null = el as HTMLElement; node && node !== document.body; node = node.parentElement) {
        const text = node.innerText;
        const chart = !!node.querySelector('canvas,svg'); const empty = /观看数不足|数据量过少|暂无数据|暂时无法分析/.test(text);
        const core = options.kind === 'core' && text.includes('按小时') && text.includes('按天') && !text.includes('互动数据');
        const trend = options.kind === 'trend' && !text.includes('观看来源');
        if ((core || trend) && (chart || empty) && node.getBoundingClientRect().height > 100) {
          node.setAttribute(options.attribute, options.kind); return true;
        }
      }
      return false;
      }, { attribute, kind });
      if (marked) break;
    }
    if (!marked) throw new StructureError('无法定位图表区域：' + label);
    return this.page.locator('[' + attribute + '="' + kind + '"]');
  }
  async coreScreenshot(root: string, note: Note, mode: '按小时' | '按天'): Promise<Artifact> {
    await assertAuthenticated(this.page);
    let region = await this.markRegion('按小时', 'core');
    const metricLabels = await this.visible(region.locator('.block-container .des').filter({ hasText: /^观看数\s*$/ }));
    // Chart hover tooltips may also contain "观看数"; select the actual metric card.
    const watch = metricLabels.length === 1 ? metricLabels[0] : await this.exact('观看数', region);
    await watch.click();
    await delay(200, this.signal);
    region = await this.markRegion('按小时', 'core');
    const toggle = await this.exact(mode, region);
    await retry(async () => {
      await toggle.click(); await delay(400, this.signal);
      if (!await this.selected(toggle)) throw new Error('核心观看数时间模式未确认：' + mode);
      if (!await this.watchConfirmed(watch, region)) throw new Error('核心观看数指标选中状态未确认');
    }, this.config.stepRetries, this.signal);
    await this.responses.settle(this.config.operationTimeoutMs, this.signal);
    region = await this.markRegion('按小时', 'core');
    await this.chartReady(region);
    const artifact = await this.capture(root, region, `core-view-trends/${mode === '按小时' ? 'hour' : 'day'}/${noteName(note)}/full.png`, mode);
    if (!await this.selected(toggle) || !await this.watchConfirmed(watch, region)) throw new GuardError('截图期间图表选中状态变化');
    return artifact;
  }
  async trendScreenshot(root: string, note: Note): Promise<Artifact[]> {
    const base = this.responses.get('/note/base');
    if (['NORMAL', 'IMAGE'].includes(base?.note_info?.type)) return [];
    const region = await this.markRegion('观看趋势', 'trend');
    await this.chartReady(region);
    return [await this.capture(root, region, `trends/${noteName(note)}/full.png`)];
  }
  async loadAudience(): Promise<void> {
    // Scroll through lazy-loaded modules without switching the time series of interaction metrics.
    for (const label of ['观看来源', '观众画像']) {
      const found = await this.visible(this.page.getByText(label, { exact: true }));
      if (found.length === 1) await found[0].scrollIntoViewIfNeeded();
    }
    await this.responses.wait('/note/audience/source', this.config.operationTimeoutMs, this.signal);
    await this.responses.wait('/note/audience/source/detail', this.config.operationTimeoutMs, this.signal);
  }
  async official(root: string, key: string): Promise<Artifact> {
    // Details contain a second export for interaction data; only export the core module.
    let scope = this.page.locator('body');
    if (new URL(this.page.url()).pathname === '/statistics/note-detail') {
      scope = await this.markRegion('按小时', 'core');
    }
    const buttons = await this.visible(scope.getByRole('button', { name: '导出数据', exact: true }));
    const fallback = buttons.length ? buttons : await this.visible(scope.getByText('导出数据', { exact: true }));
    if (fallback.length !== 1) throw new Error('官方导出按钮数量不符合预期：' + fallback.length);
    const deadline = Date.now() + this.config.downloadTimeoutMs;
    const waiting = this.page.waitForEvent('download', { timeout: this.config.downloadTimeoutMs });
    // Observe rejection immediately even if clicking fails before the download event.
    void waiting.catch(() => {});
    await fallback[0].click();
    const download = await waiting;
    const tmp = root + '/.download-' + randomUUID();
    await fs.mkdir(root, { recursive: true });
    try {
      await saveDownload(download, tmp, deadline - Date.now(), this.signal);
      const error = await download.failure(); if (error) throw new Error('官方下载失败：' + error);
      const data = await fs.readFile(tmp);
      const ext = await validateOfficialFile(data, download.suggestedFilename());
      return await saveArtifact(root, `official/${safeFilename(key)}.${ext}`, data, { kind: 'official' });
    } finally { await fs.rm(tmp, { force: true }); await download.delete().catch(() => {}); }
  }
  private async capture(root: string, region: Locator, filename: string, mode?: string): Promise<Artifact> {
    await region.scrollIntoViewIfNeeded(); await delay(300, this.signal);
    // Select the closest scrolling ancestor, not the largest unrelated scroll container.
    await region.evaluate(el => {
      document.querySelectorAll('[data-xhs-scroll]').forEach(n => n.removeAttribute('data-xhs-scroll'));
      let node: HTMLElement | null = el.parentElement;
      while (node && node !== document.body && !(node.scrollHeight > node.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(node).overflowY))) node = node.parentElement;
      (node && node !== document.body ? node : document.scrollingElement)?.setAttribute('data-xhs-scroll', 'true');
    });
    const geometry = async () => region.evaluate(el => {
      const rect = el.getBoundingClientRect(); const scroll = document.querySelector('[data-xhs-scroll]')! as HTMLElement;
      const isDocument = scroll === document.scrollingElement; const parent = scroll.getBoundingClientRect();
      return { width: rect.width, height: rect.height, left: rect.left, top: rect.top,
        scroll: scroll.scrollTop, rootTop: isDocument ? 0 : Math.max(0, parent.top),
        rootBottom: isDocument ? innerHeight : Math.min(innerHeight, parent.bottom),
        viewportWidth: innerWidth, viewportHeight: innerHeight, total: scroll.scrollHeight, client: scroll.clientHeight };
    });
    const initial = await geometry();
    const width = Math.round(initial.width), height = Math.round(initial.height);
    if (width <= 0 || height <= 0 || width * height > 80_000_000) throw new Error('图表截图尺寸异常');
    const parts: { input: Buffer; left: number; top: number }[] = [];
    const segments: { from: number; to: number }[] = [];
    let covered = 0;
    for (let index = 0; index < 100 && covered < height; index++) {
      checkSignal(this.signal); await assertAuthenticated(this.page);
      const before = await geometry();
      const wanted = before.scroll + before.top - before.rootTop + covered - 100;
      await this.page.locator('[data-xhs-scroll]').evaluate((el, top) => el.scrollTo({ top, behavior: 'instant' }), wanted);
      await delay(120, this.signal);
      const pos = await geometry();
      if (Math.abs(pos.width - initial.width) > 1 || Math.abs(pos.height - initial.height) > 1) throw new Error('截图期间图表尺寸变化');
      const top = Math.max(pos.top + covered, pos.rootTop + 85, 0);
      const bottom = Math.min(pos.top + height, pos.rootBottom, pos.viewportHeight);
      const from = Math.round(top - pos.top), to = Math.min(height, Math.floor(bottom - pos.top));
      if (from > covered + 1 || to <= covered || pos.left < 0 || pos.left + width > pos.viewportWidth + 1) throw new Error('图表截图存在覆盖缺口或水平裁切');
      const start = covered; const pixels = to - start;
      const data = await this.page.screenshot({ type: 'png', clip: { x: Math.max(0, pos.left), y: pos.top + start, width, height: pixels }, animations: 'disabled' });
      const meta = await sharp(data).metadata();
      if (meta.width !== width || meta.height !== pixels) throw new Error('图表截图像素比例不一致');
      parts.push({ input: data, left: 0, top: start }); segments.push({ from: start, to }); covered = to;
    }
    if (covered !== height) throw new Error('图表截图未覆盖全部区域');
    const image = await sharp({ create: { width, height, channels: 4, background: '#fff' } }).composite(parts).png().toBuffer();
    const unavailable = /观看数不足|数据量过少|暂无数据|暂时无法分析/.test(await region.innerText());
    return saveArtifact(root, filename, image, { kind: 'screenshot', mode, complete: true, unavailable, width, height, segments });
  }
}
