import { useCallback, useState } from "react";

import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { CreateDatabaseRequest } from "../dialogs/CreateDatabaseDialog";
import { buildCreateDatabase } from "../../lib/tauriClient";
import { databaseNameValidationError, quoteIdentifier } from "../tables/tableSql";
import { executeQueryOnce } from "../query/executeQueryOnce";
import { getConnectionActionError } from "./connectionErrors";

/** Which MySQL connection the create-database dialog targets; the dialog owns the draft. */
interface PendingCreateDatabase {
  connectionId: string;
}

/** One schema awaiting an explicit typed confirmation before it is dropped. */
interface PendingDropDatabase {
  connectionId: string;
  database: string;
}

/** Shell collaborators the schema operations need in order to reconcile the rest of the UI. */
export interface DatabaseOperationsOptions {
  /** Resolves one saved non-secret profile by identifier. */
  findProfile: (connectionId: string) => ConnectionProfile | undefined;
  /** Clears the shell's error toast before an operation starts. */
  clearError: () => void;
  /** Reports a completed operation through the shell's notice toast. */
  showNotice: (message: string) => void;
  /** Focuses the connection the create dialog was opened from. */
  selectConnection: (connectionId: string) => void;
  /** Runs after a schema is created, so the navigator can reload stale metadata. */
  onDatabaseCreated: (connectionId: string) => void;
  /** Runs after a schema is dropped, so dependent tabs and caches can be discarded. */
  onDatabaseDropped: (connectionId: string, database: string) => void;
}

/** State and handlers for creating and dropping schemas. */
export interface DatabaseOperations {
  /** Draft error shown inside the create dialog, if the last attempt failed. */
  createError: string | null;
  /** Whether a CREATE DATABASE statement is executing. */
  creating: boolean;
  /** Connection the create dialog targets, or `null` when it is closed. */
  createTarget: ConnectionProfile | null;
  /** Error shown inside the drop dialog, if the last attempt failed. */
  dropError: string | null;
  /** Whether a DROP DATABASE statement is executing. */
  dropping: boolean;
  /** Connection the drop dialog targets, or `null` when it is closed. */
  dropTarget: ConnectionProfile | null;
  /** Schema the drop dialog will remove, which the user must retype to confirm. */
  dropTargetDatabase: string | null;
  /** Abandons the create draft, unless a statement is already running. */
  cancelCreate: () => void;
  /** Abandons the drop confirmation, unless a statement is already running. */
  cancelDrop: () => void;
  /** Runs CREATE DATABASE for the drafted name, charset, and collation. */
  confirmCreate: (request: CreateDatabaseRequest) => Promise<void>;
  /** Runs DROP DATABASE for the confirmed schema. */
  confirmDrop: () => Promise<void>;
  /** Opens the create dialog for one MySQL connection. */
  requestCreate: (profile: ConnectionProfile) => void;
  /** Opens the drop confirmation for one schema. */
  requestDrop: (profile: ConnectionProfile, database: string) => void;
}

/**
 * Owns the create-database and drop-database flows, including their dialogs' in-flight and error
 * state.
 *
 * Statement construction stays in the backend: neither `CREATE DATABASE` nor `DROP DATABASE` can
 * take a bound parameter for the schema name, so quoting and the charset allowlist are enforced
 * there. The local name check only gives the dialog immediate feedback.
 * @param options - Shell collaborators used to reconcile the rest of the UI after each operation.
 * @returns The dialogs' state and the handlers that drive them.
 */
export function useDatabaseOperations(
  options: DatabaseOperationsOptions,
): DatabaseOperations {
  const {
    clearError,
    findProfile,
    onDatabaseCreated,
    onDatabaseDropped,
    selectConnection,
    showNotice,
  } = options;
  const [pendingCreate, setPendingCreate] = useState<PendingCreateDatabase | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [pendingDrop, setPendingDrop] = useState<PendingDropDatabase | null>(null);
  const [dropping, setDropping] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  const createTarget = pendingCreate ? findProfile(pendingCreate.connectionId) ?? null : null;
  const dropTarget = pendingDrop ? findProfile(pendingDrop.connectionId) ?? null : null;

  const requestCreate = useCallback((profile: ConnectionProfile): void => {
    if (profile.engine !== "my_sql") {
      return;
    }
    selectConnection(profile.id);
    clearError();
    setCreateError(null);
    // Only the target is recorded here; the dialog owns the name, charset, and collation draft.
    setPendingCreate({ connectionId: profile.id });
  }, [clearError, selectConnection]);

  const cancelCreate = useCallback((): void => {
    if (creating) {
      return;
    }
    setPendingCreate(null);
    setCreateError(null);
  }, [creating]);

  const confirmCreate = useCallback(async (request: CreateDatabaseRequest): Promise<void> => {
    if (!pendingCreate || creating) {
      return;
    }
    const profile = findProfile(pendingCreate.connectionId);
    if (!profile) {
      return;
    }
    const validationError = databaseNameValidationError(request.name);
    if (validationError) {
      setCreateError(validationError);
      return;
    }
    const databaseName = request.name.trim();
    setCreating(true);
    setCreateError(null);
    try {
      const plan = await buildCreateDatabase(
        databaseName,
        request.charset || null,
        request.collation || null,
      );
      if (plan.error !== null) {
        setCreateError(plan.error);
        return;
      }
      await executeQueryOnce(pendingCreate.connectionId, plan.statement);
      onDatabaseCreated(pendingCreate.connectionId);
      setPendingCreate(null);
      showNotice(
        `已在连接“${profile.name}”中创建数据库“${databaseName}”。要浏览它，请把连接的默认数据库改为该库。`,
      );
    } catch (error: unknown) {
      setCreateError(getConnectionActionError(error, "创建数据库失败，请重试。"));
    } finally {
      setCreating(false);
    }
  }, [creating, findProfile, onDatabaseCreated, pendingCreate, showNotice]);

  const requestDrop = useCallback((profile: ConnectionProfile, database: string): void => {
    setDropError(null);
    setPendingDrop({ connectionId: profile.id, database });
  }, []);

  const cancelDrop = useCallback((): void => {
    if (dropping) {
      return;
    }
    setPendingDrop(null);
    setDropError(null);
  }, [dropping]);

  const confirmDrop = useCallback(async (): Promise<void> => {
    if (!pendingDrop || dropping || !findProfile(pendingDrop.connectionId)) {
      return;
    }
    const { connectionId, database } = pendingDrop;
    setDropping(true);
    setDropError(null);
    try {
      await executeQueryOnce(connectionId, `DROP DATABASE ${quoteIdentifier(database)};`);
      onDatabaseDropped(connectionId, database);
      setPendingDrop(null);
      showNotice(`已删除数据库“${database}”。`);
    } catch (error: unknown) {
      setDropError(getConnectionActionError(error, "删除数据库失败，请重试。"));
    } finally {
      setDropping(false);
    }
  }, [dropping, findProfile, onDatabaseDropped, pendingDrop, showNotice]);

  return {
    createError,
    creating,
    createTarget,
    dropError,
    dropping,
    dropTarget,
    dropTargetDatabase: pendingDrop?.database ?? null,
    cancelCreate,
    cancelDrop,
    confirmCreate,
    confirmDrop,
    requestCreate,
    requestDrop,
  };
}
