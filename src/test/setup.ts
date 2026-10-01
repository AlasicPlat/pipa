import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// JSDOM has no layout engine; scroll positioning is verified in the browser.
HTMLElement.prototype.scrollIntoView = vi.fn();
