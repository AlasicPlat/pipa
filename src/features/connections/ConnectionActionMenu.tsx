import { Copy, DatabasePlus, Pencil, RefreshCw, Trash2 } from "lucide-react";
import type { Ref } from "react";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";

interface ConnectionActionMenuProps {
  className?: string;
  firstItemRef?: Ref<HTMLButtonElement>;
  profile: ConnectionProfile;
  reconnecting: boolean;
  style?: { left: number; top: number };
  onCopyConfig?: (profile: ConnectionProfile) => void;
  onReconnect?: (profile: ConnectionProfile) => void;
  onRequestCreateDatabase?: (profile: ConnectionProfile) => void;
  onRequestDelete?: (profile: ConnectionProfile) => void;
  onRequestRename?: (profile: ConnectionProfile) => void;
  /** Invoked before every action so the owner can dismiss the menu exactly once. */
  onDismiss: () => void;
}

/**
 * Renders the shared connection action menu used by the navigator and the connection picker.
 *
 * Both surfaces expose the same operations, so they share one implementation rather than drifting
 * apart as items are added.
 * @param props - Target profile, reconnect state, placement, focus target, and action callbacks.
 * @returns An accessible menu of connection-scoped actions.
 * Side effects: none beyond invoking the supplied callbacks.
 */
export function ConnectionActionMenu({
  className,
  firstItemRef,
  profile,
  reconnecting,
  style,
  onCopyConfig,
  onReconnect,
  onRequestCreateDatabase,
  onRequestDelete,
  onRequestRename,
  onDismiss,
}: ConnectionActionMenuProps) {
  const isMySql = profile.engine === "my_sql";

  /** Dismisses the menu, then runs one action against the target profile. */
  function run(action?: (profile: ConnectionProfile) => void): void {
    onDismiss();
    action?.(profile);
  }

  return (
    <div
      aria-label={`${profile.name} 操作`}
      className={className}
      role="menu"
      style={style}
    >
      {/* Redis logical databases are a fixed 0-15 range, so only MySQL can create one. */}
      {isMySql ? (
        <>
          <button
            disabled={!onRequestCreateDatabase}
            onClick={() => run(onRequestCreateDatabase)}
            ref={firstItemRef}
            role="menuitem"
            type="button"
          >
            <DatabasePlus size={13} aria-hidden="true" />
            新建数据库…
          </button>
          <span className="connection-context-menu__separator" role="separator" />
        </>
      ) : null}
      <button
        disabled={!onRequestRename}
        onClick={() => run(onRequestRename)}
        ref={isMySql ? undefined : firstItemRef}
        role="menuitem"
        type="button"
      >
        <Pencil size={13} aria-hidden="true" />
        重命名…
      </button>
      <button
        disabled={!onCopyConfig}
        onClick={() => run(onCopyConfig)}
        role="menuitem"
        type="button"
      >
        <Copy size={13} aria-hidden="true" />
        复制连接配置
      </button>
      <button
        disabled={!onReconnect || reconnecting}
        onClick={() => run(onReconnect)}
        role="menuitem"
        type="button"
      >
        <RefreshCw className={reconnecting ? "spin" : undefined} size={13} aria-hidden="true" />
        {reconnecting ? "正在重新连接…" : "重新连接"}
      </button>
      <span className="connection-context-menu__separator" role="separator" />
      <button
        className="connection-context-menu__danger"
        disabled={!onRequestDelete}
        onClick={() => run(onRequestDelete)}
        role="menuitem"
        type="button"
      >
        <Trash2 size={13} aria-hidden="true" />
        删除连接…
      </button>
    </div>
  );
}
