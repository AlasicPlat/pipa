import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateControl } from "./UpdateControl";

const runtime = vi.hoisted(() => ({ tauri: true }));
const updater = vi.hoisted(() => ({ check: vi.fn() }));
const processPlugin = vi.hoisted(() => ({ relaunch: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => runtime.tauri }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: updater.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: processPlugin.relaunch }));

/**
 * Creates the minimal native update resource exercised by the update control.
 * Parameters: none.
 * @returns A deterministic signed-update test double.
 * Side effects: creates fresh mock functions for one test.
 */
function createUpdate() {
  return {
    version: "0.2.7",
    currentVersion: "0.2.6",
    body: "修复工作区切换时查询结果丢失的问题。",
    close: vi.fn().mockResolvedValue(undefined),
    downloadAndInstall: vi.fn(async (onEvent: (event: unknown) => void) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 100 } });
      onEvent({ event: "Finished" });
    }),
  };
}

beforeEach(() => {
  runtime.tauri = true;
  updater.check.mockReset();
  processPlugin.relaunch.mockReset().mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("UpdateControl", () => {
  it("does not invoke native updater APIs in a browser preview", async () => {
    runtime.tauri = false;
    render(<UpdateControl />);

    await Promise.resolve();
    expect(updater.check).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "软件更新" })).not.toBeInTheDocument();
  });

  it("checks automatically and installs an available signed update", async () => {
    const update = createUpdate();
    updater.check.mockResolvedValue(update);
    render(<UpdateControl />);

    const trigger = await screen.findByRole("button", { name: "软件更新：发现 v0.2.7" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "下载、安装并重启" }));

    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(processPlugin.relaunch).toHaveBeenCalledTimes(1));
  });

  it("surfaces a check failure and permits a successful retry", async () => {
    updater.check.mockRejectedValueOnce(new Error("release endpoint unavailable"));
    render(<UpdateControl />);

    const trigger = await screen.findByRole("button", { name: "软件更新" });
    fireEvent.click(trigger);
    expect(await screen.findByRole("alert")).toHaveTextContent("release endpoint unavailable");

    updater.check.mockResolvedValueOnce(null);
    fireEvent.click(screen.getByRole("button", { name: /再次检查/ }));
    expect(await screen.findByText("已是最新版本")).toBeInTheDocument();
  });
});
