import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Modal, ProjectPicker, SegmentedTabs } from "./components";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.getElementById("root")?.remove();
});

describe("Workbench accessible interaction primitives", () => {
  it("implements roving tab focus, arrow activation, and panel ownership", async () => {
    function Harness() {
      const [active, setActive] = useState("first");
      return <>
        <SegmentedTabs ariaLabel="测试页签" panelId="test-panel" active={active} onChange={setActive} items={[{ id: "first", label: "第一" }, { id: "second", label: "第二" }, { id: "third", label: "第三" }]} />
        <div id="test-panel" role="tabpanel">内容</div>
      </>;
    }
    render(<Harness />);
    const first = screen.getByRole("tab", { name: "第一" });
    const second = screen.getByRole("tab", { name: "第二" });
    expect(first).toHaveAttribute("tabindex", "0");
    expect(second).toHaveAttribute("tabindex", "-1");
    expect(first).toHaveAttribute("aria-controls", "test-panel");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    await waitFor(() => expect(second).toHaveAttribute("aria-selected", "true"));
    await waitFor(() => expect(second).toHaveFocus());
    fireEvent.keyDown(second, { key: "End" });
    await waitFor(() => expect(screen.getByRole("tab", { name: "第三" })).toHaveFocus());
  });

  it("traps modal focus, makes the app inert, closes on Escape, and restores the trigger", async () => {
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
    function Harness() {
      const [open, setOpen] = useState(false);
      return <>
        <button onClick={() => setOpen(true)}>打开确认</button>
        {open && <Modal title="确认测试" onClose={() => setOpen(false)} footer={<button onClick={() => setOpen(false)}>确认</button>}><label>说明<input autoFocus /></label></Modal>}
      </>;
    }
    render(<Harness />, { container: root });
    const trigger = screen.getByRole("button", { name: "打开确认" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "确认测试" });
    expect(root).toHaveAttribute("inert");
    expect(screen.getByRole("textbox", { name: "说明" })).toHaveFocus();
    const confirm = screen.getByRole("button", { name: "确认" });
    confirm.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(root).not.toHaveAttribute("inert");
  });

  it("supports the complete combobox/listbox keyboard selection model", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      ok: true,
      data: [
        { project: { project_id: "project_a", title: "项目 A" } },
        { project: { project_id: "project_b", title: "项目 B" } }
      ],
      meta: { limit: 20, offset: 0, total: 2, has_more: false }
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
      const [value, setValue] = useState("");
      return <ProjectPicker value={value} onChange={setValue} />;
    }
    render(<QueryClientProvider client={queryClient}><Harness /></QueryClientProvider>);
    const combobox = screen.getByRole("combobox", { name: "搜索项目名称或 ID" });
    fireEvent.focus(combobox);
    expect(await screen.findByRole("option", { name: /项目 A/ })).toBeInTheDocument();
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    await waitFor(() => expect(combobox.getAttribute("aria-activedescendant")).toContain("option-1"));
    fireEvent.keyDown(combobox, { key: "Enter" });
    expect(combobox).toHaveValue("项目 B");
    expect(combobox).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(combobox, { key: "ArrowDown" });
    expect(combobox).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(combobox, { key: "Escape" });
    expect(combobox).toHaveAttribute("aria-expanded", "false");
  });
});
