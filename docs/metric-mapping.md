# 已核验指标映射（定义版本 1）

依据 src/parser.ts 的 extractNote 和实际 schemaVersion 4 导出结构；历史层消费已提取 row，不猜测平台接口或从截图推断数值。所有定义 source_kind=page_response，metric_schema_version=1。统计窗口均为 unknown，window_start/end=NULL；job.scope.dates 仅保留笔记筛选来源，不当作指标窗口。

| metric_key | source_field_path | value_type | unit | applicable_note_types |
| --- | --- | --- | --- | --- |
| `impl_count` | records[].row.曝光数 | integer | count | 视频、图文 |
| `impl_count_rate_with_fans` | records[].row.曝光_粉丝占比 | decimal | percent_points | 视频、图文 |
| `view_count` | records[].row.观看数 | integer | count | 视频、图文 |
| `view_rate_with_fans` | records[].row.观看_粉丝占比 | decimal | percent_points | 视频、图文 |
| `cover_click_rate` | records[].row.封面点击率 | decimal | percent_points | 视频、图文 |
| `cover_click_rate_with_fans` | records[].row.粉丝封面点击率 | decimal | percent_points | 视频、图文 |
| `view_time_avg_with_double` | records[].row.平均观看时长_秒 | decimal | seconds | 视频、图文 |
| `view_time_avg_with_fans` | records[].row.粉丝平均观看时长_秒 | decimal | seconds | 视频、图文 |
| `full_view_rate` | records[].row.完播率 | decimal | percent_points | 视频 |
| `full_view_rate_with_fans` | records[].row.粉丝完播率 | decimal | percent_points | 视频 |
| `exit_view2s_rate` | records[].row.2秒退出率 | decimal | percent_points | 视频 |
| `exit_view2s_rate_with_fans` | records[].row.粉丝2秒退出率 | decimal | percent_points | 视频 |
| `finish5s_rate` | records[].row.5秒完播率 | decimal | percent_points | 视频 |
| `finish5s_rate_with_fans` | records[].row.粉丝5秒完播率 | decimal | percent_points | 视频 |
| `rise_fans_count` | records[].row.涨粉数 | integer | count | 视频、图文 |
| `like_count` | records[].row.点赞数 | integer | count | 视频、图文 |
| `like_rate_with_fans` | records[].row.点赞_粉丝占比 | decimal | percent_points | 视频、图文 |
| `comment_count` | records[].row.评论数 | integer | count | 视频、图文 |
| `comment_rate_with_fans` | records[].row.评论_粉丝占比 | decimal | percent_points | 视频、图文 |
| `collect_count` | records[].row.收藏数 | integer | count | 视频、图文 |
| `collect_rate_with_fans` | records[].row.收藏_粉丝占比 | decimal | percent_points | 视频、图文 |
| `share_count` | records[].row.分享数 | integer | count | 视频、图文 |
| `share_rate_with_fans` | records[].row.分享_粉丝占比 | decimal | percent_points | 视频、图文 |
| `interaction_rate` | records[].row.互动率 | decimal | percent_points | 视频、图文 |
| `interaction_rate_with_fans` | records[].row.粉丝互动率 | decimal | percent_points | 视频、图文 |
| `danmaku_count` | records[].row.弹幕数 | integer | count | 视频、图文 |
| `danmaku_rate_with_fans` | records[].row.弹幕_粉丝占比 | decimal | percent_points | 视频、图文 |
| `avg_view_image` | records[].row.平均浏览图片数 | decimal | images | 图文 |
| `avg_view_image_with_fans` | records[].row.粉丝平均浏览图片数 | decimal | images | 图文 |

## 状态与单位

上述明确类型不适用时保存 NULL/not_applicable。真实数值 0 保持 available；其他 NULL 若没有明确模块状态则 unknown，不补零。平台未提供/数据不足 → not_available；读取失败/采集失败 → collection_failed；诊断“不适用” → not_applicable。原采集器必需的曝光/观看/点赞/评论/收藏/分享六个核心数量缺失时隔离为 needs_review，不能用缺失修订替换有效值。非法类型、非有限数值、已明确非负指标的负数、count 非整数标 collection_failed，并隔离该修订为 needs_review。核心比率除互动率外按已定义 0–100 校验；互动率不强加 100 上限。时长 seconds，图片平均数 images，未定义诊断单位 unknown。百分数点原值不再乘 100。

## 动态映射（同一版本）

| metric_key 规则 | 实际 row 来源 | 类型/单位 | 状态/适用性 |
| --- | --- | --- | --- |
| source:后接原字段名 | 来源_<平台分类>_曝光数/观看数/互动数/点赞数/评论数/收藏数等 | 数量 integer/count；平均观看时长 decimal/seconds；占比及互动率 decimal/percent_points | 观看来源状态；两类型，分类仅在原件存在时创建 |
| portrait:后接原字段名 | 画像_<性别/年龄/城市/兴趣>_<平台分类>_占比 | decimal/percent_points | 观众画像状态；两类型，不猜不存在的分类 |
| diagnosis:后接原字段名 | *_数值、*_同类中位数、*_超过同类作者占比 | decimal；超过同类作者占比均为 percent_points；流量转化、互动表现、开头吸引力、诊断_完播率的数值及中位数是 percent_points；内容深度为 seconds；其他 unknown（不猜测其正负范围） | 对应 *_诊断结果；明确不适用优先，否则缺失为 unknown/not_available |

动态诊断规则对应现有 parser 已实现的转换：count/median 的特定比率乘 100、scale 乘 100 已发生在旧导出层；历史层不重复转换。其他字段（文字建议、更新时间、附件路径和未识别指标）保留在私有 history.json 的 unmapped_fields，经敏感键过滤，但不混入标准指标长表。附件路径与官方文件元信息不参与业务修订指纹。
