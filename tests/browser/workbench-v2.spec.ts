import { expect, test } from "@playwright/test";

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
  { width: 1536, height: 864 },
  { width: 1280, height: 720 }
]) {
  test(`${viewport.width}x${viewport.height} 分镜三栏无重叠和页面横向滚动`, async ({ page, request }) => {
    await page.setViewportSize(viewport);
    const response = await request.get("/api/v2/projects?limit=1&lifecycle=active");
    expect(response.ok()).toBeTruthy();
    const payload = await response.json() as { data: Array<{ project: { project_id: string } }> };
    const projectId = payload.data[0]?.project.project_id;
    expect(projectId).toBeTruthy();
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
    const [queue, detail, evidence] = panes as Array<NonNullable<(typeof panes)[number]>>;
    expect(queue.x + queue.width).toBeLessThanOrEqual(detail.x + 1);
    expect(detail.x + detail.width).toBeLessThanOrEqual(evidence.x + 1);
    expect(evidence.x + evidence.width).toBeLessThanOrEqual(viewport.width + 1);
  });
}
