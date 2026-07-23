import { useRef } from "react";

interface SelectableSqlBlockProps {
  value: string;
  ariaLabel: string;
  className?: string;
}

/**
 * Renders read-only SQL so click focus and Mod+A stay inside this block.
 * @param props - SQL text, accessible name, and optional class on the textarea.
 * @returns A focusable read-only SQL surface marked for scoped select-all.
 * Side effects: none.
 */
export function SelectableSqlBlock({ value, ariaLabel, className }: SelectableSqlBlockProps) {
  const textRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div
      className="selectable-sql-block"
      data-selectable-block
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          textRef.current?.focus();
        }
      }}
    >
      <textarea
        aria-label={ariaLabel}
        className={className ?? "selectable-sql-block__text"}
        data-selectable-surface
        readOnly
        ref={textRef}
        spellCheck={false}
        value={value}
      />
    </div>
  );
}
