import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, type ReactNode } from "react";
import type { CellValue } from "../../bindings/CellValue";
import type { QueryColumn } from "../../bindings/QueryColumn";

interface ResultGridProps {
  columns: QueryColumn[];
  rows: CellValue[][];
  running: boolean;
  incomplete: boolean;
}

/**
 * Converts a transport-safe cell value into compact display content.
 * @param cell - Generated discriminated database value.
 * @returns Visible cell content; exact integers and decimals remain strings.
 * Side effects: none.
 */
function renderCellValue(cell: CellValue | undefined): ReactNode {
  if (!cell || cell.kind === "null") {
    return <span className="result-cell--null">NULL</span>;
  }

  switch (cell.kind) {
    case "boolean":
      return cell.value ? "true" : "false";
    case "integer":
    case "decimal":
    case "text":
    case "date_time":
      return cell.value;
    case "float":
      return String(cell.value);
    case "json":
      return JSON.stringify(cell.value);
    case "binary":
      return <span className="result-cell--binary">Binary</span>;
  }
}

/**
 * Renders ordered result rows through row virtualization for stable large-result scrolling.
 * @param props - Generated schema, streamed rows, and terminal/loading state.
 * @returns An accessible virtual result grid with minimal bottom streaming feedback.
 * Side effects: measures and observes the result viewport through TanStack Virtual.
 */
export function ResultGrid({ columns, rows, running, incomplete }: ResultGridProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => 34,
    overscan: 10,
  });
  const gridTemplateColumns = `repeat(${columns.length}, minmax(160px, 1fr))`;
  const gridMinWidth = Math.max(columns.length * 160, 560);

  return (
    <div className="result-grid" role="table" aria-label="查询结果">
      <div className="result-grid__viewport" ref={viewportRef}>
        <div
          className="result-grid__header"
          role="row"
          style={{ gridTemplateColumns, minWidth: gridMinWidth }}
        >
          {columns.map((column, index) => (
            <span className="result-grid__column" key={`${column.name}-${index}`} role="columnheader">
              <span>{column.name}</span>
              <small>{column.databaseType}</small>
            </span>
          ))}
        </div>
        <div
          className="result-grid__rows"
          role="rowgroup"
          style={{ height: virtualizer.getTotalSize(), minWidth: gridMinWidth }}
        >
          {virtualizer.getVirtualItems().map((virtualRow) => (
            <div
              className="result-grid__row"
              key={virtualRow.key}
              role="row"
              style={{
                gridTemplateColumns,
                height: virtualRow.size,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              {columns.map((column, columnIndex) => (
                <span
                  className="result-grid__cell"
                  key={`${column.name}-${columnIndex}`}
                  role="cell"
                  title={column.name}
                >
                  {renderCellValue(rows[virtualRow.index]?.[columnIndex])}
                </span>
              ))}
            </div>
          ))}
        </div>
        {running && rows.length > 0 ? (
          <div className="result-grid__loading" role="status">
            <span className="loading-spinner" aria-hidden="true" />
            正在加载更多…
          </div>
        ) : null}
        {incomplete ? <p className="result-grid__notice">结果不完整</p> : null}
      </div>
    </div>
  );
}
