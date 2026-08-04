import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findSelectableTextSurface,
  handleScopedSelectAll,
  isAppSelectAllRegion,
  isNativeTextSelectTarget,
  selectTextSurfaceContents,
} from "./scopedSelectAll";

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("scopedSelectAll", () => {
  it("recognizes native text targets and app grid regions", () => {
    document.body.innerHTML = `
      <textarea id="sql"></textarea>
      <input id="check" type="checkbox" />
      <div class="monaco-editor"><textarea id="monaco"></textarea></div>
      <div class="editable-grid" tabindex="0" id="grid"></div>
      <div class="result-grid" tabindex="0" id="results"></div>
      <section class="query-results" id="results-pane"><button id="export">导出</button></section>
    `;
    expect(isNativeTextSelectTarget(document.getElementById("sql"))).toBe(true);
    expect(isNativeTextSelectTarget(document.getElementById("monaco"))).toBe(true);
    expect(isNativeTextSelectTarget(document.getElementById("check"))).toBe(false);
    expect(isAppSelectAllRegion(document.getElementById("grid"))).toBe(true);
    expect(isAppSelectAllRegion(document.getElementById("results"))).toBe(true);
    expect(isAppSelectAllRegion(document.getElementById("export"))).toBe(true);
  });

  it("selects only the marked DDL surface for Mod+A", () => {
    document.body.innerHTML = `
      <aside>sidebar</aside>
      <section data-selectable-block>
        <textarea data-selectable-surface id="ddl">CREATE TABLE t (id INT);</textarea>
      </section>
    `;
    const ddl = document.getElementById("ddl") as HTMLTextAreaElement;
    ddl.focus();
    const selectSpy = vi.spyOn(ddl, "select");
    const event = new KeyboardEvent("keydown", {
      key: "a",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: ddl });

    // Native textarea should not be intercepted.
    expect(handleScopedSelectAll(event, () => true)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("scopes Mod+A to a selectable block when focus is on the block chrome", () => {
    document.body.innerHTML = `
      <section data-selectable-block id="block" tabindex="0">
        <pre data-selectable-surface id="ddl">CREATE TABLE t (id INT);</pre>
      </section>
    `;
    const block = document.getElementById("block") as HTMLElement;
    const ddl = document.getElementById("ddl") as HTMLElement;
    block.focus();
    expect(findSelectableTextSurface(block)).toBe(ddl);

    const event = new KeyboardEvent("keydown", {
      key: "a",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: block });
    expect(handleScopedSelectAll(event, () => true)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(window.getSelection()?.toString()).toBe("CREATE TABLE t (id INT);");
  });

  it("prevents whole-page select-all outside text regions", () => {
    document.body.innerHTML = `<button id="tab">原始 DDL</button>`;
    const button = document.getElementById("tab") as HTMLButtonElement;
    button.focus();
    const event = new KeyboardEvent("keydown", {
      key: "a",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: button });
    expect(handleScopedSelectAll(event, () => true)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("blocks document select-all inside grids while leaving bubble handlers free", () => {
    document.body.innerHTML = `<div class="editable-grid" tabindex="0" id="grid"></div>`;
    const grid = document.getElementById("grid") as HTMLElement;
    grid.focus();
    const event = new KeyboardEvent("keydown", {
      key: "a",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "target", { value: grid });
    expect(handleScopedSelectAll(event, () => true)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it("selects textarea contents through the shared helper", () => {
    const textarea = document.createElement("textarea");
    textarea.value = "select 1;";
    document.body.append(textarea);
    selectTextSurfaceContents(textarea);
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
  });
});
