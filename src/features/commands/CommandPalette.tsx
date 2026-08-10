import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  TableActionMenu,
  tableTargetKey,
  type TableQuickAction,
} from "../tables/TableActionMenu";

export type CommandPaletteItemType = "command" | "connection" | "table" | "workspace";

export interface CommandPaletteItem {
  id: string;
  type: CommandPaletteItemType;
  label: string;
  detail?: string;
  keywords?: readonly string[];
  connectionId?: string;
  lastUsedAt?: number;
}

export interface CommandPaletteProps {
  initialConnectionId?: string | null;
  open: boolean;
  items: readonly CommandPaletteItem[];
  pinnedTableKeys?: ReadonlySet<string>;
  onClose: () => void;
  onRequestTableAction?: (
    connectionId: string,
    tableName: string,
    action: TableQuickAction,
  ) => void;
  onSelect: (item: CommandPaletteItem) => void;
}

interface CommandPaletteTableContextMenu {
  item: CommandPaletteItem;
  x: number;
  y: number;
}

interface RankedCommandPaletteItem {
  item: CommandPaletteItem;
  originalIndex: number;
  score: number;
}

interface CommandPaletteGroup {
  id: string;
  label: string;
  items: readonly CommandPaletteItem[];
}

const TYPE_LABELS: Record<CommandPaletteItemType, string> = {
  command: "命令",
  connection: "连接",
  table: "数据表",
  workspace: "工作区",
};

/** Normalizes human-entered search text while preserving Unicode characters such as table names in Chinese. */
function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().trim();
}

/**
 * Scores a candidate against a fuzzy query.
 * @param candidate - Text from a command label, detail, or keyword.
 * @param query - Normalized or raw user query.
 * @returns A higher score for stronger matches, or `null` when query characters do not appear in order.
 */
export function fuzzyMatchScore(candidate: string, query: string): number | null {
  const normalizedCandidate = normalizeSearchText(candidate);
  const normalizedQuery = normalizeSearchText(query);

  if (!normalizedQuery) return 0;
  if (!normalizedCandidate) return null;
  if (normalizedCandidate === normalizedQuery) return 1_000;
  if (normalizedCandidate.startsWith(normalizedQuery)) {
    return 850 - Math.min(normalizedCandidate.length - normalizedQuery.length, 100);
  }

  const substringIndex = normalizedCandidate.indexOf(normalizedQuery);
  if (substringIndex >= 0) {
    return 700 - Math.min(substringIndex * 4, 100) - Math.min(normalizedCandidate.length - normalizedQuery.length, 100);
  }

  let candidateIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let consecutiveMatches = 0;
  let boundaryMatches = 0;

  for (const queryCharacter of normalizedQuery) {
    const matchIndex = normalizedCandidate.indexOf(queryCharacter, candidateIndex);
    if (matchIndex < 0) return null;
    if (firstMatchIndex < 0) firstMatchIndex = matchIndex;
    if (matchIndex === previousMatchIndex + 1) consecutiveMatches += 1;
    if (matchIndex === 0 || /[\s_./:-]/u.test(normalizedCandidate[matchIndex - 1] ?? "")) {
      boundaryMatches += 1;
    }
    previousMatchIndex = matchIndex;
    candidateIndex = matchIndex + queryCharacter.length;
  }

  const span = previousMatchIndex - firstMatchIndex + 1;
  const gaps = span - normalizedQuery.length;
  return 400 + consecutiveMatches * 14 + boundaryMatches * 18 - gaps * 5 - firstMatchIndex * 2;
}

/**
 * Produces a stable relevance score for one palette item.
 * @param item - Searchable command palette item.
 * @param query - Current palette query.
 * @returns A weighted score, or `null` when no searchable field matches.
 */
export function scoreCommandPaletteItem(item: CommandPaletteItem, query: string): number | null {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  const fields = [
    { value: item.label, weight: 120 },
    { value: item.detail ?? "", weight: 40 },
    ...(item.keywords?.map((keyword) => ({ value: keyword, weight: 70 })) ?? []),
  ];
  const terms = normalizedQuery.split(/\s+/u);
  let totalScore = 0;
  for (const term of terms) {
    const termScores = fields
      .map((field) => {
        const score = fuzzyMatchScore(field.value, term);
        return score === null ? null : score + field.weight;
      })
      .filter((score): score is number => score !== null);
    if (termScores.length === 0) return null;
    totalScore += Math.max(...termScores);
  }
  return totalScore;
}

/**
 * Ranks matching items without mutating the input array.
 * @param items - Palette candidates in their source order.
 * @param query - Current user query.
 * @returns Matching items ordered by score, recency, and finally stable source order.
 */
export function rankCommandPaletteItems(
  items: readonly CommandPaletteItem[],
  query: string,
): CommandPaletteItem[] {
  const normalizedQuery = normalizeSearchText(query);
  return items
    .map((item, originalIndex): RankedCommandPaletteItem | null => {
      const score = scoreCommandPaletteItem(item, normalizedQuery);
      return score === null ? null : { item, originalIndex, score };
    })
    .filter((rankedItem): rankedItem is RankedCommandPaletteItem => rankedItem !== null)
    .sort((left, right) => {
      if (normalizedQuery && left.score !== right.score) return right.score - left.score;
      const recencyDifference = (right.item.lastUsedAt ?? 0) - (left.item.lastUsedAt ?? 0);
      if (recencyDifference !== 0) return recencyDifference;
      return left.originalIndex - right.originalIndex;
    })
    .map(({ item }) => item);
}

/** Groups ranked results while retaining the exact keyboard navigation order. */
function groupCommandPaletteItems(items: readonly CommandPaletteItem[], query: string): CommandPaletteGroup[] {
  const groupedItems = new Map<string, CommandPaletteGroup>();
  const hasQuery = normalizeSearchText(query).length > 0;

  items.forEach((item) => {
    const isRecent = !hasQuery && item.lastUsedAt !== undefined;
    const groupId = isRecent ? "recent" : item.type;
    const existingGroup = groupedItems.get(groupId);
    if (existingGroup) {
      groupedItems.set(groupId, { ...existingGroup, items: [...existingGroup.items, item] });
      return;
    }
    groupedItems.set(groupId, {
      id: groupId,
      label: isRecent ? "最近使用" : TYPE_LABELS[item.type],
      items: [item],
    });
  });

  return [...groupedItems.values()];
}

/**
 * Renders the global searchable command palette.
 * @param props - Visibility, optional initial connection scope, searchable items, and callbacks.
 * @returns An accessible modal palette when open, otherwise `null`.
 * Side effects: focuses the search input on open and invokes parent actions after selection or dismissal.
 */
export function CommandPalette({
  initialConnectionId = null,
  open,
  items,
  pinnedTableKeys = new Set(),
  onClose,
  onRequestTableAction,
  onSelect,
}: CommandPaletteProps) {
  const headingId = useId();
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const tableContextMenuItemRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  const [connectionFilter, setConnectionFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [tableContextMenu, setTableContextMenu] = useState<CommandPaletteTableContextMenu | null>(null);
  const connectionItems = useMemo(
    () => items.filter((item) => item.type === "connection" && item.connectionId),
    [items],
  );
  const filteredItems = useMemo(
    () => connectionFilter
      ? items.filter((item) => item.connectionId === connectionFilter)
      : items,
    [connectionFilter, items],
  );
  const rankedItems = useMemo(() => rankCommandPaletteItems(filteredItems, query), [filteredItems, query]);
  const groups = useMemo(() => groupCommandPaletteItems(rankedItems, query), [query, rankedItems]);
  const displayedItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const activeItem = displayedItems[activeIndex];

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setConnectionFilter(initialConnectionId ?? "");
    setActiveIndex(0);
    setTableContextMenu(null);
    inputRef.current?.focus();
  }, [initialConnectionId, open]);

  useEffect(() => {
    if (activeIndex >= displayedItems.length) setActiveIndex(Math.max(0, displayedItems.length - 1));
  }, [activeIndex, displayedItems.length]);

  useEffect(() => {
    if (!tableContextMenu) {
      return;
    }
    tableContextMenuItemRef.current?.focus();

    /**
     * Closes the table menu after an outside pointer action.
     * @param event - Document-level pointer event.
     * @returns Nothing (`void`).
     * Side effects: may clear the local table menu.
     */
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".command-palette-context-menu")) {
        setTableContextMenu(null);
      }
    }

    /**
     * Closes the table menu with Escape and returns focus to palette search.
     * @param event - Document-level keyboard event.
     * @returns Nothing (`void`).
     * Side effects: clears the local menu and schedules search focus restoration.
     */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        setTableContextMenu(null);
        window.requestAnimationFrame(() => inputRef.current?.focus());
      }
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [tableContextMenu]);

  /**
   * Opens table maintenance shortcuts at a pointer or keyboard anchor.
   * @param item - Active table palette result.
   * @param x - Viewport horizontal anchor.
   * @param y - Viewport vertical anchor.
   * @returns Nothing (`void`).
   * Side effects: positions and opens the table action menu.
   */
  function openTableContextMenu(item: CommandPaletteItem, x: number, y: number): void {
    if (item.type !== "table" || !item.connectionId || !onRequestTableAction) {
      return;
    }
    const menuWidth = 220;
    const menuHeight = 390;
    setTableContextMenu({
      item,
      x: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    });
  }

  /**
   * Sends one table action to the parent-owned confirmation flow.
   * @param action - Requested table shortcut.
   * @returns Nothing (`void`).
   * Side effects: closes the local menu and invokes the parent callback.
   */
  function requestTableAction(action: TableQuickAction): void {
    const item = tableContextMenu?.item;
    if (!item?.connectionId) {
      return;
    }
    setTableContextMenu(null);
    onRequestTableAction?.(item.connectionId, item.label, action);
  }

  /** Selects an item and lets the parent close any palette-owned global state. */
  const selectItem = (item: CommandPaletteItem): void => {
    onSelect(item);
    onClose();
  };

  /** Handles all palette navigation while keeping keyboard focus in the search field. */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      && activeItem?.type === "table"
    ) {
      event.preventDefault();
      const bounds = document.getElementById(`${listboxId}-${activeItem.id}`)?.getBoundingClientRect();
      openTableContextMenu(activeItem, bounds?.left ?? 8, bounds?.bottom ?? 8);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (displayedItems.length === 0) return;
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((currentIndex) => (currentIndex + direction + displayedItems.length) % displayedItems.length);
      return;
    }
    if (event.key === "Enter" && activeItem) {
      event.preventDefault();
      selectItem(activeItem);
    }
  };

  if (!open) return null;

  return (
    <div className="command-palette-backdrop" onMouseDown={onClose}>
      <section
        aria-labelledby={headingId}
        aria-modal="true"
        className="command-palette"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <h2 className="sr-only" id={headingId}>快速打开</h2>
        <label className="command-palette__search">
          <span aria-hidden="true" className="command-palette__search-icon">⌕</span>
          <input
            aria-activedescendant={activeItem ? `${listboxId}-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            aria-controls={listboxId}
            aria-expanded="true"
            aria-label="搜索连接、数据表、工作区或命令"
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={handleKeyDown}
            placeholder="快速打开连接、表或执行命令…"
            ref={inputRef}
            role="combobox"
            spellCheck="false"
            type="search"
            value={query}
          />
          <kbd>Esc</kbd>
        </label>

        {connectionItems.length > 0 ? (
          <label className="command-palette__connection-filter">
            <span>连接范围</span>
            <select
              aria-label="按连接过滤"
              onChange={(event) => {
                setConnectionFilter(event.target.value);
                setActiveIndex(0);
              }}
              value={connectionFilter}
            >
              <option value="">全部连接</option>
              {connectionItems.map((item) => (
                <option key={item.id} value={item.connectionId}>
                  {item.label}{item.detail ? ` · ${item.detail}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <div aria-label="命令面板结果" className="command-palette__results" id={listboxId} role="listbox">
          {groups.map((group) => (
            <section aria-labelledby={`${listboxId}-${group.id}-heading`} key={group.id} role="group">
              <h3 id={`${listboxId}-${group.id}-heading`}>{group.label}</h3>
              {group.items.map((item) => {
                const itemIndex = displayedItems.indexOf(item);
                const isActive = itemIndex === activeIndex;
                return (
                  <button
                    aria-selected={isActive}
                    className={`command-palette__option${isActive ? " is-active" : ""}`}
                    id={`${listboxId}-${item.id}`}
                    key={item.id}
                    onClick={() => selectItem(item)}
                    onContextMenu={(event) => {
                      if (item.type !== "table" || !item.connectionId || !onRequestTableAction) {
                        return;
                      }
                      event.preventDefault();
                      setActiveIndex(itemIndex);
                      openTableContextMenu(item, event.clientX, event.clientY);
                    }}
                    onMouseEnter={() => setActiveIndex(itemIndex)}
                    role="option"
                    tabIndex={-1}
                    type="button"
                  >
                    <span className="command-palette__option-type">{TYPE_LABELS[item.type]}</span>
                    <span className="command-palette__option-copy">
                      <strong>{item.label}</strong>
                      {item.detail ? <small>{item.detail}</small> : null}
                    </span>
                    <span aria-hidden="true" className="command-palette__enter-hint">↵</span>
                  </button>
                );
              })}
            </section>
          ))}
          {rankedItems.length === 0 ? (
            <p className="command-palette__empty" role="status">
              没有匹配结果
              <small>尝试输入连接名、主机、数据库、表名或操作关键词</small>
            </p>
          ) : null}
        </div>

        <footer className="command-palette__footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> 移动</span>
          <span><kbd>↵</kbd> 打开</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </footer>
      </section>
      {tableContextMenu ? (
        <TableActionMenu
          className="command-palette-context-menu"
          firstItemRef={tableContextMenuItemRef}
          onMouseDown={(event) => event.stopPropagation()}
          onAction={requestTableAction}
          pinned={pinnedTableKeys.has(tableTargetKey(
            tableContextMenu.item.connectionId ?? "",
            tableContextMenu.item.label,
          ))}
          style={{ left: tableContextMenu.x, top: tableContextMenu.y }}
          tableName={tableContextMenu.item.label}
        />
      ) : null}
    </div>
  );
}
