import {
  Check,
  ChevronDown,
  MoreHorizontal,
  Plus,
  Search,
  Server,
  Settings2,
} from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import { ConnectionActionMenu } from "./ConnectionActionMenu";
import {
  connectionIdentityMatches,
  ENGINE_GROUPS,
  engineLabel,
  environmentLabel,
} from "./connectionLabels";

interface ConnectionPickerProps {
  profiles: readonly ConnectionProfile[];
  activeProfile: ConnectionProfile | null;
  /** Schema the active connection is browsing, when it differs from the profile default. */
  activeDatabase?: string | null;
  reconnectingConnectionId?: string | null;
  onAddConnection: () => void;
  onOpenConnectionManager: () => void;
  /** Opens the manager already focused on one connection, skipping a second lookup. */
  onEditConnection: (profile: ConnectionProfile) => void;
  onSelectConnection: (connectionId: string) => void;
  onCopyConfig?: (profile: ConnectionProfile) => void;
  onReconnect?: (profile: ConnectionProfile) => void;
  onRequestCreateDatabase?: (profile: ConnectionProfile) => void;
  onRequestDelete?: (profile: ConnectionProfile) => void;
  onRequestRename?: (profile: ConnectionProfile) => void;
}

interface RowMenuState {
  profileId: string;
  x: number;
  y: number;
}

/** Width reserved when clamping the row action menu inside the viewport. */
const ROW_MENU_WIDTH = 208;

/**
 * Renders the workspace's single connection focus and lets the user switch it.
 *
 * The navigator shows one connection at a time, so switching belongs here rather than in a list of
 * every saved connection: this control states where the user is, and changing it moves the whole
 * workspace at once.
 * @param props - Saved profiles, the active focus, and the connection-scoped callbacks.
 * @returns One button that expands into the grouped connection list.
 * Side effects: none beyond invoking the supplied callbacks.
 */
export function ConnectionPicker({
  profiles,
  activeProfile,
  activeDatabase = null,
  reconnectingConnectionId = null,
  onAddConnection,
  onOpenConnectionManager,
  onEditConnection,
  onSelectConnection,
  onCopyConfig,
  onReconnect,
  onRequestCreateDatabase,
  onRequestDelete,
  onRequestRename,
}: ConnectionPickerProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [rowMenu, setRowMenu] = useState<RowMenuState | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowMenuItemRef = useRef<HTMLButtonElement>(null);
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const rowMenuProfile = profiles.find((profile) => profile.id === rowMenu?.profileId) ?? null;
  // The switcher shows the schema actually in use, which may differ from the saved default.
  const shownDatabase = activeDatabase ?? activeProfile?.database ?? null;

  useEffect(() => {
    if (!open) {
      setFilter("");
      setRowMenu(null);
      return;
    }
    searchRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    /** Closes the picker after a pointer action outside it. */
    function handlePointerDown(event: PointerEvent): void {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".connection-picker")) {
        setOpen(false);
      }
    }
    /** Closes the row menu first, then the picker, so Escape unwinds one layer at a time. */
    function handleKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape") {
        return;
      }
      setRowMenu((currentMenu) => {
        if (currentMenu) {
          return null;
        }
        setOpen(false);
        triggerRef.current?.focus();
        return null;
      });
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (rowMenu) {
      rowMenuItemRef.current?.focus();
    }
  }, [rowMenu]);

  /** Switches the workspace focus and collapses the picker. */
  function handleSelect(connectionId: string): void {
    setOpen(false);
    triggerRef.current?.focus();
    onSelectConnection(connectionId);
  }

  /** Opens the per-row action menu inside the viewport. */
  function handleRowContextMenu(event: MouseEvent<HTMLElement>, profileId: string): void {
    event.preventDefault();
    setRowMenu({
      profileId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - ROW_MENU_WIDTH - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 240)),
    });
  }

  /** Opens the row action menu from the platform context-menu keyboard shortcut. */
  function handleRowKeyDown(event: KeyboardEvent<HTMLButtonElement>, profileId: string): void {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) {
      return;
    }
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    setRowMenu({
      profileId,
      x: Math.max(8, Math.min(bounds.left + 24, window.innerWidth - ROW_MENU_WIDTH - 8)),
      y: Math.max(8, Math.min(bounds.bottom - 4, window.innerHeight - 240)),
    });
  }

  return (
    <div className="connection-picker">
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={activeProfile
          ? `当前连接 ${activeProfile.name}${shownDatabase ? ` · ${shownDatabase}` : ""}；点击切换连接`
          : "选择连接"}
        className="connection-picker__trigger"
        onClick={() => setOpen((current) => !current)}
        ref={triggerRef}
        title="切换当前连接"
        type="button"
      >
        {activeProfile ? (
          <>
            <span
              aria-hidden="true"
              className={`workspace__topbar-engine workspace__topbar-engine--${activeProfile.engine}`}
            >
              {engineLabel(activeProfile.engine)}
            </span>
            <strong>{activeProfile.name}</strong>
            <span className="connection-picker__database">{shownDatabase ?? "未指定数据库"}</span>
            <span className={`environment-badge environment-badge--${activeProfile.environment}`}>
              {environmentLabel(activeProfile.environment)}
            </span>
          </>
        ) : (
          <>
            <Server size={13} aria-hidden="true" />
            <strong>选择连接</strong>
          </>
        )}
        <ChevronDown className="connection-picker__chevron" size={13} aria-hidden="true" />
      </button>

      {open ? (
        <div className="connection-picker__panel">
          <label className="connection-picker__search">
            <Search size={12} aria-hidden="true" />
            <input
              aria-label="搜索连接"
              onChange={(event) => setFilter(event.target.value)}
              placeholder="搜索连接"
              ref={searchRef}
              type="search"
              value={filter}
            />
          </label>

          <div role="listbox" aria-label="已保存的连接" className="connection-picker__list">
            {profiles.length === 0 ? (
              <p className="connection-picker__empty">还没有保存任何连接。</p>
            ) : null}
            {ENGINE_GROUPS.map(({ engine, label }) => {
              const groupProfiles = profiles.filter((profile) => (
                profile.engine === engine && connectionIdentityMatches(profile, normalizedFilter)
              ));
              if (groupProfiles.length === 0) {
                return null;
              }
              return (
                <div className="connection-picker__group" key={engine}>
                  <span className="connection-picker__group-label">{label}</span>
                  {groupProfiles.map((profile) => (
                    <div className="connection-picker__row" key={profile.id}>
                      <button
                        aria-selected={profile.id === activeProfile?.id}
                        className="connection-picker__item"
                        onClick={() => handleSelect(profile.id)}
                        onContextMenu={(event) => handleRowContextMenu(event, profile.id)}
                        onKeyDown={(event) => handleRowKeyDown(event, profile.id)}
                        role="option"
                        type="button"
                      >
                        {profile.id === activeProfile?.id
                          ? <Check size={12} aria-hidden="true" />
                          : <span className="connection-picker__item-spacer" aria-hidden="true" />}
                        <span className="connection-picker__item-body">
                          <strong>{profile.name}</strong>
                          <small>
                            {profile.host}:{profile.port}
                            {profile.database ? ` · ${profile.database}` : ""}
                          </small>
                        </span>
                        <span
                          className={`environment-badge environment-badge--${profile.environment}`}
                        >
                          {environmentLabel(profile.environment)}
                        </span>
                      </button>
                      {/*
                        * Editing and the action menu are visible controls rather than right-click
                        * only, so managing a connection never depends on discovering a gesture.
                        */}
                      <span className="connection-picker__row-actions">
                        <button
                          aria-label={`编辑 ${profile.name}`}
                          onClick={() => {
                            setOpen(false);
                            onEditConnection(profile);
                          }}
                          title="编辑连接配置与数据库"
                          type="button"
                        >
                          <Settings2 size={12} aria-hidden="true" />
                        </button>
                        <button
                          aria-label={`${profile.name} 更多操作`}
                          onClick={(event) => {
                            const bounds = event.currentTarget.getBoundingClientRect();
                            setRowMenu({
                              profileId: profile.id,
                              x: Math.max(
                                8,
                                Math.min(bounds.right - ROW_MENU_WIDTH, window.innerWidth - ROW_MENU_WIDTH - 8),
                              ),
                              y: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 240)),
                            });
                          }}
                          title="更多连接操作"
                          type="button"
                        >
                          <MoreHorizontal size={13} aria-hidden="true" />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              );
            })}
            {profiles.length > 0 && normalizedFilter
              && !profiles.some((profile) => connectionIdentityMatches(profile, normalizedFilter))
              ? <p className="connection-picker__empty">没有匹配的连接。</p>
              : null}
          </div>

          <span className="connection-picker__separator" role="separator" />
          <button
            className="connection-picker__action"
            onClick={() => {
              setOpen(false);
              onAddConnection();
            }}
            type="button"
          >
            <Plus size={12} aria-hidden="true" />
            添加连接…
          </button>
          <button
            className="connection-picker__action"
            onClick={() => {
              setOpen(false);
              onOpenConnectionManager();
            }}
            type="button"
          >
            <Settings2 size={12} aria-hidden="true" />
            连接管理
          </button>
        </div>
      ) : null}

      {rowMenu && rowMenuProfile ? (
        <ConnectionActionMenu
          className="connection-context-menu"
          firstItemRef={rowMenuItemRef}
          onCopyConfig={onCopyConfig}
          onDismiss={() => {
            setRowMenu(null);
            setOpen(false);
          }}
          onReconnect={onReconnect}
          onRequestCreateDatabase={onRequestCreateDatabase}
          onRequestDelete={onRequestDelete}
          onRequestRename={onRequestRename}
          profile={rowMenuProfile}
          reconnecting={reconnectingConnectionId === rowMenuProfile.id}
          style={{ left: rowMenu.x, top: rowMenu.y }}
        />
      ) : null}
    </div>
  );
}
