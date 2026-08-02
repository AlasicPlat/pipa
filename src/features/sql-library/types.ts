import type { Engine } from "../../bindings/Engine";

/** One user-managed common SQL directory scoped to a database engine. */
export interface SqlFolder {
  id: string;
  engine: Engine;
  name: string;
  updatedAt: string;
}

/** One reusable SQL statement or native database command. */
export interface CommonSql {
  id: string;
  engine: Engine;
  folderId: string | null;
  name: string;
  sqlText: string;
  updatedAt: string;
}

/** Complete reusable SQL snapshot for one database engine. */
export interface SqlLibrary {
  folders: SqlFolder[];
  entries: CommonSql[];
}

/** Idempotent directory mutation sent to encrypted local persistence. */
export interface SaveSqlFolderInput {
  id: string;
  engine: Engine;
  name: string;
}

/** Idempotent reusable statement mutation sent to encrypted local persistence. */
export interface SaveCommonSqlInput {
  id: string;
  engine: Engine;
  folderId: string | null;
  name: string;
  sqlText: string;
}
