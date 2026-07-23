import { useSyncExternalStore } from "react";

export type ShortcutScope = "global" | "workspace" | "sql" | "contextual" | "table";

export type ShortcutActionId =
  | "commandPalette"
  | "shortcutHelp"
  | "toggleSidebar"
  | "newQuery"
  | "closeWorkspace"
  | "nextWorkspace"
  | "previousWorkspace"
  | "executeQuery"
  | "cancelQuery"
  | "selectSql"
  | "find"
  | "copyResultSelection"
  | "viewResultCell"
  | "selectRows"
  | "saveTable";

export type ShortcutBindings = Readonly<Record<ShortcutActionId, string>>;

export interface ShortcutDefinition {
  id: ShortcutActionId;
  scope: ShortcutScope;
  group: "workspace" | "sql" | "table";
  action: string;
  description: string;
  defaultBinding: string;
  searchTerms?: readonly string[];
}

export interface ShortcutConflict {
  actionId: ShortcutActionId;
  conflictingActionId: ShortcutActionId;
  binding: string;
}

export interface KeyboardShortcutEvent {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

export interface ShortcutSettings {
  bindings: ShortcutBindings;
  conflicts: readonly ShortcutConflict[];
  resetAll: () => void;
  resetBinding: (actionId: ShortcutActionId) => boolean;
  setBinding: (actionId: ShortcutActionId, binding: string) => boolean;
}

const SHORTCUT_STORAGE_KEY = "pipa.shortcut-bindings.v1";
const MODIFIER_ORDER = ["Mod", "Ctrl", "Alt", "Shift"] as const;
const MODIFIER_KEYS = new Set(["Alt", "Control", "Meta", "Shift"]);

export const SHORTCUT_DEFINITIONS: readonly ShortcutDefinition[] = [
  {
    id: "commandPalette",
    scope: "global",
    group: "workspace",
    action: "打开命令面板",
    description: "搜索连接、数据表、工作区和可用命令",
    defaultBinding: "Mod+Shift+P",
    searchTerms: ["快速打开", "palette"],
  },
  {
    id: "shortcutHelp",
    scope: "global",
    group: "workspace",
    action: "打开快捷键帮助",
    description: "查看或修改全部键盘操作",
    defaultBinding: "Mod+/",
    searchTerms: ["设置", "keyboard", "hotkey"],
  },
  {
    id: "toggleSidebar",
    scope: "global",
    group: "workspace",
    action: "切换连接侧边栏",
    description: "收起或展开左侧连接导航，写作时腾出工作区",
    defaultBinding: "Mod+B",
    searchTerms: ["收起", "展开", "sidebar", "panel"],
  },
  {
    id: "newQuery",
    scope: "workspace",
    group: "workspace",
    action: "新建 SQL",
    description: "在当前 MySQL 连接中新建查询工作区",
    defaultBinding: "Mod+T",
  },
  {
    id: "closeWorkspace",
    scope: "workspace",
    group: "workspace",
    action: "关闭当前工作区",
    description: "有未提交表变更时会先确认",
    defaultBinding: "Mod+W",
  },
  {
    id: "nextWorkspace",
    scope: "workspace",
    group: "workspace",
    action: "切换到下一个工作区",
    description: "在已打开的查询和表工作区间循环",
    defaultBinding: "Ctrl+Tab",
  },
  {
    id: "previousWorkspace",
    scope: "workspace",
    group: "workspace",
    action: "切换到上一个工作区",
    description: "反向循环已打开的工作区",
    defaultBinding: "Ctrl+Shift+Tab",
  },
  {
    id: "executeQuery",
    scope: "sql",
    group: "sql",
    action: "执行 SQL",
    description: "执行选中 SQL；无选区时执行当前语句",
    defaultBinding: "Mod+R",
  },
  {
    id: "cancelQuery",
    scope: "sql",
    group: "sql",
    action: "取消当前查询",
    description: "仅在查询运行时生效",
    defaultBinding: "Mod+.",
    searchTerms: ["停止"],
  },
  {
    id: "selectSql",
    scope: "sql",
    group: "sql",
    action: "选中当前 SQL",
    description: "仅在 SQL 编辑器聚焦时生效",
    defaultBinding: "Mod+L",
    searchTerms: ["全选"],
  },
  {
    id: "find",
    scope: "contextual",
    group: "workspace",
    action: "搜索当前区域",
    description: "搜索当前聚焦的 SQL、表树、查询结果或表数据",
    defaultBinding: "Mod+F",
    searchTerms: ["查找", "过滤", "结果"],
  },
  {
    id: "copyResultSelection",
    scope: "sql",
    group: "sql",
    action: "复制选中结果",
    description: "复制查询结果中当前选中的单元格；全选后复制全部",
    defaultBinding: "Mod+C",
    searchTerms: ["剪贴板", "拷贝", "单元格"],
  },
  {
    id: "viewResultCell",
    scope: "sql",
    group: "sql",
    action: "查看完整单元格",
    description: "打开查询结果中当前单元格的完整内容（长文本/JSON）",
    defaultBinding: "F2",
    searchTerms: ["详情", "弹窗", "展开"],
  },
  {
    id: "selectRows",
    scope: "table",
    group: "table",
    action: "选择全部行",
    description: "表数据选当前页；查询结果选全部已加载行",
    defaultBinding: "Mod+A",
    searchTerms: ["全选", "结果"],
  },
  {
    id: "saveTable",
    scope: "table",
    group: "table",
    action: "预览并提交变更",
    description: "打开变更预览；生产环境仍需二次确认",
    defaultBinding: "Mod+S",
    searchTerms: ["保存", "提交"],
  },
];

const SHORTCUT_DEFINITION_BY_ID = new Map(
  SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition]),
);

/** Returns a fresh bindings object so callers cannot mutate the registry defaults. */
export function getDefaultShortcutBindings(): ShortcutBindings {
  return Object.fromEntries(
    SHORTCUT_DEFINITIONS.map((definition) => [definition.id, definition.defaultBinding]),
  ) as Record<ShortcutActionId, string>;
}

/** Converts browser key names into stable, human-readable binding tokens. */
function normalizePrimaryKey(key: string): string | null {
  if (!key || MODIFIER_KEYS.has(key)) return null;
  if (key === " ") return "Space";
  if (key === "Esc") return "Escape";
  if (key === "Spacebar") return "Space";
  if (key === "Del") return "Delete";
  if (key === "ArrowUp" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowRight") return key;
  if (key.length === 1 && /[a-z]/iu.test(key)) return key.toUpperCase();
  if (key.length === 1) return key;
  return `${key[0]?.toUpperCase() ?? ""}${key.slice(1)}`;
}

/**
 * Creates a canonical shortcut string from a keyboard event.
 * @param event - Keyboard event or the subset used by tests and native adapters.
 * @returns A canonical binding such as `Mod+Shift+P`, or `null` for modifier-only input.
 */
export function shortcutFromKeyboardEvent(event: KeyboardShortcutEvent): string | null {
  const primaryKey = normalizePrimaryKey(event.key);
  if (!primaryKey) return null;

  const modifiers: string[] = [];
  if (event.metaKey) modifiers.push("Mod");
  if (event.ctrlKey) modifiers.push("Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  return [...modifiers, primaryKey].join("+");
}

/** Normalizes a persisted or programmatic binding and rejects incomplete input. */
export function normalizeShortcut(binding: string): string | null {
  const rawTokens = binding.split("+").map((token) => token.trim()).filter(Boolean);
  const primaryToken = rawTokens.find((token) => !["mod", "cmd", "meta", "ctrl", "control", "alt", "option", "shift"].includes(token.toLocaleLowerCase()));
  if (!primaryToken) return null;

  const modifiers = new Set<string>();
  rawTokens.forEach((token) => {
    const normalizedToken = token.toLocaleLowerCase();
    if (["mod", "cmd", "meta"].includes(normalizedToken)) modifiers.add("Mod");
    if (["ctrl", "control"].includes(normalizedToken)) modifiers.add("Ctrl");
    if (["alt", "option"].includes(normalizedToken)) modifiers.add("Alt");
    if (normalizedToken === "shift") modifiers.add("Shift");
  });
  const primaryKey = normalizePrimaryKey(primaryToken);
  if (!primaryKey) return null;
  return [...MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier)), primaryKey].join("+");
}

/** Rejects bare character bindings that would interfere with ordinary SQL and search input. */
export function isSafeShortcutBinding(binding: string): boolean {
  const normalizedBinding = normalizeShortcut(binding);
  if (!normalizedBinding) return false;
  const tokens = normalizedBinding.split("+");
  const primaryKey = tokens[tokens.length - 1] ?? "";
  const hasCommandModifier = tokens.some((token) => token === "Mod" || token === "Ctrl" || token === "Alt");
  return hasCommandModifier || /^F(?:[1-9]|1[0-2])$/u.test(primaryKey);
}

/** Checks whether a DOM keyboard event matches a canonical user binding. */
export function matchesShortcut(event: KeyboardShortcutEvent, binding: string): boolean {
  const normalizedBinding = normalizeShortcut(binding);
  if (!normalizedBinding) return false;
  const tokens = normalizedBinding.split("+");
  const primaryKey = tokens[tokens.length - 1];
  const eventPrimaryKey = normalizePrimaryKey(event.key);
  if (primaryKey !== eventPrimaryKey) return false;

  const usesMod = tokens.includes("Mod");
  const expectsCtrl = tokens.includes("Ctrl");
  const expectsAlt = tokens.includes("Alt");
  const expectsShift = tokens.includes("Shift");
  const modMatches = usesMod ? event.metaKey || event.ctrlKey : !event.metaKey;
  const ctrlMatches = usesMod
    ? expectsCtrl ? event.ctrlKey : !(event.metaKey && event.ctrlKey)
    : event.ctrlKey === expectsCtrl;
  return modMatches && ctrlMatches && event.altKey === expectsAlt && event.shiftKey === expectsShift;
}

/** Converts a canonical web binding into the accelerator syntax accepted by Tauri menus. */
export function toTauriAccelerator(binding: string): string | null {
  const normalizedBinding = normalizeShortcut(binding);
  if (!normalizedBinding) return null;
  const tauriKeyNames: Record<string, string> = {
    ".": "Period",
    ",": "Comma",
    "/": "Slash",
    ";": "Semicolon",
    "'": "Quote",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    "-": "Minus",
    "=": "Equal",
    "`": "Backquote",
  };
  return normalizedBinding
    .split("+")
    .map((token) => token === "Mod" ? "CmdOrCtrl" : tauriKeyNames[token] ?? token)
    .join("+");
}

/** Converts a canonical binding into a synthetic DOM event for scoped command dispatch. */
export function shortcutToKeyboardEventInit(binding: string): KeyboardEventInit | null {
  const normalizedBinding = normalizeShortcut(binding);
  if (!normalizedBinding) return null;
  const tokens = normalizedBinding.split("+");
  const primaryKey = tokens[tokens.length - 1];
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/u.test(navigator.platform);
  const usesMod = tokens.includes("Mod");
  return {
    key: primaryKey === "Space" ? " " : primaryKey,
    metaKey: usesMod && isMac,
    ctrlKey: tokens.includes("Ctrl") || (usesMod && !isMac),
    altKey: tokens.includes("Alt"),
    shiftKey: tokens.includes("Shift"),
    bubbles: true,
    cancelable: true,
  };
}

/** Returns the display key caps used by help and settings surfaces. */
export function getShortcutKeyLabels(binding: string): string[] {
  const normalizedBinding = normalizeShortcut(binding);
  if (!normalizedBinding) return [];
  const labelByToken: Record<string, string> = {
    Mod: "Ctrl/Cmd",
    Ctrl: "Ctrl",
    Alt: "Alt",
    Shift: "Shift",
    ArrowUp: "↑",
    ArrowDown: "↓",
    ArrowLeft: "←",
    ArrowRight: "→",
    Escape: "Esc",
    Space: "Space",
  };
  return normalizedBinding.split("+").map((token) => labelByToken[token] ?? token);
}

/** Finds duplicate bindings globally so one physical event can never dispatch two actions. */
export function findShortcutConflicts(bindings: ShortcutBindings): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = [];
  SHORTCUT_DEFINITIONS.forEach((definition, index) => {
    SHORTCUT_DEFINITIONS.slice(index + 1).forEach((candidate) => {
      const binding = normalizeShortcut(bindings[definition.id]);
      if (binding && binding === normalizeShortcut(bindings[candidate.id])) {
        conflicts.push({
          actionId: definition.id,
          conflictingActionId: candidate.id,
          binding,
        });
      }
    });
  });
  return conflicts;
}

/** Restores defaults for missing or invalid persisted values without accepting unknown keys. */
function sanitizeShortcutBindings(value: unknown): ShortcutBindings {
  const defaults = getDefaultShortcutBindings();
  if (!value || typeof value !== "object") return defaults;
  const stored = value as Record<string, unknown>;
  return Object.fromEntries(SHORTCUT_DEFINITIONS.map((definition) => {
    const candidate = stored[definition.id];
    const normalized = typeof candidate === "string" ? normalizeShortcut(candidate) : null;
    return [definition.id, normalized && isSafeShortcutBinding(normalized) ? normalized : defaults[definition.id]];
  })) as Record<ShortcutActionId, string>;
}

/** Loads persisted shortcuts while keeping startup resilient to unavailable or malformed storage. */
function loadShortcutBindings(): ShortcutBindings {
  if (typeof window === "undefined") return getDefaultShortcutBindings();
  try {
    const serialized = window.localStorage.getItem(SHORTCUT_STORAGE_KEY);
    return serialized ? sanitizeShortcutBindings(JSON.parse(serialized)) : getDefaultShortcutBindings();
  } catch (error) {
    console.warn("[shortcuts] Failed to load shortcut settings; defaults are active.", { error });
    return getDefaultShortcutBindings();
  }
}

let currentBindings = loadShortcutBindings();
const shortcutListeners = new Set<() => void>();

/** Persists and broadcasts a complete shortcut snapshot to all mounted consumers. */
function publishShortcutBindings(bindings: ShortcutBindings): void {
  currentBindings = bindings;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(SHORTCUT_STORAGE_KEY, JSON.stringify(bindings));
    } catch (error) {
      console.warn("[shortcuts] Failed to persist shortcut settings; changes remain active for this session.", { error });
    }
  }
  shortcutListeners.forEach((listener) => listener());
}

/** Subscribes a React consumer to in-process shortcut changes. */
function subscribeToShortcuts(listener: () => void): () => void {
  shortcutListeners.add(listener);
  return () => shortcutListeners.delete(listener);
}

/** Returns the current immutable shortcut snapshot. */
export function getShortcutBindings(): ShortcutBindings {
  return currentBindings;
}

/** Re-reads persisted state; intended for cross-window storage events and deterministic tests. */
export function reloadShortcutBindings(): void {
  currentBindings = loadShortcutBindings();
  shortcutListeners.forEach((listener) => listener());
}

/** Applies one safe normalized binding unless it is already assigned to another action. */
export function updateShortcutBinding(actionId: ShortcutActionId, binding: string): boolean {
  const normalized = normalizeShortcut(binding);
  const definition = SHORTCUT_DEFINITION_BY_ID.get(actionId);
  if (!normalized || !definition || !isSafeShortcutBinding(normalized)) return false;
  const hasConflict = SHORTCUT_DEFINITIONS.some((candidate) => (
    candidate.id !== actionId
    && normalizeShortcut(currentBindings[candidate.id]) === normalized
  ));
  if (hasConflict) return false;
  publishShortcutBindings({ ...currentBindings, [actionId]: normalized });
  return true;
}

/** Restores one action only when another customized action has not claimed its default. */
export function resetShortcutBinding(actionId: ShortcutActionId): boolean {
  const definition = SHORTCUT_DEFINITION_BY_ID.get(actionId);
  if (!definition) return false;
  const hasConflict = SHORTCUT_DEFINITIONS.some((candidate) => (
    candidate.id !== actionId
    && normalizeShortcut(currentBindings[candidate.id]) === normalizeShortcut(definition.defaultBinding)
  ));
  if (hasConflict) return false;
  publishShortcutBindings({ ...currentBindings, [actionId]: definition.defaultBinding });
  return true;
}

/** Restores every configurable action to its registry default. */
export function resetAllShortcutBindings(): void {
  publishShortcutBindings(getDefaultShortcutBindings());
}

/**
 * Exposes persisted shortcut settings to React components.
 * @returns Current bindings, conflicts, and mutation helpers.
 * Side effects: successful mutations update localStorage and notify all mounted consumers.
 */
export function useShortcutSettings(): ShortcutSettings {
  const bindings = useSyncExternalStore(subscribeToShortcuts, getShortcutBindings, getDefaultShortcutBindings);
  return {
    bindings,
    conflicts: findShortcutConflicts(bindings),
    resetAll: resetAllShortcutBindings,
    resetBinding: resetShortcutBinding,
    setBinding: updateShortcutBinding,
  };
}
