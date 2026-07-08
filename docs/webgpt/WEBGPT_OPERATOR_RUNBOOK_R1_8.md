# WebGPT 本地交接操作手册 R1-8

```yaml
task_id: R1-8_WEBGPT_OPERATOR_RUNBOOK_AND_PROMPT_PACK
result: OPERATOR_RUNBOOK
scope: local WebGPT handoff only
provider_boundary:
  provider_called: false
  credentials_required: false
  source_overwrite_allowed: false
```

## 1. 使用原则

这份手册用于把网页端 GPT 产出的分镜图、分镜脚本、审查意见和生产建议，交接到本地系统。WebGPT 可以读本地桥接暴露的安全摘要、提交草稿、发起待人工确认请求、辅助审片和拟定生产计划；真正的 `artifact_id`、`storyboard_package_id`、review 状态、provider 执行和最终交付状态都必须由本地 app 或 Human Workbench 写入。

不要让 WebGPT 编造任何本地 ID。凡是 `artifact_*`、`storyboard_package_*`、`project_*`、generation run、review decision、final approval，必须来自本地 app 的读取结果、注册结果或报告。

## 2. 当前可信证据

| 类型 | 路径或 ID | 用途 |
|---|---|---|
| R1-7 本地桥接 smoke | `data/reports/r1_7_webgpt_local_bridge_smoke_validation_result.json` | 证明 WebGPT v0 到 v3 本地桥接仍可读当前 closeout 证据 |
| R1-6 现实审计 | `data/reports/r1_6_webgpt_post_closeout_bridge_reality_audit_result.json` | 证明 R1-0 到 R1-5 桥接能力和边界 |
| 最终交付 closeout | `data/reports/r3_9r_final_delivery_closeout_result.json` | 当前 final-approved 项目证据 |
| 当前项目 | `project_b742cb15-e44e-41b2-8d2d-4b90a30720df` | 本地 app 项目 ID |
| 最终视频 artifact | `artifact_2fa09a9e-3408-49f8-96f9-42c87cfbbfbe` | R3-9O 组装后的最终视频 |

## 3. 分镜图导入流程

1. 操作者把 WebGPT 产出的 keyframe PNG 放入 `data/imports`。
2. 本地 app 扫描 `data/imports`，只把通过分类、尺寸、可读性和来源边界的图片列为候选。
3. WebGPT 可以通过只读桥接查看候选摘要，但不能读取任意路径，也不能直接注册文件。
4. 操作者在 Human Workbench 中确认某个候选图用于分镜。
5. 本地 app 执行 Media Artifact 注册，把图片复制到 `data/media/artifacts/images`，并生成真实 `artifact_id`。
6. 注册后的 artifact 应满足：
   - `artifact_type=image`
   - `role=storyboard_image`
   - `status=active`
   - 9:16 分镜图校验通过

## 4. 分镜脚本录入流程

每个 shot 的脚本信息可以由 WebGPT 草拟，但本地 app 才能保存为生产事实。建议字段如下：

| 字段 | WebGPT 可提供 | 本地 app 必须校验或生成 |
|---|---|---|
| `shot_id` | 可引用已知 app shot ID | 必须来自本地 app |
| `description` | 可以草拟 | 本地保存 |
| `video_prompt` | 可以草拟 | 本地保存 |
| `negative_prompt` | 可以草拟 | 本地保存 |
| `duration_seconds` | 可以建议 | 本地校验 provider 约束 |
| `storyboard_image_artifact_id` | 只能引用 app 已返回的 ID | 必须由本地注册生成 |

如果 WebGPT 只有图片和脚本文字，还没有本地 `artifact_id`，只能提交草稿或待确认请求，不能把占位 ID 写入 package。

## 5. Storyboard Package 冻结流程

1. 每个 shot 必须拥有真实 active `storyboard_image` Media Artifact。
2. 每个 shot 必须拥有完整脚本字段。
3. 本地 app 运行 `validateG0StoryboardPackage`。
4. 校验通过后，本地 app 执行 `importG0AppReadyStoryboardPackage`，生成冻结 package。
5. 冻结报告必须保存在 `data/reports`，并能追溯每个 shot 对应的真实 artifact。

WebGPT 可以提出“请验证 package”或“请冻结 package”的请求，但不能直接执行冻结，也不能绕过 artifact gate。

## 6. 生成和审片流程

生成视频属于本地生产流程，不属于 WebGPT 交接步骤。WebGPT 可以做三件事：

- 读取本地桥接暴露的 generated clip metadata；
- 提交中文审片意见草稿；
- 提出重生成 prompt delta 或生产计划建议。

WebGPT 不能做这些事：

- 调用 RunningHub 或 Runway；
- 上传图片到 provider；
- 自动 regeneration；
- 批量扩展任务；
- 修改最终 review decision；
- 标记 final approval。

Human Workbench 或本地脚本执行生成后，输出视频必须注册为本地 generated clip artifact，并通过 ffprobe 校验。

## 7. Final Assembly 和 Closeout 流程

最终组装前必须满足：

- 每个 shot 都有人工 accept 的 generated clip；
- 每个 accepted clip 是本地 active video artifact；
- ffprobe 状态为 PASS；
- assembly input manifest 顺序明确；
- no-overwrite gate 通过。

Final assembly、final video review、final creative approval 和 delivery closeout 都由本地 app / Human Workbench 处理。WebGPT 可以辅助整理检查清单或草拟总结，但不能发布、部署、上传、改生产配置或写入最终 approval。

## 8. WebGPT 可以做什么

| 阶段 | 允许能力 | 输出形态 |
|---|---|---|
| v0 read-only | 读取 app 状态、artifact 摘要、report refs | 安全摘要 |
| v0.5 drafts | 提交 shot script 或 package 草稿 | draft record |
| v1 pending actions | 请求注册、链接、验证、冻结 | pending human confirmation |
| v2 review assistant | 草拟审片意见、拒绝理由、重生成建议 | draft review note |
| v3 production assistant | 草拟生成、重生成、final assembly、saveback 计划 | plan proposal |

所有会改变生产事实的动作都要经过 Human Workbench 或本地 app 的显式确认。

## 9. WebGPT 不能做什么

- 不能编造 `artifact_id`、`storyboard_package_id`、`project_id` 或 provider task ID。
- 不能读取 `.env`、credentials、token、cookie、raw provider payload 或 signed URL。
- 不能调用 RunningHub、Runway 或任何付费 provider。
- 不能覆盖 `data/imports` 中的源图片或其他源资产。
- 不能直接注册 Media Artifact、链接 shot、冻结 package、执行 final assembly 或标记 final approval。
- 不能 push、tag、release、deploy、publish 或修改 production configuration。

## 10. 最小操作检查表

```yaml
before_import:
  images_in_data_imports: true
  source_assets_not_overwritten: true
  no_pending_or_fake_artifact_ids: true
after_media_registration:
  artifact_ids_from_app: true
  storyboard_image_role_active: true
before_package_freeze:
  all_shots_have_real_artifacts: true
  all_shots_have_script_fields: true
  validateG0StoryboardPackage_passed: true
before_generation:
  provider_call_requires_separate_authorization: true
before_final_closeout:
  accepted_clips_for_all_shots: true
  ffprobe_pass_for_outputs: true
  final_review_decision_from_human: true
```

## 11. 推荐交接节奏

1. WebGPT 先输出图片文件和分镜脚本草稿。
2. 操作者把图片放入 `data/imports`。
3. 本地 app 注册 Media Artifact，返回真实 ID。
4. WebGPT 使用真实 ID 整理 package 草稿或请求 Human Workbench 确认。
5. 本地 app 校验并冻结 package。
6. 后续生成、审片、重生成、组装、closeout 都通过本地任务队列或 Human Workbench 推进。

如果某一步缺少真实 app ID 或人工确认，就停在草稿 / pending 状态，不把它提升为生产事实。
