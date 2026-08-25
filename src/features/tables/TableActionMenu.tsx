import {
  Braces,
  ChevronRight,
  ClipboardCopy,
  Copy,
  Database,
  Download,
  ExternalLink,
  FileCode2,
  FileJson,
  FileSpreadsheet,
  Pencil,
  Pin,
  PinOff,
  TableProperties,
  Trash2,
} from "lucide-react";
import { useState, type MouseEvent, type Ref } from "react";

export type TableQuickAction =
  | "copy_name"
  | "rename"
  | "duplicate"
  | "truncate"
  | "drop"
  | "toggle_pin"
  | "open_window"
  | "export_csv"
  | "export_json"
  | "export_sql"
  | "show_create"
  | "copy_create";

export type TableDestructiveAction = Extract<TableQuickAction, "truncate" | "drop">;

interface TableActionMenuProps {
  className?: string;
  firstItemRef?: Ref<HTMLButtonElement>;
  pinned: boolean;
  style?: { left: number; top: number };
  tableName: string;
  onAction: (action: TableQuickAction) => void;
  onMouseDown?: (event: MouseEvent<HTMLDivElement>) => void;
}

/**
 * Builds a collision-safe identity for one table inside one database on one connection.
 *
 * The database is part of the identity because a single connection can now browse several
 * schemas, and same-named tables in different schemas are unrelated objects.
 * @param connectionId - Saved connection identifier.
 * @param database - Schema that owns the table.
 * @param tableName - Exact database-reported table name.
 * @returns A stable local-preference key.
 * Side effects: none.
 */
export function tableTargetKey(
  connectionId: string,
  database: string,
  tableName: string,
): string {
  return `${connectionId}\u0000${database}\u0000${tableName}`;
}

/**
 * Builds the workspace tab identity for one table inside one database.
 * @param connectionId - Saved connection identifier.
 * @param database - Schema that owns the table.
 * @param tableName - Exact database-reported table name.
 * @returns A stable tab identifier.
 * Side effects: none.
 */
export function tableTabId(
  connectionId: string,
  database: string,
  tableName: string,
): string {
  return `${connectionId}\u0000${database}\u0000${tableName}`;
}

/**
 * Renders the shared table shortcut menu used by the navigator and command center.
 * @param props - Exact table identity, pin state, placement, focus target, and action callback.
 * @returns An accessible menu with a compact export submenu.
 * Side effects: toggles only local export-submenu state and invokes the requested parent action.
 */
export function TableActionMenu({
  className = "",
  firstItemRef,
  pinned,
  style,
  tableName,
  onAction,
  onMouseDown,
}: TableActionMenuProps) {
  const [exportOpen, setExportOpen] = useState(false);

  return (
    <div
      aria-label={`${tableName} 表操作`}
      className={`connection-context-menu table-action-menu ${className}`.trim()}
      onMouseDown={onMouseDown}
      role="menu"
      style={style}
    >
      <button onClick={() => onAction("copy_name")} ref={firstItemRef} role="menuitem" type="button">
        <ClipboardCopy size={13} aria-hidden="true" />
        复制表名
      </button>
      <button onClick={() => onAction("rename")} role="menuitem" type="button">
        <Pencil size={13} aria-hidden="true" />
        重命名表…
      </button>
      <button onClick={() => onAction("duplicate")} role="menuitem" type="button">
        <Copy size={13} aria-hidden="true" />
        复制表…
      </button>
      <span className="connection-context-menu__separator" role="separator" />
      <button onClick={() => onAction("truncate")} role="menuitem" type="button">
        <Database size={13} aria-hidden="true" />
        清空表…
      </button>
      <button
        className="connection-context-menu__danger"
        onClick={() => onAction("drop")}
        role="menuitem"
        type="button"
      >
        <Trash2 size={13} aria-hidden="true" />
        删除表…
      </button>
      <span className="connection-context-menu__separator" role="separator" />
      <button onClick={() => onAction("toggle_pin")} role="menuitem" type="button">
        {pinned ? <PinOff size={13} aria-hidden="true" /> : <Pin size={13} aria-hidden="true" />}
        {pinned ? "取消置顶" : "置顶表"}
      </button>
      <button onClick={() => onAction("open_window")} role="menuitem" type="button">
        <ExternalLink size={13} aria-hidden="true" />
        在新窗口中打开表
      </button>
      <span className="connection-context-menu__separator" role="separator" />
      <span className="table-action-menu__submenu">
        <button
          aria-expanded={exportOpen}
          aria-haspopup="menu"
          onClick={() => setExportOpen((current) => !current)}
          role="menuitem"
          type="button"
        >
          <Download size={13} aria-hidden="true" />
          导出
          <ChevronRight className="table-action-menu__chevron" size={13} aria-hidden="true" />
        </button>
        {exportOpen ? (
          <span aria-label={`${tableName} 导出格式`} className="table-action-menu__export-panel" role="menu">
            <button onClick={() => onAction("export_csv")} role="menuitem" type="button">
              <FileSpreadsheet size={13} aria-hidden="true" />
              导出 CSV…
            </button>
            <button onClick={() => onAction("export_json")} role="menuitem" type="button">
              <FileJson size={13} aria-hidden="true" />
              导出 JSON…
            </button>
            <button onClick={() => onAction("export_sql")} role="menuitem" type="button">
              <FileCode2 size={13} aria-hidden="true" />
              导出 SQL INSERT…
            </button>
          </span>
        ) : null}
      </span>
      <span className="connection-context-menu__separator" role="separator" />
      <button onClick={() => onAction("show_create")} role="menuitem" type="button">
        <TableProperties size={13} aria-hidden="true" />
        显示 CREATE TABLE 语法…
      </button>
      <button onClick={() => onAction("copy_create")} role="menuitem" type="button">
        <Braces size={13} aria-hidden="true" />
        拷贝 CREATE TABLE 语法
      </button>
    </div>
  );
}
