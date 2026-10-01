/** Which collection an open workspace tab belongs to. */
export type WorkspaceTabType = "query" | "table" | "utility";

/** One open workspace tab, reduced to what tab-strip navigation needs. */
export interface WorkspaceTabRef {
  /** Tab identifier, unique across all three collections. */
  id: string;
  /** Collection the tab belongs to, which decides how it is activated. */
  type: WorkspaceTabType;
}

/** The three tab collections, in the order the shared strip renders them. */
export interface WorkspaceTabCollections {
  /** Open query tabs, rendered first. */
  queryTabIds: string[];
  /** Open table tabs, rendered after the query tabs. */
  tableTabIds: string[];
  /** Open utility tabs (connection manager, binlog), rendered last. */
  utilityTabIds: string[];
}

/**
 * Lists every open workspace in the exact order the shared tab strip renders it.
 * @param collections - The three tab collections backing the strip.
 * @returns Ordered tab identities across the query, table, and utility collections.
 */
export function orderWorkspaceTabs(collections: WorkspaceTabCollections): WorkspaceTabRef[] {
  return [
    ...collections.queryTabIds.map((id) => ({ id, type: "query" as const })),
    ...collections.tableTabIds.map((id) => ({ id, type: "table" as const })),
    ...collections.utilityTabIds.map((id) => ({ id, type: "utility" as const })),
  ];
}

/**
 * Resolves the tab a positional jump shortcut targets.
 *
 * Position 9 always means "the last tab" rather than "the ninth tab", matching platform tab strips.
 * @param orderedTabs - Tabs in strip order, from {@link orderWorkspaceTabs}.
 * @param position - One-based position taken from the pressed digit.
 * @returns The targeted tab, or `undefined` when no tab occupies that position.
 */
export function resolveWorkspaceTabJump(
  orderedTabs: WorkspaceTabRef[],
  position: number,
): WorkspaceTabRef | undefined {
  if (orderedTabs.length === 0) {
    return undefined;
  }
  return position >= 9 ? orderedTabs[orderedTabs.length - 1] : orderedTabs[position - 1];
}

/**
 * Resolves the tab that cycling forward or backward should activate.
 *
 * An unknown `currentId` is treated as the first tab, so cycling still works when the active
 * workspace is not in the strip.
 * @param orderedTabs - Tabs in strip order, from {@link orderWorkspaceTabs}.
 * @param currentId - Identifier of the active tab, if any.
 * @param reverse - Whether to move to the previous tab instead of the next.
 * @returns The adjacent tab, or `undefined` when fewer than two tabs are open.
 */
export function resolveWorkspaceTabCycle(
  orderedTabs: WorkspaceTabRef[],
  currentId: string | null,
  reverse: boolean,
): WorkspaceTabRef | undefined {
  if (orderedTabs.length < 2) {
    return undefined;
  }
  const currentIndex = Math.max(0, orderedTabs.findIndex((tab) => tab.id === currentId));
  const delta = reverse ? -1 : 1;
  const nextIndex = (currentIndex + delta + orderedTabs.length) % orderedTabs.length;
  return orderedTabs[nextIndex];
}
