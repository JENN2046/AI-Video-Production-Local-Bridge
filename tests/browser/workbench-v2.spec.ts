import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

const wcag22AaTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

async function expectNoWcagViolations(page: Page, context: string): Promise<void> {
  const results = await new AxeBuilder({ page }).withTags(wcag22AaTags).analyze();
  const summary = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.map((node) => node.target.join(" "))
  }));
  expect(summary, `${context} 存在 WCAG 2.2 A/AA 自动化违规`).toEqual([]);
}

async function projectIdByTitle(request: APIRequestContext, title: string): Promise<string> {
  const response = await request.get(`/api/v2/projects?limit=100&lifecycle=active&classification=all&query=${encodeURIComponent(title)}`);
  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as { data: Array<{ project: { project_id: string; title: string } }> };
  const project = payload.data.find((item) => item.project.title === title)?.project;
  expect(project, `缺少浏览器夹具项目：${title}`).toBeTruthy();
  return project!.project_id;
}

async function firstActiveProjectId(request: APIRequestContext): Promise<string> {
  return projectIdByTitle(request, "Playwright Production Fixture");
}

async function scanAndDismissDialog(page: Page, name: string, context = name): Promise<void> {
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(dialog).toBeVisible();
  await expectNoWcagViolations(page, context);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

test("素材隔离的可见项选择和筛选往返不会跳顶", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/v2/inbox/quarantine?status=excluded");
  await expect(page.getByRole("heading", { name: "收件箱", exact: true })).toBeVisible();

  const queue = page.locator('[class*="_masterDetail_"] [class*="_virtualViewport_"]');
  await queue.evaluate((element) => {
    element.scrollTop = 640;
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(100);

  const queueBox = await queue.boundingBox();
  const items = queue.locator("button");
  let visibleIndex = -1;
  for (let index = 0; index < await items.count(); index += 1) {
    const box = await items.nth(index).boundingBox();
    if (box && queueBox && box.y >= queueBox.y + 4 && box.y + box.height <= queueBox.y + queueBox.height - 4) {
      visibleIndex = index;
      break;
    }
  }
  expect(visibleIndex).toBeGreaterThanOrEqual(0);

  const before = await queue.evaluate((element) => element.scrollTop);
  await items.nth(visibleIndex).click();
  await page.waitForTimeout(100);
  expect(await queue.evaluate((element) => element.scrollTop)).toBe(before);
  await expect(page).toHaveURL(/selected=/);

  const filter = page.getByRole("tablist", { name: "对象状态" });
  await filter.getByRole("tab", { name: "可注册" }).click();
  await filter.getByRole("tab", { name: "已排除" }).click();
  await page.waitForTimeout(120);
  expect(await queue.evaluate((element) => element.scrollTop)).toBe(before);

  await page.getByRole("tab", { name: "GPT 草稿" }).click();
  await page.getByRole("tab", { name: "素材隔离" }).click();
  await page.getByRole("tablist", { name: "对象状态" }).getByRole("tab", { name: "已排除" }).click();
  await page.waitForTimeout(120);
  expect(await queue.evaluate((element) => element.scrollTop)).toBe(before);
});

test("六区导航可达且 URL 可恢复", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/v2\/dashboard$/);
  for (const [label, path] of [
    ["收件箱", "/v2/inbox/pending"],
    ["Director 审批", "/v2/director"],
    ["项目", "/v2/projects"],
    ["资产库", "/v2/assets/media"],
    ["系统", "/v2/system/provider"],
    ["指挥台", "/v2/dashboard"]
  ] as const) {
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path.replaceAll("/", "\\/")}$`));
  }
});

for (const [label, path, heading] of [
  ["指挥台", "/v2/dashboard", "指挥台"],
  ["项目", "/v2/projects", "项目"],
  ["收件箱", "/v2/inbox/pending", "收件箱"],
  ["Director", "/v2/director", "Director 审批台"],
  ["资产库", "/v2/assets/media", "资产库"],
  ["系统", "/v2/system/provider", "系统"]
] as const) {
  test(`${label}活动页通过 WCAG 2.2 A/AA 自动扫描`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expectNoWcagViolations(page, label);
  });
}

test("移动端五入口和 More sheet 的焦点圈定可用", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/v2/dashboard");
  const navigation = page.getByRole("navigation", { name: "移动端主导航" });
  await expect(navigation.locator("a,button")).toHaveCount(5);
  for (const name of ["指挥台", "项目", "收件箱", "Director"]) await expect(navigation.getByRole("link", { name, exact: true })).toBeVisible();
  const more = navigation.getByRole("button", { name: "更多" });
  await more.click();
  const sheet = page.getByRole("dialog", { name: "更多" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole("link", { name: /资产库/ })).toBeVisible();
  await expect(sheet.getByRole("link", { name: /系统/ })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "关闭" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(sheet.getByRole("link", { name: /系统/ })).toBeFocused();
  await expectNoWcagViolations(page, "移动端 More sheet");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(more).toBeFocused();
});

test("低高度 Director 审批台可滚动到完整提议区", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 620 });
  await page.goto("/v2/director");

  const directorPage = page.locator('[class*="_directorPage_"]');
  const proposalTitle = page.getByRole("heading", { name: "ChatGPT Director 提议" });
  await expect(proposalTitle).toBeAttached();
  expect(await directorPage.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

  await proposalTitle.scrollIntoViewIfNeeded();
  await expect(proposalTitle).toBeVisible();
  await expect(page.getByText("还没有 Director 提议", { exact: true })).toBeVisible();
});

test("1166px Director 使用流动详情且证据位于详情内部", async ({ page }) => {
  await page.setViewportSize({ width: 1166, height: 760 });
  await page.goto("/v2/director");
  const focusPanel = page.locator('[class*="_directorFocusPanel_"]');
  await expect(focusPanel).toBeVisible();
  await expect(focusPanel.locator('[class*="_objectDetail_"] [class*="_evidencePanel_"]')).toBeVisible();
  const metrics = page.locator('[class*="_metricStrip_"] [class*="_metricCell_"] strong');
  for (let index = 0; index < await metrics.count(); index += 1) {
    expect(await metrics.nth(index).evaluate((element) => getComputedStyle(element).whiteSpace)).toBe("nowrap");
  }
  const bodyMetrics = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(bodyMetrics.scrollWidth).toBe(bodyMetrics.clientWidth);
});

test("项目分类平铺、创建分类必选并保留全部生命周期筛选", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/v2/projects");
  const classification = page.getByRole("tablist", { name: "项目分类" });
  await expect(classification.getByRole("tab", { name: "全部分类" })).toBeVisible();
  await expect(classification.getByRole("tab", { name: "生产" })).toBeVisible();
  await expect(classification.getByRole("tab", { name: "未分类" })).toBeVisible();
  await expect(classification.getByRole("tab", { name: "测试" })).toBeVisible();
  await classification.getByRole("tab", { name: "测试" }).click();
  await expect(page).toHaveURL(/classification=test/);
  await page.getByRole("tablist", { name: "项目生命周期" }).getByRole("tab", { name: "全部" }).click();
  await expect(page).toHaveURL(/lifecycle=all/);

  await page.getByRole("button", { name: "新建项目" }).click();
  const createButton = page.getByRole("button", { name: "创建并进入" });
  await page.getByLabel("项目名称", { exact: true }).fill("只验证分类门禁，不提交");
  await expect(createButton).toBeDisabled();
  await page.getByRole("dialog").getByRole("combobox", { name: /^项目分类/ }).selectOption("production");
  await expect(createButton).toBeEnabled();
  await page.getByRole("button", { name: "取消" }).click();
});

test("五个项目页签均通过 WCAG 2.2 A/AA 自动扫描", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const projectId = await firstActiveProjectId(request);
  for (const workspace of ["overview", "storyboard", "generation", "review", "delivery"] as const) {
    await page.goto(`/v2/projects/${encodeURIComponent(projectId)}/${workspace}`);
    await expect(page.locator("#project-workspace-panel")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "项目工作区" }).getByRole("tab", { selected: true })).toBeVisible();
    await expectNoWcagViolations(page, `项目页签 ${workspace}`);
  }
});

for (const viewport of [
  { width: 1920, height: 911 },
  { width: 1166, height: 800 },
  { width: 820, height: 900 },
  { width: 390, height: 844 }
]) {
  test(`${viewport.width}x${viewport.height} 审片版本栈有有效高度和可操作按钮`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const projectId = await firstActiveProjectId(request);
    await page.goto(`/v2/projects/${encodeURIComponent(projectId)}/review`);
    const versionStrip = page.locator('[class*="_versionStrip_"]');
    await expect(versionStrip).toBeVisible();
    const versions = versionStrip.getByRole("button");
    expect(await versions.count()).toBeGreaterThanOrEqual(2);
    for (let index = 0; index < await versions.count(); index += 1) {
      const box = await versions.nth(index).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    for (const action of ["采纳此版本", "请求重生成"]) {
      const button = page.getByRole("button", { name: action });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
    }
    const bodyMetrics = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(bodyMetrics.scrollWidth).toBe(bodyMetrics.clientWidth);
  });
}

test("活动确认对话框共享 AA 语义、焦点恢复和 Escape 行为", async ({ page, request }) => {
  await page.setViewportSize({ width: 1166, height: 820 });
  await page.goto("/v2/projects");
  const createTrigger = page.getByRole("button", { name: "新建项目" });
  await createTrigger.click();
  const createDialog = page.getByRole("dialog", { name: "创建项目" });
  await expect(createDialog.getByLabel("项目名称")).toBeFocused();
  await expectNoWcagViolations(page, "创建项目确认对话框");
  await page.keyboard.press("Escape");
  await expect(createDialog).toBeHidden();
  await expect(createTrigger).toBeFocused();

  const projectId = await firstActiveProjectId(request);
  await page.goto(`/v2/projects/${encodeURIComponent(projectId)}/overview`);
  const overrideTrigger = page.getByRole("button", { name: "指定下一步动作" });
  await overrideTrigger.click();
  const overrideDialog = page.getByRole("dialog", { name: "指定下一步动作" });
  await expect(overrideDialog).toBeVisible();
  await expectNoWcagViolations(page, "项目下一步确认对话框");
  await page.keyboard.press("Escape");
  await expect(overrideTrigger).toBeFocused();
});

test("生产链全部确认对话框逐项通过 WCAG 2.2 A/AA 扫描", async ({ page, request }) => {
  await page.setViewportSize({ width: 1166, height: 820 });

  const generationProjectId = await projectIdByTitle(request, "Playwright Generation Fixture");
  await page.route(`**/api/v2/projects/${generationProjectId}/generation/preflight`, async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ ok: true, data: { intent: {
      intent_id: "intent_browser_ui_only",
      run_id: "",
      project_id: generationProjectId,
      shot_id: "shot_browser_generation_ready",
      provider: "runninghub",
      account_label: "personal",
      model: "rhart-video-g/image-to-video",
      input_artifact_id: "artifact_shot_browser_generation_ready_storyboard",
      duration_seconds: 6,
      resolution: "480p",
      estimated_cost_value: 0.08,
      budget_limit_value: 1,
      currency: "CNY",
      input_snapshot: { balance_gate: "pass", account_balance_value: 10, account_balance_currency: "CNY" },
      confirmed: false,
      expires_at: "2099-01-01T00:00:00.000Z",
      status: "prepared"
    } } })
  }));
  await page.goto(`/v2/projects/${encodeURIComponent(generationProjectId)}/generation?selected=shot_browser_generation_ready`);
  await page.getByRole("button", { name: "预检并生成" }).click();
  const generationPreflightDialog = page.getByRole("dialog", { name: "RunningHub 生成预检" });
  await expect(generationPreflightDialog).toBeVisible();
  await expectNoWcagViolations(page, "生成预检确认框");
  await generationPreflightDialog.getByRole("button", { name: "运行预检" }).click();
  await scanAndDismissDialog(page, "确认一次真实生成");
  await page.getByRole("button", { name: "继续核对已记录任务" }).click();
  await scanAndDismissDialog(page, "继续人工核对", "已记录 task ID 的人工核对确认框");
  await page.getByRole("button", { name: "输入现有 task ID" }).click();
  await scanAndDismissDialog(page, "继续人工核对", "新 task ID 的人工核对确认框");
  await page.getByRole("button", { name: "放弃本次尝试" }).first().click();
  await scanAndDismissDialog(page, "放弃本次生成尝试");

  const assemblyProjectId = await firstActiveProjectId(request);
  await page.goto(`/v2/projects/${encodeURIComponent(assemblyProjectId)}/delivery`);
  await page.getByRole("button", { name: "装配预检" }).click();
  await scanAndDismissDialog(page, "最终装配预检");

  const reviewProjectId = await projectIdByTitle(request, "Playwright Final Review Fixture");
  await page.goto(`/v2/projects/${encodeURIComponent(reviewProjectId)}/delivery`);
  for (const [trigger, dialog] of [
    ["接受当前版本", "接受当前最终版本"],
    ["保留 SHOT 并重装", "仅重新装配"],
    ["定向 SHOT 返工", "定向 SHOT 返工"]
  ] as const) {
    await page.getByRole("button", { name: trigger, exact: true }).click();
    await scanAndDismissDialog(page, dialog);
  }

  const approvedProjectId = await projectIdByTitle(request, "Playwright Approved Delivery Fixture");
  await page.goto(`/v2/projects/${encodeURIComponent(approvedProjectId)}/delivery`);
  await page.getByRole("button", { name: "确认导出", exact: true }).click();
  await scanAndDismissDialog(page, "确认本地导出");

  const exportedProjectId = await projectIdByTitle(request, "Playwright Exported Delivery Fixture");
  await page.goto(`/v2/projects/${encodeURIComponent(exportedProjectId)}/delivery`);
  await page.getByRole("button", { name: "确认结案", exact: true }).click();
  await scanAndDismissDialog(page, "项目结案");

  await page.goto("/v2/system/governance");
  await page.getByRole("button", { name: "确认所选分组" }).click();
  await scanAndDismissDialog(page, "确认归档测试候选");
});

test("Legacy 只读 App 只保留键盘可达诊断且没有执行按钮", async ({ page }) => {
  await page.goto("/v2/system/provider");
  const advanced = page.getByText("高级诊断", { exact: true });
  await advanced.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("link", { name: "Legacy 只读 App" }).click();
  await expect(page.getByRole("heading", { name: "只读 App 发布诊断" })).toBeVisible();
  await expect(page.getByRole("button", { name: /预检|发布|续期|恢复/ })).toHaveCount(0);
  await expect(page.getByText(/不提供任何执行按钮/)).toBeVisible();
});

test("收件箱对象状态与资产完整筛选保持可见", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/v2/inbox/quarantine");
  const inboxStatus = page.getByRole("tablist", { name: "对象状态" });
  for (const label of ["全部", "可注册", "阻断", "已注册", "已排除"]) {
    await expect(inboxStatus.getByRole("tab", { name: label, exact: true })).toBeVisible();
  }
  await inboxStatus.getByRole("tab", { name: "阻断" }).click();
  await expect(page).toHaveURL(/status=blocked/);

  await page.goto("/v2/assets/media");
  const scope = page.getByRole("tablist", { name: "资产范围" });
  for (const label of ["日常项目", "未归属", "全部"]) await expect(scope.getByRole("tab", { name: label, exact: true })).toBeVisible();
  const mediaType = page.getByRole("tablist", { name: "媒体类型" });
  for (const label of ["全部", "图片", "视频"]) {
    await expect(mediaType.getByRole("tab", { name: label, exact: true })).toBeVisible();
  }
  await expect(page.getByLabel("角色")).toBeVisible();
  await expect(page.getByLabel("状态")).toBeVisible();
  await mediaType.getByRole("tab", { name: "视频" }).click();
  await expect(page).toHaveURL(/type=video/);
  await mediaType.getByRole("tab", { name: "全部" }).click();
  await expect(page).not.toHaveURL(/type=/);
  await scope.getByRole("tab", { name: "未归属" }).click();
  await expect(page).toHaveURL(/scope=unassigned/);
});

test("指挥台显示五项行动指标，治理页只预览不自动应用", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 911 });
  await page.goto("/v2/dashboard");
  for (const label of ["待确认", "阻断项目", "待审 SHOT", "生成中", "待交付"]) await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  await page.goto("/v2/system/governance");
  await expect(page.getByRole("heading", { name: "历史测试数据治理" })).toBeVisible();
  await expect(page.getByText("M0 测试项目", { exact: true })).toBeVisible();
  await expect(page.getByText("1 个候选", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认所选分组" })).toBeEnabled();
});

test("Legacy 页面和 API 已退出活动路径", async ({ page, request }) => {
  await page.goto("/v2/dashboard");
  await expect(page.getByRole("link", { name: "Legacy" })).toHaveCount(0);
  const pageResponse = await request.get("/legacy");
  expect(pageResponse.status()).toBe(404);
  await expect(pageResponse.json()).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  const mutationResponse = await request.post("/api/shots/update", { data: {} });
  expect(mutationResponse.status()).toBe(404);
  await expect(mutationResponse.json()).resolves.toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

for (const viewport of [
  { width: 1920, height: 911 },
  { width: 1166, height: 800 },
  { width: 820, height: 900 },
  { width: 390, height: 844 }
]) {
  test(`${viewport.width}x${viewport.height} 分镜布局无重叠和页面横向滚动`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const projectId = await firstActiveProjectId(request);
    await page.goto(`/v2/projects/${encodeURIComponent(projectId)}/storyboard`);
    await expect(page.locator('[class*="_threePane_"]')).toBeVisible({ timeout: 15_000 });

    const bodyMetrics = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(bodyMetrics.scrollWidth).toBe(bodyMetrics.clientWidth);

    const panes = await Promise.all([
      page.locator('[class*="_threePane_"] > [class*="_queuePane_"]').boundingBox(),
      page.locator('[class*="_threePane_"] > [class*="_detailPane_"]').boundingBox(),
      page.locator('[class*="_threePane_"] > [class*="_evidencePane_"]').boundingBox()
    ]);
    expect(panes.every(Boolean)).toBeTruthy();
    const rectangles = panes as Array<NonNullable<(typeof panes)[number]>>;
    for (const rectangle of rectangles) {
      expect(rectangle.x).toBeGreaterThanOrEqual(0);
      expect(rectangle.x + rectangle.width).toBeLessThanOrEqual(viewport.width + 1);
      expect(rectangle.height).toBeGreaterThan(0);
    }
    for (let left = 0; left < rectangles.length; left += 1) for (let right = left + 1; right < rectangles.length; right += 1) {
      const a = rectangles[left];
      const b = rectangles[right];
      const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
      const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
      expect(overlapWidth * overlapHeight).toBeLessThanOrEqual(1);
    }
  });
}
