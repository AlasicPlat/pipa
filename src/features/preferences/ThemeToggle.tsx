import { useEffect, useRef, useState } from "react";
import { Check, Monitor, Moon, Sun } from "lucide-react";
import type { ThemePreference } from "./theme";
import "./preferences.css";

const THEME_OPTIONS: ReadonlyArray<{
  value: ThemePreference;
  label: string;
  description: string;
  Icon: typeof Monitor;
}> = [
  { value: "system", label: "跟随系统", description: "自动使用 macOS 外观", Icon: Monitor },
  { value: "light", label: "亮色", description: "始终使用亮色界面", Icon: Sun },
  { value: "dark", label: "暗色", description: "始终使用暗色界面", Icon: Moon },
];

export interface ThemeMenuProps {
  preference: ThemePreference;
  onChange: (preference: ThemePreference) => void;
}

/**
 * Renders the three explicit appearance choices as an accessible radio menu.
 * @param props - Current preference and change callback.
 * @returns The theme menu element.
 */
export function ThemeMenu({ preference, onChange }: ThemeMenuProps) {
  return (
    <div className="theme-menu" role="menu" aria-label="选择界面外观">
      <div className="theme-menu__heading">界面外观</div>
      {THEME_OPTIONS.map(({ value, label, description, Icon }) => (
        <button
          className="theme-menu__option"
          key={value}
          type="button"
          role="menuitemradio"
          aria-checked={preference === value}
          onClick={() => onChange(value)}
        >
          <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
          <span className="theme-menu__copy">
            <span className="theme-menu__label">{label}</span>
            <span className="theme-menu__description">{description}</span>
          </span>
          {preference === value ? <Check className="theme-menu__check" aria-hidden="true" size={14} /> : null}
        </button>
      ))}
    </div>
  );
}

export interface ThemeToggleProps extends ThemeMenuProps {
  className?: string;
}

/**
 * Provides a compact toolbar trigger and dismissible appearance menu.
 * @param props - Current preference, change callback, and optional wrapper class.
 * @returns The appearance toolbar control.
 * Side effects: installs temporary document dismissal listeners while the menu is open.
 */
export function ThemeToggle({ preference, onChange, className }: ThemeToggleProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeOption = THEME_OPTIONS.find((option) => option.value === preference) ?? THEME_OPTIONS[0];
  const ActiveIcon = activeOption.Icon;

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    /**
     * Closes the menu when pointer interaction moves outside the appearance control.
     * @param event - Document-level pointer event.
     * @returns Nothing (`void`).
     */
    const handlePointerDown = (event: PointerEvent): void => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    /**
     * Closes the menu with Escape and restores the toolbar focus target.
     * @param event - Document-level keyboard event.
     * @returns Nothing (`void`).
     */
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  /**
   * Applies one appearance choice, then returns focus to the compact trigger.
   * @param nextPreference - Newly selected appearance preference.
   * @returns Nothing (`void`).
   */
  const handleChange = (nextPreference: ThemePreference): void => {
    onChange(nextPreference);
    setOpen(false);
    triggerRef.current?.focus();
  };

  return (
    <div className={["theme-toggle", className].filter(Boolean).join(" ")} ref={containerRef}>
      <button
        className="theme-toggle__button"
        ref={triggerRef}
        type="button"
        aria-label={`界面外观：${activeOption.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <ActiveIcon aria-hidden="true" size={14} strokeWidth={1.8} />
        <span>外观</span>
      </button>
      {open ? <ThemeMenu preference={preference} onChange={handleChange} /> : null}
    </div>
  );
}
