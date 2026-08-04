import {
  Braces,
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Columns3,
  KeyRound,
  Plus,
  RefreshCw,
  Save,
  Search,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { AppError } from "../../bindings/AppError";
import type { CellValue } from "../../bindings/CellValue";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { applyTableMutations } from "../../lib/tauriClient";
import { getShortcutKeyLabels, matchesShortcut, useShortcutSettings } from "../commands/shortcutRegistry";
import { useQuerySession } from "../query/useQuerySession";
import { SelectableSqlBlock } from "./SelectableSqlBlock";
import {
  buildDdlStatements,
  buildTableMutationPlan,
  cellValueToEditable,
  columnDefaultValidationError,
  columnTypeValidationError,
  isStructureColumnEditable,
  mysqlUtf8Expression,
  quoteIdentifier,
  tableRowIdentity,
  type EditableCellValue,
  type StagedExistingRow,
  type TableColumnDefinition,
} from "./tableSql";

interface TableWorkspaceProps {
  profile: ConnectionProfile;
  tableName: string;
  onDirtyChange?: (dirty: boolean) => void;
}

interface TableIndexDefinition {
  name: string;
  unique: boolean;
  type: string;
  columns: string[];
  cardinality: string | null;
}

interface EditingCell {
  rowIndex: number;
  columnName: string;
  value: EditableCellValue;
}

type TableView = "data" | "structure" | "ddl";
type MutationKind = "ddl" | "dml";

const PAGE_SIZES = [20, 50, 100] as const;
const DATA_SELECTOR_WIDTH = 42;
const DATA_COLUMN_DEFAULT_WIDTH = 150;
const DATA_COLUMN_MIN_WIDTH = 80;

/** Converts a transport-safe cell into exact text while retaining SQL NULL. */
function schemaCell(cell: CellValue | undefined): string | null {
  return cellValueToEditable(cell);
}

/** Converts INFORMATION_SCHEMA column rows into the visual schema model. */
function parseSchemaRows(rows: CellValue[][]): TableColumnDefinition[] {
  return rows.map((row) => {
    const name = schemaCell(row[0]) ?? "";
    return {
      sourceName: name,
      name,
      type: schemaCell(row[1]) ?? "varchar(255)",
      nullable: schemaCell(row[2]) === "YES",
      defaultValue: schemaCell(row[3]),
      defaultExpression: /\bDEFAULT_GENERATED\b/iu.test(schemaCell(row[5]) ?? ""),
      primary: schemaCell(row[4]) === "PRI",
      extra: schemaCell(row[5]) ?? "",
      comment: schemaCell(row[6]) ?? "",
      characterSet: schemaCell(row[7]),
      collation: schemaCell(row[8]),
      generationExpression: schemaCell(row[9]) ?? "",
    };
  });
}

/** Parses an exact COUNT result without routing it through an unsafe JavaScript number. */
function parseRowCount(cell: CellValue | undefined, fallback: number): bigint {
  const value = schemaCell(cell);
  try {
    return value === null ? BigInt(fallback) : BigInt(value);
  } catch {
    return BigInt(fallback);
  }
}

/** Converts an unknown Tauri rejection into a stable display error. */
function toAppError(error: unknown): AppError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    typeof error.code === "string" &&
    typeof error.message === "string"
  ) {
    return error as AppError;
  }
  return {
    code: "internal",
    message: "数据提交失败，请重试。",
    technicalDetails: null,
    retryable: true,
  };
}

/** Groups ordered INFORMATION_SCHEMA statistics rows into table indexes. */
function parseIndexRows(rows: CellValue[][]): TableIndexDefinition[] {
  const indexes = new Map<string, TableIndexDefinition>();
  for (const row of rows) {
    const name = schemaCell(row[0]) ?? "";
    const index = indexes.get(name) ?? {
      name,
      unique: schemaCell(row[1]) === "0",
      type: schemaCell(row[4]) ?? "",
      columns: [],
      cardinality: schemaCell(row[5]),
    };
    const columnName = schemaCell(row[3]);
    const prefixLength = schemaCell(row[2]);
    if (columnName) {
      index.columns.push(prefixLength ? `${columnName}(${prefixLength})` : columnName);
    }
    indexes.set(name, index);
  }
  return [...indexes.values()];
}

/** Renders a connection-bound table with guarded DML, schema, indexes, and raw DDL. */
export function TableWorkspace({ profile, tableName, onDirtyChange }: TableWorkspaceProps) {
  const shortcuts = useShortcutSettings();
  const database = profile.database ?? "";
  const schemaSession = useQuerySession(profile.id, { recordHistory: false });
  const dataSession = useQuerySession(profile.id, { recordHistory: false });
  const ddlSession = useQuerySession(profile.id, { recordHistory: false });
  const indexSession = useQuerySession(profile.id, { recordHistory: false });
  const countSession = useQuerySession(profile.id, { recordHistory: false });
  const mutationSession = useQuerySession(profile.id);
  const [activeView, setActiveView] = useState<TableView>("data");
  const [schema, setSchema] = useState<TableColumnDefinition[]>([]);
  const [draftColumns, setDraftColumns] = useState<TableColumnDefinition[]>([]);
  const [updatedRows, setUpdatedRows] = useState<Map<string, StagedExistingRow>>(new Map());
  const [deletedRows, setDeletedRows] = useState<Map<string, readonly CellValue[]>>(new Map());
  const [insertedRows, setInsertedRows] = useState<Map<string, EditableCellValue>[]>([]);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [focusedRowIndex, setFocusedRowIndex] = useState(0);
  const [selectionAnchorIndex, setSelectionAnchorIndex] = useState<number | null>(null);
  const [editingCell, setEditingCell] = useState<EditingCell | null>(null);
  const [dataColumnWidths, setDataColumnWidths] = useState<(number | null)[]>([]);
  const [dataSearch, setDataSearch] = useState("");
  const [page, setPage] = useState(1n);
  const [pageSize, setPageSize] = useState<(typeof PAGE_SIZES)[number]>(50);
  const [pendingProductionAction, setPendingProductionAction] = useState<MutationKind | null>(null);
  const [dmlMutationRunning, setDmlMutationRunning] = useState(false);
  const [dmlMutationError, setDmlMutationError] = useState<AppError | null>(null);
  const loadedSchemaQueryRef = useRef<string | null>(null);
  const handledMutationQueryRef = useRef<string | null>(null);
  const mutationKindRef = useRef<MutationKind | null>(null);
  const dataSearchInputRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const resizeSessionRef = useRef<{ columnIndex: number; startX: number; startWidth: number } | null>(null);

  const target = `${quoteIdentifier(database)}.${quoteIdentifier(tableName)}`;
  const schemaSql = useMemo(
    () =>
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT, CHARACTER_SET_NAME, COLLATION_NAME, GENERATION_EXPRESSION\n` +
      `FROM INFORMATION_SCHEMA.COLUMNS\n` +
      `WHERE TABLE_SCHEMA = ${mysqlUtf8Expression(database)} AND TABLE_NAME = ${mysqlUtf8Expression(tableName)}\n` +
      "ORDER BY ORDINAL_POSITION;",
    [database, tableName],
  );
  const indexSql = useMemo(
    () =>
      `SELECT INDEX_NAME, NON_UNIQUE, SUB_PART, COLUMN_NAME, INDEX_TYPE, CARDINALITY\n` +
      `FROM INFORMATION_SCHEMA.STATISTICS\n` +
      `WHERE TABLE_SCHEMA = ${mysqlUtf8Expression(database)} AND TABLE_NAME = ${mysqlUtf8Expression(tableName)}\n` +
      "ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX;",
    [database, tableName],
  );

  /** Loads one page and clears selection/edit focus tied to the previous result snapshot. */
  function loadPage(
    nextPage: bigint,
    nextPageSize = pageSize,
    orderingSchema: readonly TableColumnDefinition[] = schema,
    allowDirty = false,
  ): void {
    if (
      !database ||
      dataSession.state.running ||
      (!allowDirty && (updatedRows.size > 0 || deletedRows.size > 0 || insertedRows.length > 0))
    ) {
      return;
    }
    const offset = (nextPage - 1n) * BigInt(nextPageSize);
    const primaryOrder = orderingSchema
      .filter((column) => column.primary)
      .map((column) => quoteIdentifier(column.name));
    const orderBy = primaryOrder.length > 0 ? ` ORDER BY ${primaryOrder.join(", ")}` : "";
    const selectList = orderingSchema.map((column) => quoteIdentifier(column.name)).join(", ");
    if (!selectList) {
      return;
    }
    setPage(nextPage);
    setSelectedRows(new Set());
    setFocusedRowIndex(0);
    setSelectionAnchorIndex(null);
    setEditingCell(null);
    void dataSession.run(`SELECT ${selectList} FROM ${target}${orderBy} LIMIT ${nextPageSize} OFFSET ${offset};`);
  }

  /** Loads structure, indexes, count, DDL, and the current data page. */
  function loadTable(): void {
    if (!database || updatedRows.size > 0 || deletedRows.size > 0 || insertedRows.length > 0 || JSON.stringify(schema) !== JSON.stringify(draftColumns)) {
      return;
    }
    if (!schemaSession.state.running) {
      void schemaSession.run(schemaSql);
    }
    if (!ddlSession.state.running) {
      void ddlSession.run(`SHOW CREATE TABLE ${target};`);
    }
    if (!indexSession.state.running) {
      void indexSession.run(indexSql);
    }
    if (!countSession.state.running) {
      void countSession.run(`SELECT COUNT(*) AS total_rows FROM ${target};`);
    }
  }

  useEffect(() => {
    loadTable();
  }, [database, tableName]);

  useEffect(() => {
    const queryId = schemaSession.state.queryId;
    if (!queryId || schemaSession.state.running || schemaSession.state.error || loadedSchemaQueryRef.current === queryId) {
      return;
    }
    loadedSchemaQueryRef.current = queryId;
    const nextSchema = parseSchemaRows(schemaSession.state.rows);
    setSchema(nextSchema);
    setDraftColumns(nextSchema.map((column) => ({ ...column })));
    loadPage(page, pageSize, nextSchema);
  }, [schemaSession.state]);

  useEffect(() => {
    const queryId = mutationSession.state.queryId;
    if (!queryId || mutationSession.state.running || mutationSession.state.error || handledMutationQueryRef.current === queryId) {
      return;
    }
    handledMutationQueryRef.current = queryId;
    if (mutationKindRef.current === "ddl") {
      void schemaSession.run(schemaSql);
      void ddlSession.run(`SHOW CREATE TABLE ${target};`);
      void indexSession.run(indexSql);
      void countSession.run(`SELECT COUNT(*) AS total_rows FROM ${target};`);
    }
    mutationKindRef.current = null;
  }, [mutationSession.state, page, pageSize, schemaSql, indexSql, target]);

  const indexes = useMemo(() => parseIndexRows(indexSession.state.rows), [indexSession.state.rows]);
  const totalRows = parseRowCount(countSession.state.rows[0]?.[0], dataSession.state.rows.length);
  const totalPages = totalRows === 0n ? 1n : (totalRows + BigInt(pageSize) - 1n) / BigInt(pageSize);
  const primaryColumns = schema.filter((column) => column.primary).map((column) => column.name);
  const rawDdl = schemaCell(ddlSession.state.rows[0]?.[1]) ?? "";
  const dmlChangeCount = updatedRows.size + deletedRows.size + insertedRows.length;
  const hasDmlChanges = dmlChangeCount > 0;
  const allRowsSelected = dataSession.state.rows.length > 0 && selectedRows.size === dataSession.state.rows.length;
  const dataColumnKey = dataSession.state.columns.map((column) => column.name).join("\u0000");
  const hasResizedDataColumn = dataSession.state.columns.some((_, index) => dataColumnWidths[index] !== null && dataColumnWidths[index] !== undefined);
  const dataGridTemplate = hasResizedDataColumn
    ? [
        `${DATA_SELECTOR_WIDTH}px`,
        ...dataSession.state.columns.map((_, index) => {
          const width = dataColumnWidths[index];
          return width === null || width === undefined ? `minmax(${DATA_COLUMN_DEFAULT_WIDTH}px, 1fr)` : `${width}px`;
        }),
      ].join(" ")
    : `${DATA_SELECTOR_WIDTH}px repeat(${dataSession.state.columns.length}, minmax(${DATA_COLUMN_DEFAULT_WIDTH}px, 1fr))`;
  const dataGridMinimumWidth = `${DATA_SELECTOR_WIDTH + dataSession.state.columns.reduce(
    (total, _, index) => total + (dataColumnWidths[index] ?? DATA_COLUMN_DEFAULT_WIDTH),
    0,
  )}px`;
  const editingColumn = editingCell
    ? dataSession.state.columns.find((column) => column.name === editingCell.columnName) ?? null
    : null;
  const editingSchemaColumn = editingCell
    ? schema.find((column) => column.name === editingCell.columnName) ?? null
    : null;
  const ddlStatements = useMemo(
    () => buildDdlStatements(database, tableName, schema, draftColumns),
    [database, draftColumns, schema, tableName],
  );
  const ddlValidationErrors = useMemo(() => draftColumns.flatMap((column) => {
    const original = column.sourceName === null
      ? null
      : schema.find((candidate) => candidate.name === column.sourceName) ?? null;
    if (original && !isStructureColumnEditable(original)) {
      return [];
    }
    const errors = [columnTypeValidationError(column.type), columnDefaultValidationError(column)]
      .filter((error): error is string => Boolean(error));
    return errors.map((error) => `${column.name || "未命名字段"}：${error}`);
  }), [draftColumns, schema]);
  const dmlPlan = useMemo(
    () => buildTableMutationPlan({
      database,
      table: tableName,
      queryColumns: dataSession.state.columns,
      schema,
      updatedRows,
      deletedRows,
      insertedRows,
    }),
    [dataSession.state.columns, dataSession.state.rows, database, deletedRows, insertedRows, schema, tableName, updatedRows],
  );
  const dmlStatements = dmlPlan.statements;
  const hasDirtyChanges = ddlStatements.length > 0 || ddlValidationErrors.length > 0 || hasDmlChanges;
  const normalizedDataSearch = dataSearch.trim().toLocaleLowerCase();
  const dataSearchMatchCount = normalizedDataSearch
    ? dataSession.state.rows.reduce((matchCount, row, rowIndex) => (
        matchCount + dataSession.state.columns.reduce((rowMatchCount, column, columnIndex) => (
          rowMatchCount + (cellMatchesDataSearch(rowIndex, column.name, row[columnIndex]) ? 1 : 0)
        ), 0)
      ), 0)
    : 0;

  useEffect(() => {
    onDirtyChange?.(hasDirtyChanges);
  }, [hasDirtyChanges, onDirtyChange]);

  useEffect(() => {
    setDataColumnWidths(dataSession.state.columns.map(() => null));
  }, [dataColumnKey]);

  useEffect(() => {
    /** Updates the active data-column width while its header edge is dragged. */
    function handlePointerMove(event: PointerEvent): void {
      const session = resizeSessionRef.current;
      if (!session) {
        return;
      }
      const nextWidth = Math.max(DATA_COLUMN_MIN_WIDTH, session.startWidth + event.clientX - session.startX);
      setDataColumnWidths((current) => {
        const next = dataSession.state.columns.map((_, index) => current[index] ?? null);
        next[session.columnIndex] = nextWidth;
        return next;
      });
    }

    /** Ends an active data-column resize gesture. */
    function handlePointerUp(): void {
      resizeSessionRef.current = null;
    }

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };
  }, [dataColumnKey]);

  /** Updates one field in the local visual schema draft. */
  function updateDraftColumn(index: number, field: keyof TableColumnDefinition, value: string | boolean | null): void {
    setPendingProductionAction(null);
    setDraftColumns((current) => current.map((column, columnIndex) => columnIndex === index ? { ...column, [field]: value } : column));
  }

  /** Adds a nullable VARCHAR column to the local schema draft. */
  function addDraftColumn(): void {
    setPendingProductionAction(null);
    setDraftColumns((current) => [...current, {
      sourceName: null,
      name: `new_column_${current.length + 1}`,
      type: "varchar(255)",
      nullable: true,
      defaultValue: null,
      defaultExpression: false,
      comment: "",
      primary: false,
      extra: "",
      characterSet: null,
      collation: null,
      generationExpression: "",
    }]);
  }

  /** Removes one field from the local schema draft. */
  function removeDraftColumn(index: number): void {
    setPendingProductionAction(null);
    setDraftColumns((current) => current.filter((_, columnIndex) => columnIndex !== index));
  }

  /** Stages one existing cell value without issuing SQL. */
  function updateExistingCell(rowIndex: number, columnName: string, value: EditableCellValue): void {
    const originalRow = dataSession.state.rows[rowIndex];
    const identity = originalRow
      ? tableRowIdentity(originalRow, dataSession.state.columns, primaryColumns)
      : "";
    if (!originalRow || !identity) {
      return;
    }
    setPendingProductionAction(null);
    setUpdatedRows((current) => {
      const next = new Map(current);
      const existing = next.get(identity);
      const rowUpdates = new Map(existing?.values ?? []);
      rowUpdates.set(columnName, value);
      next.set(identity, {
        originalRow: existing?.originalRow ?? [...originalRow],
        values: rowUpdates,
      });
      return next;
    });
  }

  /** Removes one cell override when its edited value returns to the database snapshot. */
  function revertExistingCell(rowIndex: number, columnName: string): void {
    const originalRow = dataSession.state.rows[rowIndex];
    const identity = originalRow
      ? tableRowIdentity(originalRow, dataSession.state.columns, primaryColumns)
      : "";
    if (!identity) {
      return;
    }
    setUpdatedRows((current) => {
      const next = new Map(current);
      const existing = next.get(identity);
      const rowUpdates = new Map(existing?.values ?? []);
      rowUpdates.delete(columnName);
      if (rowUpdates.size === 0) {
        next.delete(identity);
      } else if (existing) {
        next.set(identity, { ...existing, values: rowUpdates });
      }
      return next;
    });
  }

  /** Opens a modal editor with the cell's current staged or database value. */
  function openCellEditor(rowIndex: number, columnName: string, value: EditableCellValue): void {
    setSelectedRows(new Set([rowIndex]));
    setEditingCell({ rowIndex, columnName, value });
  }

  /** Saves the modal value into the DML change set, removing no-op overrides. */
  function saveCellEdit(): void {
    if (!editingCell) {
      return;
    }
    const columnIndex = dataSession.state.columns.findIndex((column) => column.name === editingCell.columnName);
    const originalValue = cellValueToEditable(dataSession.state.rows[editingCell.rowIndex]?.[columnIndex]);
    if (editingCell.value === originalValue) {
      revertExistingCell(editingCell.rowIndex, editingCell.columnName);
    } else {
      updateExistingCell(editingCell.rowIndex, editingCell.columnName, editingCell.value);
    }
    setPendingProductionAction(null);
    setEditingCell(null);
  }

  /** Handles modal editor cancellation and the explicit Mod+Enter save gesture. */
  function handleCellEditorKeyDown(event: KeyboardEvent<HTMLFormElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setEditingCell(null);
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      saveCellEdit();
    }
  }

  /** Starts dragging one data-column edge from its rendered width. */
  function handleDataColumnResizeMouseDown(event: MouseEvent<HTMLSpanElement>, columnIndex: number): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const renderedWidth = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0;
    resizeSessionRef.current = {
      columnIndex,
      startX: event.clientX,
      startWidth: renderedWidth || dataColumnWidths[columnIndex] || DATA_COLUMN_DEFAULT_WIDTH,
    };
  }

  /** Returns the staged value when present, otherwise the database snapshot value. */
  function currentCellValue(rowIndex: number, columnName: string, cell: CellValue | undefined): EditableCellValue {
    const row = dataSession.state.rows[rowIndex];
    const identity = row ? tableRowIdentity(row, dataSession.state.columns, primaryColumns) : "";
    const stagedValues = identity ? updatedRows.get(identity)?.values : undefined;
    return stagedValues?.has(columnName) ? stagedValues.get(columnName) ?? null : cellValueToEditable(cell);
  }

  /** Returns whether one current-page cell contains the active case-insensitive search value. */
  function cellMatchesDataSearch(rowIndex: number, columnName: string, cell: CellValue | undefined): boolean {
    if (!normalizedDataSearch) {
      return false;
    }
    const value = currentCellValue(rowIndex, columnName, cell);
    return (value ?? "NULL").toLocaleLowerCase().includes(normalizedDataSearch);
  }

  /** Toggles one source row selection without changing its values. */
  function toggleSelectedRow(rowIndex: number): void {
    setSelectionAnchorIndex(rowIndex);
    setSelectedRows((current) => {
      const next = new Set(current);
      if (next.has(rowIndex)) {
        next.delete(rowIndex);
      } else {
        next.add(rowIndex);
      }
      return next;
    });
  }

  /** Selects or clears every row on the current page. */
  function toggleSelectAllRows(): void {
    setSelectionAnchorIndex(allRowsSelected || dataSession.state.rows.length === 0 ? null : 0);
    setSelectedRows(allRowsSelected ? new Set() : new Set(dataSession.state.rows.map((_, index) => index)));
  }

  /** Converts selected rows into a staged primary-key delete set. */
  function deleteSelectedRows(): void {
    if (primaryColumns.length === 0) {
      return;
    }
    setPendingProductionAction(null);
    setDeletedRows((current) => {
      const next = new Map(current);
      for (const rowIndex of selectedRows) {
        const row = dataSession.state.rows[rowIndex];
        const identity = row ? tableRowIdentity(row, dataSession.state.columns, primaryColumns) : "";
        if (row && identity) {
          next.set(identity, [...row]);
        }
      }
      return next;
    });
    setSelectedRows(new Set());
    setSelectionAnchorIndex(null);
  }

  /** Handles current-page row selection keys while preserving native controls. */
  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const targetElement = event.target as HTMLElement;
    const isTextEditor = targetElement.matches("input, textarea, [contenteditable='true']");
    if (matchesShortcut(event, shortcuts.bindings.selectRows) && !isTextEditor) {
      event.preventDefault();
      setSelectedRows(new Set(dataSession.state.rows.map((_, index) => index)));
      setSelectionAnchorIndex(dataSession.state.rows.length > 0 ? 0 : null);
      return;
    }
    if (targetElement.matches("input, textarea, select, button, [contenteditable='true']")) {
      return;
    }
    if (event.key === "Escape" && selectedRows.size > 0) {
      event.preventDefault();
      setSelectedRows(new Set());
      setSelectionAnchorIndex(null);
      return;
    }
    if ((event.key === " " || event.key === "Spacebar") && dataSession.state.rows.length > 0) {
      event.preventDefault();
      toggleSelectedRow(focusedRowIndex);
      rowRefs.current[focusedRowIndex]?.focus();
      return;
    }
    if (event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown") && dataSession.state.rows.length > 0) {
      event.preventDefault();
      const nextRowIndex = Math.max(0, Math.min(
        dataSession.state.rows.length - 1,
        focusedRowIndex + (event.key === "ArrowDown" ? 1 : -1),
      ));
      const anchorIndex = selectionAnchorIndex ?? focusedRowIndex;
      const rangeStart = Math.min(anchorIndex, nextRowIndex);
      const rangeEnd = Math.max(anchorIndex, nextRowIndex);
      setSelectionAnchorIndex(anchorIndex);
      setFocusedRowIndex(nextRowIndex);
      setSelectedRows(new Set(Array.from({ length: rangeEnd - rangeStart + 1 }, (_, index) => rangeStart + index)));
      rowRefs.current[nextRowIndex]?.focus();
    }
  }

  /** Selects a row when its non-interactive surface is clicked. */
  function handleRowClick(event: MouseEvent<HTMLDivElement>, rowIndex: number): void {
    if (!(event.target as HTMLElement).closest("button, input, select")) {
      setFocusedRowIndex(rowIndex);
      event.currentTarget.focus();
      toggleSelectedRow(rowIndex);
    }
  }

  /** Saves the relevant local change set without invoking the browser save dialog. */
  function handleWorkspaceKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (matchesShortcut(event, shortcuts.bindings.find) && activeView === "data") {
      event.preventDefault();
      dataSearchInputRef.current?.focus();
      dataSearchInputRef.current?.select();
      return;
    }
    if (!matchesShortcut(event, shortcuts.bindings.saveTable)) {
      return;
    }
    event.preventDefault();
    if (!hasDirtyChanges) {
      return;
    }
    if (activeView !== "data" && ddlStatements.length > 0 && ddlValidationErrors.length === 0) {
      commit("ddl");
    } else if (activeView === "data" && dmlStatements.length > 0 && dmlPlan.errors.length === 0) {
      commit("dml");
    } else if (dmlStatements.length > 0 && dmlPlan.errors.length === 0 && ddlStatements.length === 0) {
      commit("dml");
    } else if (ddlStatements.length > 0 && dmlStatements.length === 0) {
      commit("ddl");
    }
  }

  /** Adds a row with every column omitted so MySQL defaults remain active. */
  function addInsertedRow(): void {
    setPendingProductionAction(null);
    setInsertedRows((current) => [...current, new Map()]);
  }

  /** Updates one staged inserted-row cell. */
  function updateInsertedCell(rowIndex: number, columnName: string, value: EditableCellValue): void {
    setPendingProductionAction(null);
    setInsertedRows((current) => current.map((row, index) => {
      if (index !== rowIndex) {
        return row;
      }
      const next = new Map(row);
      next.set(columnName, value);
      return next;
    }));
  }

  /** Restores one inserted cell to database DEFAULT by omitting the column from the mutation. */
  function resetInsertedCellToDefault(rowIndex: number, columnName: string): void {
    setPendingProductionAction(null);
    setInsertedRows((current) => current.map((row, index) => {
      if (index !== rowIndex) {
        return row;
      }
      const next = new Map(row);
      next.delete(columnName);
      return next;
    }));
  }

  /** Removes one staged insert and invalidates any prior production confirmation. */
  function removeInsertedRow(rowIndex: number): void {
    setPendingProductionAction(null);
    setInsertedRows((current) => current.filter((_, index) => index !== rowIndex));
  }

  /** Executes reviewed DDL or a typed parameterized DML transaction after production confirmation. */
  function commit(kind: MutationKind): void {
    const statements = kind === "ddl" ? ddlStatements : dmlStatements;
    if (
      statements.length === 0 ||
      mutationSession.state.running ||
      dmlMutationRunning ||
      (kind === "dml" && dmlPlan.errors.length > 0) ||
      (kind === "ddl" && ddlValidationErrors.length > 0)
    ) {
      return;
    }
    if (profile.environment === "production" && pendingProductionAction !== kind) {
      setPendingProductionAction(kind);
      return;
    }
    setPendingProductionAction(null);
    if (kind === "ddl") {
      mutationKindRef.current = kind;
      void mutationSession.run(statements.join("\n"));
      return;
    }

    setDmlMutationError(null);
    setDmlMutationRunning(true);
    void applyTableMutations({
      connectionId: profile.id,
      database,
      table: tableName,
      mutations: dmlPlan.mutations,
    }).then(() => {
      setUpdatedRows(new Map());
      setDeletedRows(new Map());
      setInsertedRows([]);
      setSelectedRows(new Set());
      setSelectionAnchorIndex(null);
      void countSession.run(`SELECT COUNT(*) AS total_rows FROM ${target};`);
      loadPage(page, pageSize, schema, true);
    }).catch((error: unknown) => {
      setDmlMutationError(toAppError(error));
    }).finally(() => {
      setDmlMutationRunning(false);
    });
  }

  /** Discards local schema edits. */
  function discardDdlChanges(): void {
    setDraftColumns(schema.map((column) => ({ ...column })));
    setPendingProductionAction(null);
  }

  /** Discards all staged DML changes and row selection. */
  function discardDmlChanges(): void {
    setUpdatedRows(new Map());
    setDeletedRows(new Map());
    setInsertedRows([]);
    setSelectedRows(new Set());
    setSelectionAnchorIndex(null);
    setEditingCell(null);
    setDmlMutationError(null);
    setPendingProductionAction(null);
  }

  return (
    <section className="table-workspace" aria-label={`${tableName} 表工作区`} onKeyDown={handleWorkspaceKeyDown}>
      <header className="query-context">
        <span className="query-context__engine">MySQL</span>
        <strong>{profile.name}</strong>
        <span className="query-context__target">{database}.{tableName}</span>
        <span className={`environment-badge environment-badge--${profile.environment}`}>
          {{ production: "生产", development: "开发", unspecified: "未指定" }[profile.environment]}
        </span>
      </header>
      <div className="table-view-nav" role="tablist" aria-label="表视图">
        <span className="table-view-nav__tabs">
          <button aria-selected={activeView === "data"} onClick={() => setActiveView("data")} role="tab" type="button"><Table2 size={13} aria-hidden="true" />数据 DML</button>
          <button aria-selected={activeView === "structure"} onClick={() => setActiveView("structure")} role="tab" type="button"><Columns3 size={13} aria-hidden="true" />表结构 DDL</button>
          <button aria-selected={activeView === "ddl"} onClick={() => setActiveView("ddl")} role="tab" type="button"><Braces size={13} aria-hidden="true" />原始 DDL</button>
        </span>
        <button className="table-refresh" disabled={hasDirtyChanges || schemaSession.state.running || dataSession.state.running || ddlSession.state.running || dmlMutationRunning} onClick={loadTable} title={hasDirtyChanges ? "请先提交或撤销当前变更" : undefined} type="button"><RefreshCw size={13} aria-hidden="true" />刷新</button>
      </div>

      <div className="table-workspace__content">
        {!database ? <p className="table-state">当前连接未指定数据库，无法打开表。</p> : null}
        {mutationSession.state.error ? <p className="table-state table-state--error" role="alert">提交失败：{mutationSession.state.error.message}。变更集已保留。</p> : null}
        {dmlMutationError ? <p className="table-state table-state--error" role="alert">提交失败：{dmlMutationError.message}。变更集已保留。</p> : null}

        {database && activeView === "data" ? (
          <section className="data-editor" aria-label="数据编辑器">
            <header className="table-editor-toolbar">
              <span>{`已选择 ${selectedRows.size} / 当前页 ${dataSession.state.rows.length} 行 · 双击单元格弹窗编辑`}{primaryColumns.length > 0 ? ` · 主键 ${primaryColumns.join(", ")}` : " · 无主键，仅允许新增"}</span>
              <label className="table-data-search">
                <Search size={12} aria-hidden="true" />
                <input
                  aria-label="查找当前页数据"
                  onChange={(event) => setDataSearch(event.target.value)}
                  placeholder="查找当前页"
                  ref={dataSearchInputRef}
                  title={`查找当前页数据（${getShortcutKeyLabels(shortcuts.bindings.find).join(" + ")}）`}
                  type="search"
                  value={dataSearch}
                />
                {normalizedDataSearch ? <small>{dataSearchMatchCount} 个匹配</small> : null}
              </label>
              <span className="table-editor-toolbar__actions">
                <button disabled={selectedRows.size === 0 || primaryColumns.length === 0} onClick={deleteSelectedRows} type="button"><Trash2 size={13} aria-hidden="true" />删除选中</button>
                <button disabled={dataSession.state.columns.length === 0} onClick={addInsertedRow} type="button"><Plus size={13} aria-hidden="true" />新增行</button>
                <button disabled={!hasDmlChanges} onClick={discardDmlChanges} type="button">撤销全部</button>
                <button className="table-commit" disabled={dmlStatements.length === 0 || dmlPlan.errors.length > 0 || ddlStatements.length > 0 || mutationSession.state.running || dmlMutationRunning} onClick={() => commit("dml")} title={ddlStatements.length > 0 ? "请先提交或撤销表结构变更" : `提交当前数据变更（${getShortcutKeyLabels(shortcuts.bindings.saveTable).join(" + ")}）`} type="button"><Save size={13} aria-hidden="true" />{dmlMutationRunning ? "提交中…" : pendingProductionAction === "dml" ? "确认在生产环境提交" : `提交 ${dmlChangeCount} 项`}</button>
              </span>
            </header>
            {dataSession.state.running && dataSession.state.rows.length === 0 ? <p className="table-state">正在读取表数据…</p> : dataSession.state.error ? <p className="table-state table-state--error">无法读取表数据：{dataSession.state.error.message}</p> : (
              <div className="editable-grid" role="table" aria-label={`${tableName} 数据`} onKeyDown={handleGridKeyDown} tabIndex={0}>
                <div className="editable-grid__row editable-grid__header" role="row" style={{ gridTemplateColumns: dataGridTemplate, minWidth: dataGridMinimumWidth }}>
                  <span role="columnheader"><input aria-label="选择当前页全部行" checked={allRowsSelected} onChange={toggleSelectAllRows} type="checkbox" /></span>
                  {dataSession.state.columns.map((column, columnIndex) => (
                    <span className="editable-grid__column" key={column.name} role="columnheader" title="拖拽右缘调整列宽">
                      {column.name}
                      <small>{column.databaseType}</small>
                      <span
                        aria-label={`调整 ${column.name} 列宽`}
                        aria-orientation="vertical"
                        className="editable-grid__resize-handle"
                        onMouseDown={(event) => handleDataColumnResizeMouseDown(event, columnIndex)}
                        role="separator"
                      />
                    </span>
                  ))}
                </div>
                {dataSession.state.rows.map((row, rowIndex) => {
                  const identity = tableRowIdentity(row, dataSession.state.columns, primaryColumns);
                  const deleted = deletedRows.has(identity);
                  const selected = selectedRows.has(rowIndex);
                  return (
                    <div
                      aria-selected={selected}
                      className={`editable-grid__row${selected ? " is-selected" : ""}${deleted ? " is-deleted" : ""}`}
                      key={identity || rowIndex}
                      onClick={(event) => handleRowClick(event, rowIndex)}
                      onFocus={() => setFocusedRowIndex(rowIndex)}
                      ref={(element) => {
                        rowRefs.current[rowIndex] = element;
                      }}
                      role="row"
                      style={{ gridTemplateColumns: dataGridTemplate, minWidth: dataGridMinimumWidth }}
                      tabIndex={focusedRowIndex === rowIndex ? 0 : -1}
                    >
                      <span className="editable-grid__selector" role="cell"><input aria-label={`选择第 ${rowIndex + 1} 行`} checked={selected} onChange={() => toggleSelectedRow(rowIndex)} type="checkbox" /></span>
                      {dataSession.state.columns.map((column, columnIndex) => {
                        const value = currentCellValue(rowIndex, column.name, row[columnIndex]);
                        const searchMatch = cellMatchesDataSearch(rowIndex, column.name, row[columnIndex]);
                        return (
                          <span className={`editable-grid__cell${searchMatch ? " is-search-match" : ""}`} key={column.name} onDoubleClick={() => {
                            const schemaColumn = schema.find((candidate) => candidate.name === column.name);
                            if (!deleted && primaryColumns.length > 0 && !schemaColumn?.generationExpression) {
                              openCellEditor(rowIndex, column.name, value);
                            }
                          }} role="cell">
                            {value === null ? <em>NULL</em> : <span>{value}</span>}
                          </span>
                        );
                      })}
                    </div>
                  );
                })}
                {insertedRows.map((row, rowIndex) => (
                  <div className="editable-grid__row is-inserted" key={`new-${rowIndex}`} role="row" style={{ gridTemplateColumns: dataGridTemplate, minWidth: dataGridMinimumWidth }}>
                    <span className="editable-grid__selector" role="cell"><button aria-label={`移除新增行 ${rowIndex + 1}`} onClick={() => removeInsertedRow(rowIndex)} type="button"><X size={12} aria-hidden="true" /></button></span>
                    {dataSession.state.columns.map((column) => {
                      const schemaColumn = schema.find((candidate) => candidate.name === column.name);
                      const hasValue = row.has(column.name);
                      const value = hasValue ? row.get(column.name) ?? null : undefined;
                      const generated = Boolean(schemaColumn?.generationExpression);
                      return (
                        <span className="editable-grid__cell is-editing insert-cell-editor" key={column.name} role="cell">
                          <input
                            aria-label={`新增行 ${rowIndex + 1} ${column.name}`}
                            disabled={generated}
                            onChange={(event) => updateInsertedCell(rowIndex, column.name, event.target.value)}
                            placeholder={generated ? "GENERATED" : hasValue ? value === null ? "NULL" : undefined : "DEFAULT"}
                            value={typeof value === "string" ? value : ""}
                          />
                          {!generated ? (
                            <span>
                              <button aria-label={`${column.name} 使用默认值`} className={!hasValue ? "is-active" : undefined} onClick={() => resetInsertedCellToDefault(rowIndex, column.name)} type="button">默认</button>
                              <button aria-label={`${column.name} 设为 NULL`} className={hasValue && value === null ? "is-active" : undefined} disabled={schemaColumn?.nullable === false} onClick={() => updateInsertedCell(rowIndex, column.name, null)} type="button">NULL</button>
                            </span>
                          ) : null}
                        </span>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
            {dmlPlan.errors.length > 0 ? <p className="table-state table-state--error" role="alert">{`变更中有 ${dmlPlan.errors.length} 个类型错误：${dmlPlan.errors.join("；")}`}</p> : null}
            {dmlStatements.length > 0 ? <SqlPreview title="待提交 DML（实际执行使用参数绑定）" sql={`START TRANSACTION;\n${dmlStatements.join("\n")}\nCOMMIT;`} /> : null}
            <footer className="data-pagination" aria-label="数据分页">
              <span>共 {totalRows.toLocaleString()} 行</span>
              {primaryColumns.length === 0 ? <span className="data-pagination__lock">无主键，数据库无法保证跨页顺序</span> : null}
              {hasDmlChanges ? <span className="data-pagination__lock">提交或撤销变更后可翻页</span> : null}
              <label>每页 <select disabled={hasDmlChanges || dataSession.state.running} onChange={(event) => {
                const nextSize = Number(event.target.value) as (typeof PAGE_SIZES)[number];
                setPageSize(nextSize);
                loadPage(1n, nextSize);
              }} value={pageSize}>{PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
              <span className="data-pagination__controls">
                <button aria-label="第一页" disabled={page === 1n || hasDmlChanges || dataSession.state.running} onClick={() => loadPage(1n)} type="button"><ChevronFirst size={14} aria-hidden="true" /></button>
                <button aria-label="上一页" disabled={page === 1n || hasDmlChanges || dataSession.state.running} onClick={() => loadPage(page - 1n)} type="button"><ChevronLeft size={14} aria-hidden="true" /></button>
                <span>第 {page.toLocaleString()} / {totalPages.toLocaleString()} 页</span>
                <button aria-label="下一页" disabled={page >= totalPages || hasDmlChanges || dataSession.state.running} onClick={() => loadPage(page + 1n)} type="button"><ChevronRight size={14} aria-hidden="true" /></button>
                <button aria-label="最后一页" disabled={page >= totalPages || hasDmlChanges || dataSession.state.running} onClick={() => loadPage(totalPages)} type="button"><ChevronLast size={14} aria-hidden="true" /></button>
              </span>
            </footer>
            {editingCell && editingColumn && editingSchemaColumn ? (
              <div className="table-cell-editor-backdrop" onMouseDown={(event) => {
                if (event.target === event.currentTarget) {
                  setEditingCell(null);
                }
              }} role="presentation">
                <form
                  aria-labelledby="table-cell-editor-title"
                  aria-modal="true"
                  className="table-cell-editor"
                  onKeyDown={handleCellEditorKeyDown}
                  onMouseDown={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    saveCellEdit();
                  }}
                  role="dialog"
                >
                  <header>
                    <div>
                      <strong id="table-cell-editor-title">编辑单元格</strong>
                      <span>第 {editingCell.rowIndex + 1} 行 · {editingCell.columnName} · {editingColumn.databaseType}</span>
                    </div>
                    <button aria-label="关闭单元格编辑器" onClick={() => setEditingCell(null)} type="button"><X size={14} aria-hidden="true" /></button>
                  </header>
                  <label className="table-cell-editor__field">
                    <span>{/^(?:bit|binary|varbinary|tinyblob|blob|mediumblob|longblob)\b/iu.test(editingSchemaColumn.type) ? "单元格内容（Base64）" : "单元格内容"}</span>
                    <textarea
                      aria-label={`${editingCell.columnName} 第 ${editingCell.rowIndex + 1} 行`}
                      autoFocus
                      onChange={(event) => setEditingCell((current) => current ? { ...current, value: event.target.value } : current)}
                      placeholder={editingCell.value === null ? "当前值为 NULL；输入内容后将改为文本" : undefined}
                      value={editingCell.value ?? ""}
                    />
                  </label>
                  <footer>
                    <small>Esc 取消 · ⌘/Ctrl + Enter 保存</small>
                    <span>
                      <button disabled={!editingSchemaColumn.nullable} onClick={() => setEditingCell((current) => current ? { ...current, value: null } : current)} type="button">设为 NULL</button>
                      <button onClick={() => setEditingCell(null)} type="button">取消</button>
                      <button className="table-cell-editor__save" type="submit">保存修改</button>
                    </span>
                  </footer>
                </form>
              </div>
            ) : null}
          </section>
        ) : null}

        {database && activeView === "structure" ? (
          <section className="structure-editor" aria-label="表结构编辑器">
            <header className="table-editor-toolbar">
              <span>{draftColumns.length} 个字段 · {indexes.length} 个索引</span>
              <span className="table-editor-toolbar__actions">
                <button onClick={addDraftColumn} type="button"><Plus size={13} aria-hidden="true" />新增字段</button>
                <button disabled={ddlStatements.length === 0} onClick={discardDdlChanges} type="button">撤销全部</button>
                <button className="table-commit" disabled={ddlStatements.length === 0 || ddlValidationErrors.length > 0 || hasDmlChanges || mutationSession.state.running || dmlMutationRunning} onClick={() => commit("ddl")} title={hasDmlChanges ? "请先提交或撤销数据变更" : `提交当前结构变更（${getShortcutKeyLabels(shortcuts.bindings.saveTable).join(" + ")}）`} type="button"><Save size={13} aria-hidden="true" />{pendingProductionAction === "ddl" ? "确认在生产环境执行" : `执行 ${ddlStatements.length} 条 DDL`}</button>
              </span>
            </header>
            <div className="structure-editor__scroll">
              {schemaSession.state.running && schema.length === 0 ? <p className="table-state">正在读取表结构…</p> : schemaSession.state.error ? <p className="table-state table-state--error">无法读取表结构：{schemaSession.state.error.message}</p> : (
                <section className="schema-section" aria-labelledby={`${tableName}-fields-title`}>
                  <header><span><Columns3 size={14} aria-hidden="true" /><strong id={`${tableName}-fields-title`}>字段</strong></span><small>双击数据编辑不会影响此处结构草稿</small></header>
                  <div className="structure-grid">
                    <div className="structure-grid__header"><span>字段名</span><span>类型</span><span>NULL</span><span>默认值</span><span>注释</span><span>属性</span><span /></div>
                    {draftColumns.map((column, index) => {
                      const originalColumn = column.sourceName === null
                        ? null
                        : schema.find((candidate) => candidate.name === column.sourceName) ?? null;
                      const structureEditable = originalColumn === null || isStructureColumnEditable(originalColumn);
                      const immutableDefault = !structureEditable || Boolean(column.generationExpression) || column.defaultExpression;
                      const unsupportedVisualDefault = Boolean(columnDefaultValidationError({ ...column, defaultValue: column.defaultValue ?? "" }));
                      return (
                        <div className={`structure-grid__row${structureEditable ? "" : " is-locked"}`} key={`${column.sourceName ?? "new"}-${index}`}>
                          <input aria-label={`字段 ${index + 1} 名称`} disabled={!structureEditable} onChange={(event) => updateDraftColumn(index, "name", event.target.value)} value={column.name} />
                          <input aria-label={`${column.name} 类型`} disabled={!structureEditable} onChange={(event) => updateDraftColumn(index, "type", event.target.value)} value={column.type} />
                          <label><input checked={column.nullable} disabled={!structureEditable} onChange={(event) => updateDraftColumn(index, "nullable", event.target.checked)} type="checkbox" /><span>允许</span></label>
                          <span className="default-editor"><input aria-label={`${column.name} 默认值`} disabled={immutableDefault || unsupportedVisualDefault || column.defaultValue === null} onChange={(event) => updateDraftColumn(index, "defaultValue", event.target.value)} placeholder={column.defaultExpression ? "表达式默认值（只读）" : unsupportedVisualDefault ? "请使用显式类型表达式" : "无默认值"} value={column.defaultValue ?? ""} /><button disabled={immutableDefault || (unsupportedVisualDefault && column.defaultValue === null)} onClick={() => updateDraftColumn(index, "defaultValue", column.defaultValue === null ? "" : null)} type="button">{column.defaultValue === null ? "启用" : "移除"}</button></span>
                          <input aria-label={`${column.name} 注释`} disabled={!structureEditable} onChange={(event) => updateDraftColumn(index, "comment", event.target.value)} value={column.comment} />
                          <span className="structure-grid__flags">{column.primary ? <b><KeyRound size={9} aria-hidden="true" />PK</b> : null}{column.extra ? <small>{column.extra}</small> : null}{!structureEditable ? <small title="该字段包含无法无损重建的默认值、生成表达式或高级属性，请使用显式 ALTER TABLE">只读高级字段</small> : null}</span>
                          <button aria-label={`删除字段 ${column.name}`} className="structure-grid__delete" onClick={() => removeDraftColumn(index)} type="button"><Trash2 size={13} aria-hidden="true" /></button>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              <section className="schema-section index-section" aria-labelledby={`${tableName}-indexes-title`}>
                <header><span><KeyRound size={14} aria-hidden="true" /><strong id={`${tableName}-indexes-title`}>索引</strong><b>{indexes.length}</b></span><small>来自 INFORMATION_SCHEMA.STATISTICS</small></header>
                {indexSession.state.running && indexes.length === 0 ? <p className="table-state">正在读取索引…</p> : indexSession.state.error ? <p className="table-state table-state--error">无法读取索引：{indexSession.state.error.message}</p> : indexes.length === 0 ? <p className="table-state">当前表没有索引。</p> : (
                  <div className="index-list" role="table" aria-label={`${tableName} 索引`}>
                    <div className="index-list__header" role="row"><span>名称</span><span>字段</span><span>类型</span><span>基数</span></div>
                    {indexes.map((index) => <div className="index-list__row" key={index.name} role="row"><span><KeyRound size={12} aria-hidden="true" /><strong>{index.name}</strong>{index.name === "PRIMARY" ? <b>主键</b> : index.unique ? <b>唯一</b> : null}</span><code>{index.columns.join(", ")}</code><span>{index.type}</span><span>{index.cardinality ?? "—"}</span></div>)}
                  </div>
                )}
              </section>
            </div>
            {ddlValidationErrors.length > 0 ? <p className="table-state table-state--error" role="alert">{`结构变更中有 ${ddlValidationErrors.length} 个错误：${ddlValidationErrors.join("；")}`}</p> : null}
            {ddlStatements.length > 0 ? <SqlPreview title="待执行 DDL" sql={ddlStatements.join("\n")} /> : null}
          </section>
        ) : null}

        {database && activeView === "ddl" ? (
          <section className="raw-ddl" aria-label="原始 DDL">
            {ddlSession.state.running && !rawDdl ? (
              <p className="table-state">正在读取 DDL…</p>
            ) : ddlSession.state.error ? (
              <p className="table-state table-state--error">无法读取 DDL：{ddlSession.state.error.message}</p>
            ) : (
              <SelectableSqlBlock
                ariaLabel={`${tableName} 原始 DDL`}
                className="raw-ddl__text"
                value={rawDdl || "数据库未返回 CREATE TABLE 语句。"}
              />
            )}
          </section>
        ) : null}
      </div>
    </section>
  );
}

interface SqlPreviewProps {
  title: string;
  sql: string;
}

/** Renders the exact native SQL represented by a local change set. */
function SqlPreview({ title, sql }: SqlPreviewProps) {
  return (
    <details className="sql-preview" open>
      <summary>{title}</summary>
      <SelectableSqlBlock ariaLabel={title} className="sql-preview__text" value={sql} />
    </details>
  );
}
