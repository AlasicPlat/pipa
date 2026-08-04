import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appStyles = readFileSync(resolve(process.cwd(), "src/app/app.css"), "utf8");

describe("workspace overlay layering", () => {
  it("keeps topbar popovers above workspace content", () => {
    const topbarRule = appStyles.match(/\.workspace__topbar\s*\{(?<declarations>[^}]*)\}/u)?.groups?.declarations;

    expect(topbarRule).toContain("position: relative;");
    expect(topbarRule).toContain("z-index: 10;");
  });
});
