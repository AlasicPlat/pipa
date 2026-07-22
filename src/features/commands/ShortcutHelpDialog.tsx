import { RotateCcw, Search, Settings2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  getShortcutKeyLabels,
  isSafeShortcutBinding,
  normalizeShortcut,
  SHORTCUT_DEFINITIONS,
  shortcutFromKeyboardEvent,
  type ShortcutActionId,
  type ShortcutDefinition,
  useShortcutSettings,
} from "./shortcutRegistry";

export type ShortcutDialogView = "help" | "settings";

interface ShortcutHelpDialogProps {
  open: boolean;
  onClose: () => void;
  initialView?: ShortcutDialogView;
}

interface FixedShortcutItem {
  action: string;
  description: string;
  keys: readonly string[];
  searchTerms?: readonly string[];
}

interface ShortcutGroup {
  id: string;
  label: string;
  configurable: readonly ShortcutDefinition[];
  fixed: readonly FixedShortcutItem[];
}

const GROUP_LABELS = {
  workspace: "全局与工作区",
  sql: "SQL 查询",
  table: "表数据工作台",
} as const;

const FIXED_SHORTCUT_GROUPS: Readonly<Record<string, readonly FixedShortcutItem[]>> = {
  workspace: [
    { action: "退出当前操作", description: "逐层关闭菜单、弹窗、编辑或选择", keys: ["Escape"], searchTerms: ["Esc"] },
  ],
  sql: [],
  tree: [
    { action: "移动焦点", description: "在连接和数据表之间移动", keys: ["↑", "↓"], searchTerms: ["方向键", "上下"] },
    { action: "展开或收起连接", description: "展开连接或返回上一级", keys: ["→", "←"], searchTerms: ["方向键", "左右"] },
    { action: "打开焦点对象", description: "展开连接或打开数据表", keys: ["Enter"] },
    { action: "收起并返回连接", description: "从表列表收起当前连接", keys: ["Escape"], searchTerms: ["Esc"] },
    { action: "打开上下文菜单", description: "显示连接的次要与危险操作", keys: ["Shift", "F10"], searchTerms: ["右键", "菜单"] },
  ],
  table: [
    { action: "切换焦点行选择", description: "选择或取消选择当前焦点行", keys: ["Space"], searchTerms: ["空格"] },
    { action: "扩展连续行选择", description: "向上或向下扩展选中范围", keys: ["Shift", "↑/↓"], searchTerms: ["方向键", "连续选择"] },
    { action: "确认单元格编辑", description: "保存到本地变更集，不直接提交数据库", keys: ["Enter"] },
    { action: "取消编辑或清除选择", description: "先取消单元格编辑，再次按下清除行选择", keys: ["Escape"], searchTerms: ["Esc"] },
  ],
};

/** Converts shortcut content into a case-insensitive string used by dialog search. */
function getShortcutSearchText(
  groupLabel: string,
  shortcut: Pick<ShortcutDefinition, "action" | "description" | "searchTerms">,
  keys: readonly string[],
): string {
  return [groupLabel, shortcut.action, shortcut.description, ...keys, ...(shortcut.searchTerms ?? [])]
    .join(" ")
    .toLocaleLowerCase();
}

/** Builds help groups from the central registry and the intentionally fixed navigation controls. */
function buildShortcutGroups(): ShortcutGroup[] {
  return [
    {
      id: "workspace",
      label: GROUP_LABELS.workspace,
      configurable: SHORTCUT_DEFINITIONS.filter((shortcut) => shortcut.group === "workspace"),
      fixed: FIXED_SHORTCUT_GROUPS.workspace ?? [],
    },
    {
      id: "sql",
      label: GROUP_LABELS.sql,
      configurable: SHORTCUT_DEFINITIONS.filter((shortcut) => shortcut.group === "sql"),
      fixed: FIXED_SHORTCUT_GROUPS.sql ?? [],
    },
    {
      id: "tree",
      label: "连接与表树",
      configurable: [],
      fixed: FIXED_SHORTCUT_GROUPS.tree ?? [],
    },
    {
      id: "table",
      label: GROUP_LABELS.table,
      configurable: SHORTCUT_DEFINITIONS.filter((shortcut) => shortcut.group === "table"),
      fixed: FIXED_SHORTCUT_GROUPS.table ?? [],
    },
  ];
}

/**
 * Displays searchable shortcut help and an opt-in editor backed by local persistence.
 * @param props - Visibility, close callback, and optional initial help/settings view.
 * @returns An accessible modal dialog when open, otherwise `null`.
 * Side effects: captures one keyboard combination while editing and persists valid changes.
 */
export function ShortcutHelpDialog({ open, onClose, initialView = "help" }: ShortcutHelpDialogProps) {
  const { bindings, resetAll, resetBinding, setBinding } = useShortcutSettings();
  const [view, setView] = useState<ShortcutDialogView>(initialView);
  const [query, setQuery] = useState("");
  const [recordingActionId, setRecordingActionId] = useState<ShortcutActionId | null>(null);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const shortcutGroups = useMemo(buildShortcutGroups, []);
  const visibleGroups = useMemo(() => shortcutGroups.map((group) => ({
    ...group,
    configurable: group.configurable.filter((shortcut) => getShortcutSearchText(
      group.label,
      shortcut,
      getShortcutKeyLabels(bindings[shortcut.id]),
    ).includes(normalizedQuery)),
    fixed: view === "settings" ? [] : group.fixed.filter((shortcut) => getShortcutSearchText(
      group.label,
      shortcut,
      shortcut.keys,
    ).includes(normalizedQuery)),
  })).filter((group) => group.configurable.length > 0 || group.fixed.length > 0), [bindings, normalizedQuery, shortcutGroups, view]);
  const hasCustomBindings = SHORTCUT_DEFINITIONS.some(
    (definition) => normalizeShortcut(bindings[definition.id]) !== normalizeShortcut(definition.defaultBinding),
  );

  useEffect(() => {
    if (!open) {
      setQuery("");
      setRecordingActionId(null);
      setRecordingError(null);
      return;
    }
    setView(initialView);
  }, [initialView, open]);

  useEffect(() => {
    if (!open) return undefined;

    /** Closes the active layer or records a valid, non-conflicting keyboard combination. */
    function handleKeyDown(event: KeyboardEvent): void {
      if (!recordingActionId) {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecordingActionId(null);
        setRecordingError(null);
        return;
      }
      const binding = shortcutFromKeyboardEvent(event);
      if (!binding) return;
      if (!setBinding(recordingActionId, binding)) {
        const conflict = SHORTCUT_DEFINITIONS.find((definition) => (
          definition.id !== recordingActionId
          && normalizeShortcut(bindings[definition.id]) === normalizeShortcut(binding)
        ));
        setRecordingError(conflict
          ? `与“${conflict.action}”快捷键冲突`
          : isSafeShortcutBinding(binding) ? "该快捷键不可用" : "请使用含 Ctrl/Cmd/Alt 的组合键，或 F1–F12");
        return;
      }
      setRecordingActionId(null);
      setRecordingError(null);
    }

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [bindings, onClose, open, recordingActionId, setBinding]);

  if (!open) return null;

  /** Switches between reference and settings without closing the modal. */
  function changeView(nextView: ShortcutDialogView): void {
    setView(nextView);
    setQuery("");
    setRecordingActionId(null);
    setRecordingError(null);
  }

  return (
    <div
      className="shortcut-help-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section aria-labelledby="shortcut-help-title" aria-modal="true" className="shortcut-help-dialog" role="dialog">
        <header className="shortcut-help-dialog__header">
          <span>
            <span className="eyebrow">{view === "settings" ? "SHORTCUT SETTINGS" : "KEYBOARD SHORTCUTS"}</span>
            <h2 id="shortcut-help-title">{view === "settings" ? "快捷键设置" : "快捷键帮助"}</h2>
          </span>
          <span className="shortcut-help-dialog__actions">
            <button
              className="shortcut-help-dialog__mode"
              onClick={() => changeView(view === "help" ? "settings" : "help")}
              type="button"
            >
              <Settings2 aria-hidden="true" size={14} />
              {view === "help" ? "修改快捷键" : "返回帮助"}
            </button>
            <button
              aria-label={view === "settings" ? "关闭快捷键设置" : "关闭快捷键帮助"}
              className="shortcut-help-dialog__close"
              onClick={onClose}
              title="关闭（Escape）"
              type="button"
            >
              <X aria-hidden="true" size={17} />
            </button>
          </span>
        </header>

        <label className="shortcut-help-search">
          <Search aria-hidden="true" size={15} />
          <span className="sr-only">搜索快捷键</span>
          <input
            autoFocus
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={view === "settings" ? "搜索要修改的命令" : "搜索命令、按键或操作说明"}
            type="search"
            value={query}
          />
        </label>

        <div aria-live="polite" className="shortcut-help-dialog__content">
          {view === "settings" ? (
            <div className="shortcut-help-settings__toolbar">
              <p>点击按键组合后，直接按下新的快捷键。Esc 取消录入。</p>
              <button
                disabled={!hasCustomBindings}
                onClick={() => {
                  resetAll();
                  setRecordingActionId(null);
                  setRecordingError(null);
                }}
                type="button"
              >
                <RotateCcw aria-hidden="true" size={13} />
                全部恢复默认
              </button>
            </div>
          ) : null}
          {recordingError ? <p className="shortcut-help-settings__error" role="alert">{recordingError}</p> : null}
          {visibleGroups.length > 0 ? visibleGroups.map((group) => (
            <section aria-labelledby={`shortcut-help-group-${group.id}`} className="shortcut-help-group" key={group.id}>
              <h3 id={`shortcut-help-group-${group.id}`}>{group.label}</h3>
              <ul className="shortcut-help-list">
                {group.configurable.map((shortcut) => {
                  const keys = getShortcutKeyLabels(bindings[shortcut.id]);
                  const isRecording = recordingActionId === shortcut.id;
                  const isCustomized = normalizeShortcut(bindings[shortcut.id]) !== normalizeShortcut(shortcut.defaultBinding);
                  return (
                    <li className="shortcut-help-item" key={shortcut.id}>
                      <span className="shortcut-help-item__copy">
                        <strong>{shortcut.action}</strong>
                        <span>{shortcut.description}</span>
                      </span>
                      {view === "settings" ? (
                        <span className="shortcut-help-item__editor">
                          <button
                            aria-label={`修改${shortcut.action}`}
                            aria-pressed={isRecording}
                            className={`shortcut-help-item__record${isRecording ? " is-recording" : ""}`}
                            onClick={() => {
                              setRecordingActionId(shortcut.id);
                              setRecordingError(null);
                            }}
                            type="button"
                          >
                            {isRecording ? <span>请按下新组合键</span> : keys.map((key) => <kbd key={key}>{key}</kbd>)}
                          </button>
                          <button
                            aria-label={`恢复${shortcut.action}默认快捷键`}
                            disabled={!isCustomized}
                            onClick={() => {
                              if (resetBinding(shortcut.id)) {
                                setRecordingError(null);
                                return;
                              }
                              const defaultBinding = normalizeShortcut(shortcut.defaultBinding);
                              const conflict = SHORTCUT_DEFINITIONS.find((definition) => (
                                definition.id !== shortcut.id
                                && normalizeShortcut(bindings[definition.id]) === defaultBinding
                              ));
                              setRecordingError(conflict
                                ? `默认快捷键已被“${conflict.action}”占用，请先修改该命令`
                                : "无法恢复默认快捷键");
                            }}
                            type="button"
                          >
                            恢复默认
                          </button>
                        </span>
                      ) : (
                        <span aria-label={keys.join(" + ")} className="shortcut-help-item__keys">
                          {keys.map((key) => <kbd key={key}>{key}</kbd>)}
                        </span>
                      )}
                    </li>
                  );
                })}
                {group.fixed.map((shortcut) => (
                  <li className="shortcut-help-item" key={`${group.id}-${shortcut.action}`}>
                    <span className="shortcut-help-item__copy">
                      <strong>{shortcut.action}</strong>
                      <span>{shortcut.description}</span>
                    </span>
                    <span aria-label={shortcut.keys.join(" + ")} className="shortcut-help-item__keys">
                      {shortcut.keys.map((key) => <kbd key={key}>{key}</kbd>)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )) : <p className="shortcut-help-empty">没有匹配的快捷键</p>}
        </div>
      </section>
    </div>
  );
}
