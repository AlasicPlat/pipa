import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { suggestMysqlBaseTypes } from "./tableSql";

interface StructureTypeSuggestProps {
  value: string;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
}

/**
 * Typeahead input for MySQL base types (e.g. `in` → `int`, `bi` → `bigint`).
 * @param props - Current value, disabled state, accessible name, and commit handler.
 * @returns Combobox control with a fixed-position suggestion menu.
 * Side effects: mounts a portal menu while open.
 */
export function StructureTypeSuggest({ value, disabled, ariaLabel, onChange }: StructureTypeSuggestProps) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const draftRef = useRef(value);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuRect, setMenuRect] = useState<DOMRect | null>(null);
  const suggestions = useMemo(() => suggestMysqlBaseTypes(draft), [draft]);

  draftRef.current = draft;
  valueRef.current = value;
  onChangeRef.current = onChange;

  useEffect(() => {
    setDraft(value);
    draftRef.current = value;
  }, [value]);

  useEffect(() => {
    if (!open) {
      return;
    }
    /** Closes the menu when pointer lands outside the control. */
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target as Node | null;
      if (
        inputRef.current?.contains(target)
        || (target instanceof Element && target.closest(`[data-structure-suggest="${listId}"]`))
      ) {
        return;
      }
      const normalized = draftRef.current.trim().toLowerCase();
      if (normalized && normalized !== valueRef.current) {
        onChangeRef.current(normalized);
      } else {
        setDraft(valueRef.current);
      }
      setOpen(false);
    }
    window.addEventListener("pointerdown", handlePointerDown);
    return () => window.removeEventListener("pointerdown", handlePointerDown);
  }, [open, listId]);

  /** Positions and opens the suggestion menu beneath the input. */
  function openMenu(): void {
    if (disabled) {
      return;
    }
    setMenuRect(inputRef.current?.getBoundingClientRect() ?? null);
    setOpen(true);
    setActiveIndex(0);
  }

  /** Commits the current draft text as the selected base type. */
  function commitDraft(next = draft): void {
    const normalized = next.trim().toLowerCase();
    if (normalized && normalized !== value) {
      onChange(normalized);
    } else {
      setDraft(value);
    }
  }

  /** Applies one suggestion and closes the menu. */
  function chooseSuggestion(suggestion: string): void {
    setDraft(suggestion);
    onChange(suggestion);
    setOpen(false);
    inputRef.current?.focus();
  }

  /** Handles arrow navigation, Enter commit, and Escape dismiss. */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      setActiveIndex((current) => Math.min(current + 1, Math.max(suggestions.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      if (open && suggestions[activeIndex]) {
        event.preventDefault();
        chooseSuggestion(suggestions[activeIndex]);
      } else {
        commitDraft();
        setOpen(false);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(value);
      setOpen(false);
    }
  }

  return (
    <>
      <input
        aria-activedescendant={open && suggestions[activeIndex] ? `${listId}-${activeIndex}` : undefined}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={(event) => {
          setDraft(event.target.value);
          setActiveIndex(0);
          openMenu();
        }}
        onFocus={openMenu}
        onKeyDown={handleKeyDown}
        ref={inputRef}
        role="combobox"
        spellCheck={false}
        value={draft}
      />
      {open && menuRect && suggestions.length > 0
        ? createPortal(
          <div
            className="structure-suggest-menu"
            data-structure-suggest={listId}
            id={listId}
            role="listbox"
            style={{
              top: menuRect.bottom + 2,
              left: menuRect.left,
              width: Math.max(menuRect.width, 132),
            }}
          >
            {suggestions.map((suggestion, index) => (
              <button
                aria-selected={index === activeIndex}
                className={index === activeIndex ? "is-active" : undefined}
                id={`${listId}-${index}`}
                key={suggestion}
                onMouseDown={(event) => {
                  event.preventDefault();
                  chooseSuggestion(suggestion);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                role="option"
                type="button"
              >
                {suggestion}
              </button>
            ))}
          </div>,
          document.body,
        )
        : null}
    </>
  );
}

interface StructureMetaSelectProps {
  value: string | null;
  options: readonly string[];
  disabled?: boolean;
  ariaLabel: string;
  emptyLabel: string;
  placeholder?: string;
  onChange: (value: string | null) => void;
}

/**
 * Native select for server-provided charset or collation values.
 * @param props - Current value, option list, and change handler.
 * @returns A compact select that preserves unknown current values.
 * Side effects: none.
 */
export function StructureMetaSelect({
  value,
  options,
  disabled,
  ariaLabel,
  emptyLabel,
  placeholder,
  onChange,
}: StructureMetaSelectProps) {
  const resolvedOptions = useMemo(() => {
    if (value && !options.includes(value)) {
      return [value, ...options];
    }
    return options;
  }, [options, value]);

  return (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
      title={value ?? placeholder}
      value={value ?? ""}
    >
      <option value="">{emptyLabel}</option>
      {resolvedOptions.map((option) => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
  );
}
