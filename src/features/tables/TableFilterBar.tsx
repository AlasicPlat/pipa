import { Filter, FilterX, Plus, Search, X } from "lucide-react";
import { StructureMetaSelect } from "./structureEditors";
import {
  TABLE_FILTER_OPERATOR_LABELS,
  filterOperatorsForColumnType,
  filterValuePlaceholder,
  isUnaryFilterOperator,
  type TableColumnDefinition,
  type TableFilterCondition,
  type TableFilterConjunction,
  type TableFilterOperator,
} from "./tableSql";

interface TableFilterBarProps {
  /** Columns the quick filter can build predicates for. */
  columns: readonly TableColumnDefinition[];
  /** Ordered draft conditions. */
  conditions: readonly TableFilterCondition[];
  /** Whether the condition editor is visible. */
  expanded: boolean;
  /** Localized validation errors blocking submission. */
  errors: readonly string[];
  /** Summary of the clause currently applied to the grid. */
  appliedSummary: string;
  /** Number of conditions in the applied clause. */
  appliedCount: number;
  /** Whether the draft differs from the applied clause. */
  dirty: boolean;
  /** Whether a WHERE clause is currently applied. */
  active: boolean;
  /** Whether staged DML edits or an in-flight page load block submission. */
  disabled: boolean;
  /** Reason shown when submission is blocked. */
  disabledReason?: string;
  onExpandedChange: (expanded: boolean) => void;
  onConditionsChange: (conditions: TableFilterCondition[]) => void;
  onApply: () => void;
  onClear: () => void;
}

/**
 * Creates one draft condition seeded with the first operator valid for its column.
 * @param column - Column the new condition targets.
 * @param conjunction - Connector joining it to the preceding condition.
 * @returns A condition ready for editing.
 * Side effects: generates a random identifier.
 */
function createCondition(
  column: TableColumnDefinition | undefined,
  conjunction: TableFilterConjunction,
): TableFilterCondition {
  const operators = column ? filterOperatorsForColumnType(column.type) : [];
  return {
    id: crypto.randomUUID(),
    columnName: column?.name ?? "",
    operator: operators[0] ?? "=",
    value: "",
    conjunction,
    enabled: true,
  };
}

/**
 * Renders the quick WHERE-clause filter for the data DML grid.
 * @param props - Column metadata, draft conditions, validation state, and change handlers.
 * @returns A collapsible condition editor that submits a server-side filter.
 * Side effects: none directly; submission is delegated to the owning workspace.
 */
export function TableFilterBar({
  columns,
  conditions,
  expanded,
  errors,
  appliedSummary,
  appliedCount,
  dirty,
  active,
  disabled,
  disabledReason,
  onExpandedChange,
  onConditionsChange,
  onApply,
  onClear,
}: TableFilterBarProps) {
  const columnNames = columns.map((column) => column.name);

  /** Replaces one condition by identifier, re-selecting a valid operator when the column changes. */
  function updateCondition(id: string, patch: Partial<TableFilterCondition>): void {
    onConditionsChange(conditions.map((condition) => {
      if (condition.id !== id) {
        return condition;
      }
      const next = { ...condition, ...patch };
      if (patch.columnName !== undefined && patch.columnName !== condition.columnName) {
        const column = columns.find((candidate) => candidate.name === patch.columnName);
        const operators = column ? filterOperatorsForColumnType(column.type) : [];
        if (!operators.includes(next.operator)) {
          next.operator = operators[0] ?? "=";
        }
      }
      return next;
    }));
  }

  /** Appends one condition ANDed to the existing list. */
  function addCondition(): void {
    onConditionsChange([...conditions, createCondition(columns[0], "AND")]);
  }

  /** Removes one condition and keeps the first row free of a leading connector. */
  function removeCondition(id: string): void {
    onConditionsChange(conditions.filter((condition) => condition.id !== id));
  }

  return (
    <section className="table-filter" aria-label="数据筛选">
      <header className="table-filter__summary">
        <button
          aria-expanded={expanded}
          aria-label="展开数据筛选条件"
          className={`table-filter__toggle${active ? " is-active" : ""}`}
          onClick={() => {
            if (!expanded && conditions.length === 0 && columns.length > 0) {
              onConditionsChange([createCondition(columns[0], "AND")]);
            }
            onExpandedChange(!expanded);
          }}
          type="button"
        >
          <Filter size={13} aria-hidden="true" />
          筛选
          {active ? <small>{appliedCount}</small> : null}
        </button>
        {active ? (
          <span className="table-filter__applied" title={appliedSummary}>
            <span>WHERE {appliedSummary}</span>
            <button aria-label="清除筛选条件" disabled={disabled} onClick={onClear} type="button">
              <FilterX size={12} aria-hidden="true" />
            </button>
          </span>
        ) : (
          <span className="table-filter__hint">未启用筛选，当前展示全表数据</span>
        )}
      </header>

      {expanded ? (
        <form
          className="table-filter__editor"
          onSubmit={(event) => {
            event.preventDefault();
            onApply();
          }}
        >
          {columns.length === 0 ? (
            <p className="table-filter__empty">当前表没有可用于快捷筛选的字段。</p>
          ) : (
            <>
              <ul className="table-filter__conditions">
                {conditions.map((condition, index) => {
                  const column = columns.find((candidate) => candidate.name === condition.columnName);
                  const operators = column ? filterOperatorsForColumnType(column.type) : [];
                  const unary = isUnaryFilterOperator(condition.operator);
                  return (
                    <li className="table-filter__condition" key={condition.id}>
                      {index === 0 ? (
                        <span className="table-filter__conjunction table-filter__conjunction--fixed">WHERE</span>
                      ) : (
                        <select
                          aria-label={`第 ${index + 1} 个条件的连接方式`}
                          className="table-filter__conjunction"
                          onChange={(event) => updateCondition(condition.id, {
                            conjunction: event.target.value as TableFilterConjunction,
                          })}
                          value={condition.conjunction}
                        >
                          <option value="AND">并且 AND</option>
                          <option value="OR">或者 OR</option>
                        </select>
                      )}
                      <StructureMetaSelect
                        ariaLabel={`第 ${index + 1} 个条件的字段`}
                        emptyLabel="选择字段"
                        onChange={(value) => updateCondition(condition.id, { columnName: value ?? "" })}
                        options={columnNames}
                        value={condition.columnName || null}
                      />
                      <select
                        aria-label={`第 ${index + 1} 个条件的比较符`}
                        disabled={operators.length === 0}
                        onChange={(event) => updateCondition(condition.id, {
                          operator: event.target.value as TableFilterOperator,
                        })}
                        value={condition.operator}
                      >
                        {operators.map((operator) => (
                          <option key={operator} value={operator}>
                            {TABLE_FILTER_OPERATOR_LABELS[operator]}
                          </option>
                        ))}
                      </select>
                      <input
                        aria-label={`第 ${index + 1} 个条件的值`}
                        disabled={unary}
                        onChange={(event) => updateCondition(condition.id, { value: event.target.value })}
                        placeholder={unary ? "无需输入值" : filterValuePlaceholder(condition.operator)}
                        type="text"
                        value={unary ? "" : condition.value}
                      />
                      <label className="table-filter__enabled" title="临时停用该条件">
                        <input
                          aria-label={`启用第 ${index + 1} 个条件`}
                          checked={condition.enabled}
                          onChange={(event) => updateCondition(condition.id, { enabled: event.target.checked })}
                          type="checkbox"
                        />
                      </label>
                      <button
                        aria-label={`移除第 ${index + 1} 个条件`}
                        onClick={() => removeCondition(condition.id)}
                        type="button"
                      >
                        <X size={12} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
              {errors.length > 0 ? (
                <p className="table-filter__errors" role="alert">{errors.join("；")}</p>
              ) : null}
              <footer className="table-filter__actions">
                <button onClick={addCondition} type="button">
                  <Plus size={13} aria-hidden="true" />
                  添加条件
                </button>
                <span className="table-filter__spacer" />
                <button disabled={!active && conditions.length === 0} onClick={onClear} type="button">
                  重置
                </button>
                <button
                  className="table-filter__submit"
                  disabled={disabled || errors.length > 0 || !dirty}
                  title={disabled ? disabledReason : undefined}
                  type="submit"
                >
                  <Search size={13} aria-hidden="true" />
                  提交筛选
                </button>
              </footer>
            </>
          )}
        </form>
      ) : null}
    </section>
  );
}
