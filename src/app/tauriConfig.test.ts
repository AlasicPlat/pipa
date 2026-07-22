import { describe, expect, it } from "vitest";
import tauriConfig from "../../src-tauri/tauri.conf.json";

/** Verifies the native window opens above the fixed workspace layout floor. */
function assertUsableDefaultWindow(): void {
  const window = tauriConfig.app.windows[0];

  expect(window.width).toBeGreaterThanOrEqual(1280);
  expect(window.height).toBeGreaterThanOrEqual(800);
  expect(window.minWidth).toBeGreaterThan(900);
  expect(window.minHeight).toBeGreaterThanOrEqual(640);
}

describe("Tauri window configuration", () => {
  it("keeps default and minimum dimensions usable", assertUsableDefaultWindow);
});
