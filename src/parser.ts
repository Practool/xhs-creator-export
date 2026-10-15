import type { Note, Row, Snapshot, ResponseRecord } from './types.js';
import { StructureError } from './errors.js';

const metrics: Record<string, string> = {
  impl_count: '曝光数', impl_count_rate_with_fans: '曝光_粉丝占比', view_count: '观看数', view_rate_with_fans: '观看_粉丝占比',
  cover_click_rate: '封面点击率', cover_click_rate_with_fans: '粉丝封面点击率',
  view_time_avg_with_double: '平均观看时长_秒', view_time_avg_with_fans: '粉丝平均观看时长_秒',
  full_view_rate: '完播率', full_view_rate_with_fans: '粉丝完播率', exit_view2s_rate: '2秒退出率',
  exit_view2s_rate_with_fans: '粉丝2秒退出率', finish5s_rate: '5秒完播率', finish5s_rate_with_fans: '粉丝5秒完播率',
  rise_fans_count: '涨粉数', like_count: '点赞数', like_rate_with_fans: '点赞_粉丝占比',
  comment_count: '评论数', comment_rate_with_fans: '评论_粉丝占比', collect_count: '收藏数',
  collect_rate_with_fans: '收藏_粉丝占比', share_count: '分享数', share_rate_with_fans: '分享_粉丝占比',
  interaction_rate: '互动率', interaction_rate_with_fans: '粉丝互动率', danmaku_count: '弹幕数',
  danmaku_rate_with_fans: '弹幕_粉丝占比', avg_view_image: '平均浏览图片数', avg_view_image_with_fans: '粉丝平均浏览图片数',
};
export const diagnosisLabels = ['流量转化', '互动表现', '内容深度', '开头吸引力', '视频画质', '内容丰富度', '笔记涨粉'];
const diagnoses: Record<string, [string, boolean]> = {
  clickRate: ['流量转化', true], interactRate: ['互动表现', true], viewTimeAvg: ['内容深度', false],
  fullView5sRate: ['开头吸引力', true], vqa: ['视频画质', false], contentRich: ['内容丰富度', false], followFromDiscovery: ['笔记涨粉', false],
  fullViewRate: ['诊断_完播率', true], noteEngage: ['诊断_笔记互动', false],
};
const sourceFields: Record<string, string> = { imp_count: '曝光数', imp_rate: '曝光占比', view_count: '观看数',
  view_rate: '观看占比', interaction_count: '互动数', interaction_rate: '互动率', like_count: '点赞数',
  comment_count: '评论数', collect_count: '收藏数', view_time_avg: '平均观看时长_秒' };
const portraits: Record<string, string> = { gender: '性别', age: '年龄', city: '城市', interest: '兴趣' };
export function localTime(value: number | string | undefined): string | null {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new StructureError('无效时间字段：' + value);
  return date.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}
export function latest(responses: ResponseRecord[], suffix: string): any {
  return [...responses].reverse().find(r => r.endpoint.endsWith(suffix) && r.data?.success === true && r.data?.data)?.data.data;
}
function number(value: unknown, field: string): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new StructureError('数值字段结构变化：' + field);
  return value;
}
function moduleState(data: any): string {
  if (!data) return '读取失败';
  if (data.no_data === true) return data.no_data_tip_msg || '平台数据不足';
  return '已提取';
}
export function extractNote(snapshot: Snapshot, note: Note): Row {
  const base = latest(snapshot.responses, '/note/base');
  if (!base?.note_info || base.note_info.id !== note.id) throw new StructureError('详情数据缺失或笔记 ID 不一致：' + note.id);
  const info = base.note_info;
  const type = info.type === 'VIDEO' ? '视频' : ['NORMAL', 'IMAGE'].includes(info.type) ? '图文' : undefined;
  if (!type) throw new StructureError('未识别笔记类型：' + info.type);
  for (const key of ['impl_count', 'view_count', 'like_count', 'comment_count', 'collect_count', 'share_count']) {
    if (base[key] == null) throw new StructureError('必要指标缺失：' + key);
  }
  if (!Array.isArray(base.analyse_infos)) throw new StructureError('诊断字段结构变化');
  const row: Row = { '笔记ID': note.id, '标题': note.title || note.listData?.title || info.desc || note.listText?.split('\n')[0] || '',
    '内容类型': type, '发布时间': localTime(info.post_time), '采集时间': localTime(snapshot.capturedAt),
    '核心数据更新至': localTime(base.basic_data_last_update_time), '诊断更新至': localTime(base.analyse_infos_last_update_time),
    '详情地址': snapshot.url, '指标来源': '平台页面网络响应；诊断建议来自页面文字',
    '指标缺失字段': Object.keys(metrics).filter(k => base[k] == null).map(k => metrics[k]).join('\n') };
  for (const [key, label] of Object.entries(metrics)) row[label] = number(base[key], key);
  if (type === '图文') {
    for (const label of ['完播率', '粉丝完播率', '2秒退出率', '粉丝2秒退出率', '5秒完播率', '粉丝5秒完播率']) row[label] = null;
  } else { row['平均浏览图片数'] = null; row['粉丝平均浏览图片数'] = null; }
  for (const item of base.analyse_infos) if (!item || typeof item.quota !== 'string') throw new StructureError('诊断项结构变化');
  const allDiagnoses: Record<string, [string, boolean]> = { ...diagnoses };
  for (const item of base.analyse_infos) if (!Object.hasOwn(allDiagnoses, item.quota)) allDiagnoses[item.quota] = ['诊断_' + item.quota, false];
  for (const [quota, [label, percent]] of Object.entries(allDiagnoses)) {
    const item = base.analyse_infos.find((d: any) => d.quota === quota);
    const selected = snapshot.diagnoses.find(d => d.label === label);
    const unavailable = type === '图文' && ['视频画质', '开头吸引力', '内容深度', '诊断_完播率'].includes(label)
      || type === '视频' && ['内容丰富度', '笔记涨粉'].includes(label) && !item;
    for (const [key, output, scale] of [['count', '数值', percent ? 100 : 1], ['median', '同类中位数', percent ? 100 : 1], ['scale', '超过同类作者占比', 100]] as const) {
      const value = number(item?.[key], quota + '.' + key);
      row[label + '_' + output] = unavailable || value == null ? null : value * scale;
    }
    row[label + '_诊断结果'] = unavailable ? '不适用' : item?.special_display_v2 || item?.special_display || '平台未提供';
    row[label + '_同类比较说明'] = unavailable ? null : item?.summary || null;
    row[label + '_建议'] = unavailable ? null : selected?.text.match(/超过\s*[\d.%]+\s*同类作者\s*([\s\S]+)$/)?.[1]?.trim() || null;
    if (label.startsWith('诊断_')) row[label + '_单位说明'] = percent ? 'count/median 为比率，已转为百分数；scale 已转为百分数'
      : 'count/median 保持接口原始单位，不推断单位；scale 已转为百分数';
  }
  const source = latest(snapshot.responses, '/note/audience/source');
  const portrait = latest(snapshot.responses, '/note/audience/source/detail');
  if (!source || !portrait) throw new Error('观看来源或观众画像响应缺失，请重新加载详情');
  if (source.no_data !== true && !Array.isArray(source.source)) throw new StructureError('观看来源结构变化');
  if (portrait.no_data !== true && !Object.keys(portraits).some(k => Array.isArray(portrait[k]))) throw new StructureError('观众画像结构变化');
  row['观看来源状态'] = moduleState(source); row['观看来源更新至'] = localTime(source.last_update_time);
  for (const item of source.source || []) {
    if (typeof item.title !== 'string') throw new StructureError('观看来源分类缺失');
    const prefix = '来源_' + item.title + '_';
    row[prefix + '占比'] = number(item.value_with_double ?? item.value, prefix + '占比');
    for (const [key, label] of Object.entries(sourceFields)) if (Object.hasOwn(item.info || {}, key)) row[prefix + label] = number(item.info[key], prefix + key);
  }
  row['观众画像状态'] = moduleState(portrait);
  if (portrait.no_data !== true && !Object.keys(portraits).some(k => portrait[k]?.length)) row['观众画像状态'] = '平台未提供';
  row['观众画像更新至'] = localTime(portrait.last_update_time);
  for (const [key, label] of Object.entries(portraits)) for (const item of portrait[key] || []) {
    if (typeof item.title !== 'string') throw new StructureError('画像分类缺失');
    row['画像_' + label + '_' + item.title + '_占比'] = number(item.value, key);
  }
  for (const mode of ['按小时', '按天']) {
    const files = snapshot.coreViewScreenshots.filter(s => s.mode === mode);
    if (files.length !== 1 || !files[0].complete) throw new Error('必要核心截图缺失或不完整：' + mode);
    row['核心观看数_' + mode + '_截图'] = files[0].path;
    row['核心观看数_' + mode + '_状态'] = files[0].unavailable ? '平台数据不足，已保存提示' : '已截图';
  }
  if (type === '视频' && !snapshot.trendScreenshots.length) throw new Error('视频观看趋势截图缺失');
  row['观看趋势截图'] = snapshot.trendScreenshots.map(s => s.path).join('\n');
  row['观看趋势状态'] = type === '图文' ? '不适用' : snapshot.trendScreenshots.some(s => s.unavailable) ? '平台数据不足，已保存提示' : '已截图';
  row['官方核心Excel'] = snapshot.officialFiles.map(s => s.path).join('\n');
  row['官方Excel状态'] = snapshot.officialFiles.length ? '已保存' : '下载失败，详情指标已保存';
  row['官方Excel失败原因'] = snapshot.officialExportError || null;
  return row;
}
export function compactResponses(responses: ResponseRecord[]): ResponseRecord[] {
  return responses.filter(r => !r.endpoint.endsWith('/note/analyze/list')).map(r => {
    const copy = structuredClone(r);
    if (copy.endpoint.endsWith('/note/base') && copy.data?.data) { delete copy.data.data.hour; delete copy.data.data.day; }
    return copy;
  });
}
export function isPercentColumn(label: string): boolean {
  return /占比|点击率|完播率|退出率|互动率/.test(label) || /^(流量转化|互动表现|开头吸引力)_(数值|同类中位数)$/.test(label);
}
export function redact(value: any, depth = 0): any {
  if (depth > 30) return '[depth limit]';
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !/(?:token|cookie|password|secret|authorization|signature|session|phone|email)/i.test(key))
    .map(([key, v]) => [key, redact(v, depth + 1)]));
  return value;
}
