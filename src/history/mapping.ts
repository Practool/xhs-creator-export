export interface Definition { key: string; field: string; unit: string; type: string; applies?: string; max?: number; min?: number }
const core = [
 ['impl_count','曝光数','count'],['impl_count_rate_with_fans','曝光_粉丝占比','percent_points'],
 ['view_count','观看数','count'],['view_rate_with_fans','观看_粉丝占比','percent_points'],
 ['cover_click_rate','封面点击率','percent_points'],['cover_click_rate_with_fans','粉丝封面点击率','percent_points'],
 ['view_time_avg_with_double','平均观看时长_秒','seconds'],['view_time_avg_with_fans','粉丝平均观看时长_秒','seconds'],
 ['full_view_rate','完播率','percent_points','视频'],['full_view_rate_with_fans','粉丝完播率','percent_points','视频'],
 ['exit_view2s_rate','2秒退出率','percent_points','视频'],['exit_view2s_rate_with_fans','粉丝2秒退出率','percent_points','视频'],
 ['finish5s_rate','5秒完播率','percent_points','视频'],['finish5s_rate_with_fans','粉丝5秒完播率','percent_points','视频'],
 ['rise_fans_count','涨粉数','count'],['like_count','点赞数','count'],['like_rate_with_fans','点赞_粉丝占比','percent_points'],
 ['comment_count','评论数','count'],['comment_rate_with_fans','评论_粉丝占比','percent_points'],
 ['collect_count','收藏数','count'],['collect_rate_with_fans','收藏_粉丝占比','percent_points'],
 ['share_count','分享数','count'],['share_rate_with_fans','分享_粉丝占比','percent_points'],
 ['interaction_rate','互动率','percent_points'],['interaction_rate_with_fans','粉丝互动率','percent_points'],
 ['danmaku_count','弹幕数','count'],['danmaku_rate_with_fans','弹幕_粉丝占比','percent_points'],
 ['avg_view_image','平均浏览图片数','images','图文'],['avg_view_image_with_fans','粉丝平均浏览图片数','images','图文'],
];
export const definitions: Definition[] = core.map(([key,field,unit,applies]) => ({key,field,unit,applies,
 type:unit==='count'?'integer':'decimal', min:0, max:unit==='percent_points' && !key.startsWith('interaction_rate') ? 100:undefined}));
export function definitionsFor(row: Record<string, unknown>): Definition[] {
 const result = [...definitions];
 for (const field of Object.keys(row).sort()) {
  if (/^画像_(性别|年龄|城市|兴趣)_.+_占比$/.test(field)) result.push({key:'portrait:'+field,field,unit:'percent_points',type:'decimal',min:0});
  else if (/^来源_.+_(曝光数|曝光占比|观看数|观看占比|互动数|互动率|点赞数|评论数|收藏数|平均观看时长_秒)$/.test(field)) {
   const unit = /占比|互动率$/.test(field)?'percent_points':/时长_秒$/.test(field)?'seconds':/数$/.test(field)?'count':null;
   if(unit) result.push({key:'source:'+field,field,unit,type:unit==='count'?'integer':'decimal',min:0});
  } else if (/^(流量转化|互动表现|内容深度|开头吸引力|视频画质|内容丰富度|笔记涨粉|诊断_.+)_(数值|同类中位数|超过同类作者占比)$/.test(field)) {
   const percent = /超过同类作者占比$/.test(field) || /^(流量转化|互动表现|开头吸引力|诊断_完播率)_/.test(field);
   result.push({key:'diagnosis:'+field,field,unit:percent?'percent_points':/^内容深度_/.test(field)?'seconds':'unknown',type:'decimal',min:percent||/^内容深度_/.test(field)?0:undefined});
  }
 }
 return result;
}
