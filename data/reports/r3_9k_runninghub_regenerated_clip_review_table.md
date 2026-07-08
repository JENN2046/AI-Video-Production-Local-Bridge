# R3-9K RunningHub 再生成片段人工审查表

来源报告：`data/reports/r3_9j_runninghub_regeneration_single_pass_live_execution_result.json`
审查准备报告：`data/reports/r3_9k_runninghub_regenerated_clip_review_prep_result.json`

本表只用于人工观看和记录意见，不会修改系统 review decision，也不会触发 regeneration、batch 或 final assembly。每个镜头只填写一个决策栏：accept、reject 或 regenerate_requested。

final assembly 状态：等待人工 accept；未完成 accept 前保持阻塞。

| 序号 | shot_id | 本轮视频 artifact_id | ffprobe | 时长秒 | 本地视频路径 | 上一轮被拒 clip | 上一轮问题 | 这轮重点检查项 | accept | reject | regenerate_requested | 审查人 | 备注 |
|---:|---|---|---|---:|---|---|---|---|---|---|---|---|---|
| 1 | g0_r1_shot_001 | artifact_37d18f76-ec61-4b5d-8f5c-acca2b4ba203 | PASS | 6.041667 | A:\AI Video Production Workspace\data\media\provider-runs\r3-9i-runninghub-regeneration\01-g0_r1_shot_001\artifact_37d18f76-ec61-4b5d-8f5c-acca2b4ba203.mp4 | artifact_ac71dfd9-371c-4eb4-a6b6-686993291ceb | 不应该是拿起饭盒吃饭，应该是手从饭盒里面拿起食物放到嘴巴进行吃的动作 | 确认饭盒始终留在桌上，没有被端起来吃。；确认手是从饭盒里面拿起食物，并把食物送到嘴边或嘴里。；确认人物身份、灰色帽子、工装、构图、工地环境和自然光保持稳定。；确认本片段只能进入人工审查，未获得 accept 前不得进入最终合成。 | accept |  |  | Jenn |  |
| 2 | g0_r1_shot_002 | artifact_eeef12a7-9533-4172-beaa-6c25b91415f7 | PASS | 6.041667 | A:\AI Video Production Workspace\data\media\provider-runs\r3-9i-runninghub-regeneration\02-g0_r1_shot_002\artifact_eeef12a7-9533-4172-beaa-6c25b91415f7.mp4 | artifact_2adc2e6d-3183-47c4-8d1b-01bf80bed73f | 我不要叹气不高兴的表情，这样会让人不想购买产品 | 确认没有叹气、不高兴、疲惫、失望、塌肩或让产品显得负面的情绪。；确认 Ryan 保持专注、自然、亲和，并且对产品观感是正向的。；确认灰色帽子、午餐桌、黄色安全帽、保温杯、饭盒、工地背景和自然光保持稳定。 | accept |  |  | Jenn |  |
| 3 | g0_r1_shot_003 | artifact_20b1ee68-0b75-4fc1-96a8-93f36de31d5a | PASS | 6.041667 | A:\AI Video Production Workspace\data\media\provider-runs\r3-9i-runninghub-regeneration\03-g0_r1_shot_003\artifact_20b1ee68-0b75-4fc1-96a8-93f36de31d5a.mp4 | artifact_10271f09-278e-4326-b417-6b4ea64ad8ca | 拉扯帽子的时候，帽子的折叠位置变化不符合现实效果，真实的效果是折痕会变浅，面料会随着拉起而变化 | 确认拉扯帽子时折痕会变浅，面料会随着拉起方向产生真实变化。；确认帽子仍贴合头部，标签、织物纹理、手部动作和脸部稳定。；确认人物身份、灰色帽子、工装、构图、工地环境和自然光保持稳定。；确认本片段只能进入人工审查，未获得 accept 前不得进入最终合成。 | accept |  |  | Jenn |  |
| 4 | g0_r1_shot_004 | artifact_263a2344-5154-4981-bfe4-120571effb3e | PASS | 6.041667 | A:\AI Video Production Workspace\data\media\provider-runs\r3-9i-runninghub-regeneration\04-g0_r1_shot_004\artifact_263a2344-5154-4981-bfe4-120571effb3e.mp4 | artifact_1f757b43-a308-4d80-a674-7b7a21ceec21 | 主要是帽子的光影没有严谨的符合现实的光影效果 | 确认帽子的光照方向、阴影、接触阴影和织物质感符合真实场景光影。；确认轻微身体动作或镜头跟随不会破坏帽子、脸部、工装和工地背景稳定性。；确认人物身份、灰色帽子、工装、构图、工地环境和自然光保持稳定。；确认本片段只能进入人工审查，未获得 accept 前不得进入最终合成。 | accept |  |  | Jenn |  |
