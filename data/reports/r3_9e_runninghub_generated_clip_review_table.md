# R3-9E RunningHub 生成片段人工审查表

来源报告：`data/reports/r3_9e_runninghub_generated_clip_review_prep_result.json`

人工审查时，每个镜头只填写一个决策栏：接受、拒绝或请求重生成。本表只是审查准备面板，不会修改应用内审查状态。

| 序号 | 镜头 | 生成片段 Artifact | ffprobe | 时长 | 本地 MP4 | 来源分镜图 Artifact | 接受 | 拒绝 | 请求重生成 | 审查人 | 备注 |
|---:|---|---|---|---:|---|---|---|---|---|---|---|
| 1 | g0_r1_shot_001 | artifact_ac71dfd9-371c-4eb4-a6b6-686993291ceb | PASS | 6.041667 | A:\AI Video Production Workspace\data\media\provider-runs\r3-9b-runninghub-package\01-g0_r1_shot_001\artifact_ac71dfd9-371c-4eb4-a6b6-686993291ceb.mp4 | artifact_cbed1c1c-4293-450e-897e-3be49ddf7fb7 |  |  | regenerate_requested | Jenn | 不应该是拿起饭盒吃饭，应该是手从饭盒里面拿起食物放到嘴巴进行吃的动作 |
| 2 | g0_r1_shot_002 | artifact_2adc2e6d-3183-47c4-8d1b-01bf80bed73f | PASS | 6.041667 | A:\AI Video Production Workspace\data\media\provider-runs\r3-9b-runninghub-package\02-g0_r1_shot_002\artifact_2adc2e6d-3183-47c4-8d1b-01bf80bed73f.mp4 | artifact_9ad1bfe1-c830-458c-a413-39fd15c9d0c0 |  | reject |  | Jenn | 我不要叹气不高兴的表情，这样会让人不想购买产品 |
| 3 | g0_r1_shot_003 | artifact_10271f09-278e-4326-b417-6b4ea64ad8ca | PASS | 6.041667 | A:\AI Video Production Workspace\data\media\provider-runs\r3-9b-runninghub-package\03-g0_r1_shot_003\artifact_10271f09-278e-4326-b417-6b4ea64ad8ca.mp4 | artifact_a7c5d752-cdd6-478e-b396-5790df3af05f |  |  | regenerate_requested | Jenn | 拉扯帽子的时候，帽子的折叠位置变化不符合现实效果，真实的效果是折痕会变浅，面料会随着拉起而变化 |
| 4 | g0_r1_shot_004 | artifact_1f757b43-a308-4d80-a674-7b7a21ceec21 | PASS | 6.041667 | A:\AI Video Production Workspace\data\media\provider-runs\r3-9b-runninghub-package\04-g0_r1_shot_004\artifact_1f757b43-a308-4d80-a674-7b7a21ceec21.mp4 | artifact_e35ff0c0-d0fc-4079-bc4b-38b4dbd88cf7 |  |  | regenerate_requested | Jenn | 主要是帽子的光影没有严谨的符合现实的光影效果 |
