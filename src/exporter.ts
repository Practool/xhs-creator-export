import fs from 'node:fs/promises';
import path from 'node:path';
import { createWriteStream } from 'node:fs';
import ExcelJS from 'exceljs';
import archiver from 'archiver';
import { atomicWrite, safePath, verifyArtifact } from './files.js';
import { extractNote, isPercentColumn, redact } from './parser.js';
import type { Archive, Artifact, Row } from './types.js';

export function csvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (typeof value !== 'number' && /^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function columnsFor(rows: Row[]): string[] {
  const first = ['笔记ID', '标题', '内容类型', '发布时间', '曝光数', '观看数', '封面点击率', '平均观看时长_秒',
    '完播率', '2秒退出率', '5秒完播率', '点赞数', '评论数', '收藏数', '分享数', '涨粉数', '互动率', '平均浏览图片数'];
  return [...new Set([...first, ...rows.flatMap(r => Object.keys(r))])];
}
export async function validateOfficialFile(data: Buffer, name: string): Promise<string> {
  if (!data.length) throw new Error('官方文件为空');
  const zipSignature = data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 3 && data[3] === 4;
  if (/\.xlsx$/i.test(name) || zipSignature) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(data as any);
    const cells = workbook.worksheets.flatMap(s => {
      const values: string[] = [];
      for (let i = 1; i <= Math.min(s.rowCount, 15); i++) s.getRow(i).eachCell(c => values.push(c.text));
      return values;
    }).join(' ');
    if (!/笔记|观看|曝光|标题|点赞|发布时间/.test(cells)) throw new Error('官方 Excel 表头不符合预期');
    return 'xlsx';
  }
  if (/\.csv$/i.test(name)) {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    if (!/笔记|观看|曝光|标题|点赞|发布时间/.test(text.split(/\r?\n/).slice(0, 15).join(' '))) throw new Error('CSV 表头不符合预期');
    return 'csv';
  }
  throw new Error('暂不支持校验该官方格式：' + path.extname(name));
}
export function artifactList(archive: Archive): Artifact[] {
  return [...new Map([...archive.job.officialFiles, ...archive.records.flatMap(r => [
    ...r.snapshot.officialFiles, ...(r.snapshot.coreViewScreenshots || []), ...r.snapshot.trendScreenshots,
  ])].map(a => [a.path, a])).values()];
}
export async function exportArchive(archive: Archive, root: string, legacy = false): Promise<string> {
  archive = structuredClone(archive);
  if (!legacy) {
    const notes = new Map(archive.job.notes.map(n => [n.id, n]));
    for (const record of archive.records) {
      const note = notes.get(String(record.row['笔记ID']));
      if (!note) throw new Error('导出笔记不属于目录');
      record.row = extractNote(record.snapshot, note);
    }
  }
  const rows = archive.records.map(r => r.row);
  if (new Set(rows.map(r => r['笔记ID'])).size !== rows.length) throw new Error('导出笔记 ID 重复');
  if (rows.length !== archive.job.completed.length) throw new Error('导出记录和完成进度不一致');
  const artifacts = artifactList(archive);
  const invalid: string[] = [];
  for (const item of artifacts) {
    if (legacy ? !await fs.stat(safePath(root, item.path)).then(s => s.size > 0).catch(() => false)
      : !await verifyArtifact(root, item)) invalid.push(item.path);
  }
  const complete = ['complete', 'complete_with_warnings'].includes(archive.job.status);
  if (complete && (invalid.length || rows.length !== archive.job.notes.length || !archive.job.directoryComplete))
    throw new Error('完整批次校验失败，先 resume 修复：' + invalid.join(', '));
  const columns = columnsFor(rows);
  await atomicWrite(path.join(root, 'content-data.json'), JSON.stringify(redact(archive), null, 2));
  await atomicWrite(path.join(root, '笔记分析总表.csv'), '\uFEFF' + [columns, ...rows.map(r => columns.map(c => r[c]))].map(r => r.map(csvCell).join(',')).join('\r\n'));
  const workbook = new ExcelJS.Workbook(); workbook.creator = 'xhs-creator-export';
  const sheet = workbook.addWorksheet('笔记分析总表', { views: [{ state: 'frozen', xSplit: 4, ySplit: 1 }] });
  sheet.columns = columns.map(key => ({ header: key, key, width: /标题|建议|说明|地址|截图|Excel/.test(key) ? 38 : 20 }));
  for (const row of rows) {
    const excelRow = sheet.addRow(columns.map(c => typeof row[c] === 'number' && isPercentColumn(c) ? Number(row[c]) / 100 : row[c] ?? null));
    excelRow.eachCell((cell, index) => {
      if (typeof cell.value === 'number') cell.numFmt = isPercentColumn(columns[index - 1]) ? '0.00%' : '0.##';
      cell.alignment = { vertical: 'top', wrapText: true };
    });
  }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFB9233B' } };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: columns.length } };
  const notes = workbook.addWorksheet('字段说明');
  notes.columns = [{ header: '字段', key: 'name', width: 25 }, { header: '说明', key: 'text', width: 100 }];
  const report = { schemaVersion: 4, jobId: archive.job.id, status: archive.job.status, complete,
    expected: archive.job.notes.length, rows: rows.length, videos: rows.filter(r => r['内容类型'] === '视频').length,
    images: rows.filter(r => r['内容类型'] === '图文').length, columns: columns.length, officialFiles: artifacts.filter(a => a.kind === 'official' || a.path.startsWith('official/')).length,
    invalidArtifacts: invalid, warnings: archive.job.exportWarnings, errors: archive.job.errors, scope: archive.job.scope,
    verifiedAt: new Date().toISOString(), legacyImport: legacy };
  for (const [name, text] of [
    ['批次状态', archive.job.status + '；部分批次不可视为全量结果'],
    ['范围', JSON.stringify(archive.job.scope || {})], ['时间', '所有可读时间为 Asia/Shanghai；JSON 原始采集时间为 ISO UTC。Excel 时间保存为文本，避免时区漂移。'],
    ['单位', 'JSON/CSV 百分数 26.9 表示 26.9%；Excel 保存 0.269 并设置百分比格式。时长单位秒。'],
    ['缺失', '空值不是 0；不适用、数据不足、读取失败分别记录。'], ['来源', '正常浏览产生的平台响应；诊断建议取自页面。原始响应在 JSON。'],
    ['截图', '核心观看数在 core-view-trends/hour 和 day；视频观看趋势在 trends。'], ['官方导出', '文件原样保存，失败原因列与报告记录。'],
  ]) notes.addRow({ name, text });
  notes.eachRow(row => row.eachCell(c => { c.alignment = { wrapText: true, vertical: 'top' }; }));
  await atomicWrite(path.join(root, '小红书笔记分析总表.xlsx'), Buffer.from(await workbook.xlsx.writeBuffer()));
  await atomicWrite(path.join(root, 'validation.json'), JSON.stringify(report, null, 2));
  const zipFile = path.join(root, `${path.basename(root)}.zip`);
  const tempZip = zipFile + '.tmp';
  try {
    await new Promise<void>((resolve, reject) => {
      const output = createWriteStream(tempZip); const zip = archiver('zip', { zlib: { level: 6 } });
      output.once('close', resolve); output.once('error', reject); zip.once('error', reject); zip.on('warning', reject);
      zip.pipe(output);
      for (const filename of ['content-data.json', '笔记分析总表.csv', '小红书笔记分析总表.xlsx', 'validation.json']) zip.file(path.join(root, filename), { name: filename });
      for (const item of artifacts) if (!invalid.includes(item.path)) zip.file(safePath(root, item.path), { name: item.path });
      void zip.finalize().catch(reject);
    });
    await fs.rename(tempZip, zipFile);
    if (!legacy) await fs.rm(path.join(root, 'archive.zip'), { force: true });
  } finally { await fs.rm(tempZip, { force: true }).catch(() => {}); }
  return zipFile;
}
export async function importLegacy(filename: string): Promise<Archive> {
  const archive = JSON.parse(await fs.readFile(filename, 'utf8')) as Archive;
  if (!archive.job || !Array.isArray(archive.records) || !Array.isArray(archive.job.notes)) throw new Error('旧数据包结构错误');
  archive.job.completed ??= archive.records.map(r => String(r.row['笔记ID']));
  archive.job.officialFiles ??= []; archive.job.exportWarnings ??= []; archive.job.errors ??= [];
  for (const record of archive.records) {
    record.snapshot.officialFiles ??= []; record.snapshot.trendScreenshots ??= []; record.snapshot.coreViewScreenshots ??= [];
  }
  return archive;
}
