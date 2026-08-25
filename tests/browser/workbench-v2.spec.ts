import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

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

async function firstActiveProjectId(request: APIRequestContext): Promise<string> {
  const response = await request.get("/api/v2/projects?limit=100&lifecycle=active&classification=all&query=Playwright%20Production%20Fixture");
  expect(response.ok()).toBeTruthy();
  const payload = await response.json() as { data: Array<{ project: { project_id: string; title: string } }> };
  const project = payload.data.find((item) => item.project.title === "Playwright Production Fixture")?.project;
  expect(project, "缺少 Playwright Production Fixture").toBeTruthy();
  return project!.project_id;
}

async function expectMainPageReady(page: Page, label: string): Promise<void> {
  if (label === "指挥台") await expect(page.getByRole("region", { name: "生产指标" })).toBeVisible();
  else if (label === "项目") await expect(page.locator('section[class*="_projectList_"]')).toBeVisible();
  else if (label === "收件箱" || label === "资产库") await expect(page.locator('[class*="_masterDetail_"]')).toBeVisible();
  else if (label === "Director") await expect(page.getByRole("region", { name: "Director 边界状态" })).toBeVisible();
  else if (label === "系统") await expect(page.getByRole("heading", { name: "单 SHOT 单次提交" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
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
    ["系统", "/v2/system/runninghub"],
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
  ["系统", "/v2/system/runninghub", "系统"]
] as const) {
  test(`${label}活动页通过 WCAG 2.2 A/AA 自动扫描`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expectMainPageReady(page, label);
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

test("项目选择器长列表保持活动选项可见且 ARIA 结构有效", async ({ page }) => {
  await page.route("**/api/v2/projects?scope=daily**", async (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      ok: true,
      data: Array.from({ length: 20 }, (_, index) => ({ project: { project_id: `picker_project_${index}`, title: `选择器项目 ${index + 1}` } })),
      meta: { limit: 20, offset: 0, total: 20, has_more: false }
    })
  }));
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto("/v2/assets/media");
  await expect(page.locator('[class*="_masterDetail_"]')).toBeVisible();
  const picker = page.getByRole("combobox", { name: "搜索项目名称或 ID" });
  await picker.focus();
  const listbox = page.getByRole("listbox", { name: "项目搜索结果" });
  await expect(listbox.getByRole("option")).toHaveCount(20);
  await picker.press("End");
  const activeId = await picker.getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();
  const activeOption = page.locator(`#${activeId}`);
  await expect(activeOption).toBeVisible();
  const bounds = await Promise.all([listbox.boundingBox(), activeOption.boundingBox()]);
  expect(bounds[0]).toBeTruthy();
  expect(bounds[1]).toBeTruthy();
  expect(bounds[1]!.y).toBeGreaterThanOrEqual(bounds[0]!.y);
  expect(bounds[1]!.y + bounds[1]!.height).toBeLessThanOrEqual(bounds[0]!.y + bounds[0]!.height + 1);
  await expectNoWcagViolations(page, "项目选择器长列表");
  await picker.press("Tab");
  await expect(listbox).toBeHidden();
});

test("五个项目页签使用真实 Workspace 投影并通过 WCAG 2.2 A/AA 自动扫描", async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const projectId = await firstActiveProjectId(request);
  for (const workspace of ["overview", "storyboard", "generation", "review", "delivery"] as const) {
    const response = await request.get(`/api/v2/projects/${encodeURIComponent(projectId)}/${workspace}`);
    expect(response.ok()).toBeTruthy();
    const payload = await response.json() as { data: { workspace: string; delivery?: { workflow_state?: string } } };
    expect(payload.data.workspace).toBe(workspace);
    await page.goto(`/v2/projects/${encodeURIComponent(projectId)}/${workspace}`);
    await expect(page.locator("#project-workspace-panel")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "项目工作区" }).getByRole("tab", { selected: true })).toBeVisible();
    if (workspace === "delivery" && payload.data.delivery?.workflow_state) {
      await expect(page.getByText(payload.data.delivery.workflow_state, { exact: true })).toBeVisible();
    }
    await expectNoWcagViolations(page, `项目页签 ${workspace}`);
  }
});

test("活动确认框和错误状态通过 WCAG 2.2 A/AA 自动扫描", async ({ page, request }) => {
  await page.setViewportSize({ width: 1166, height: 820 });
  await page.goto("/v2/projects");
  const createTrigger = page.getByRole("button", { name: "新建项目" });
  await createTrigger.click();
  const createDialog = page.getByRole("dialog", { name: "创建项目" });
  await expect(createDialog.getByLabel("项目名称", { exact: true })).toBeFocused();
  await expectNoWcagViolations(page, "创建项目确认框");
  await page.keyboard.press("Escape");
  await expect(createDialog).toBeHidden();
  await expect(createTrigger).toBeFocused();

  const projectId = await firstActiveProjectId(request);
  await page.goto(`/v2/projects/${encodeURIComponent(projectId)}/overview`);
  const nextActionTrigger = page.getByRole("button", { name: "指定下一步动作" });
  await nextActionTrigger.click();
  const nextActionDialog = page.getByRole("dialog", { name: "指定下一步动作" });
  await expect(nextActionDialog.getByLabel("下一步动作", { exact: true })).toBeFocused();
  await expectNoWcagViolations(page, "下一步动作确认框");
  await page.keyboard.press("Escape");
  await expect(nextActionDialog).toBeHidden();
  await expect(nextActionTrigger).toBeFocused();

  await page.route("**/api/v2/dashboard", async (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ ok: false, error: { code: "BROWSER_ACCESSIBILITY_ERROR", message: "受控错误状态" } })
  }));
  await page.goto("/v2/dashboard");
  await expect(page.getByRole("alert")).toBeVisible();
  await expectNoWcagViolations(page, "受控错误状态");
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
  await page.getByLabel("项目名称").fill("只验证分类门禁，不提交");
  await expect(createButton).toBeDisabled();
  await page.getByRole("dialog").getByRole("combobox", { name: /^项目分类/ }).selectOption("production");
  await expect(createButton).toBeEnabled();
  await page.getByRole("button", { name: "取消" }).click();
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
  await expect(page.getByText("固定测试夹具", { exact: true })).toBeVisible();
  await expect(page.getByText("0 个候选", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认所选分组" })).toBeDisabled();
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
