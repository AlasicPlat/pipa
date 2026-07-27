import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  AlertTriangle,
  Clock,
  Copy,
  Database,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppError } from "../../bindings/AppError";
import type { CellValue } from "../../bindings/CellValue";
import type { ConnectionProfile } from "../../bindings/ConnectionProfile";
import type { QueryColumn } from "../../bindings/QueryColumn";
import { matchesShortcut, useShortcutSettings } from "../commands/shortcutRegistry";
import type { ResolvedTheme } from "../preferences/theme";
import { executeQueryOnce, type QueryExecutionResult } from "../query/executeQueryOnce";
import { QueryWorkspace } from "../query/QueryWorkspace";
import type { WorkspaceTab } from "../query/useWorkspacePersistence";

interface RedisWorkspaceProps {
  profile: ConnectionProfile;
  tab: WorkspaceTab;
  theme: ResolvedTheme;
  persistenceError: string | null;
  onDatabaseChange: (database: string) => void;
  onRetryPersistence: () => Promise<void>;
  onRunningChange: (tabId: string, running: boolean) => void;
  onSqlChange: (tabId: string, sqlText: string) => void;
}

type RedisDataType = "all" | "string" | "hash" | "list" | "set" | "zset" | "stream";
type CreatableRedisDataType = Exclude<RedisDataType, "all">;
type RedisWorkspaceMode = "browser" | "cli";

interface RedisKeyDetails {
  key: string;
  type: string;
  ttl: number | null;
  memoryBytes: number | null;
  columns: QueryColumn[];
  rows: CellValue[][];
}

interface MutationPlan {
  title: string;
  summary: string;
  commands: string[];
  destructive?: boolean;
  nextKey?: string | null;
  refreshKeys?: boolean;
}

const REDIS_DATA_TYPES: ReadonlyArray<{ value: RedisDataType; label: string }> = [
  { value: "all", label: "全部" },
  { value: "string", label: "String" },
  { value: "hash", label: "Hash" },
  { value: "list", label: "List" },
  { value: "set", label: "Set" },
  { value: "zset", label: "ZSet" },
  { value: "stream", label: "Stream" },
];

const ATOMIC_CREATE_WITH_TTL_SCRIPT = [
  "local result=redis.call(ARGV[1],KEYS[1],unpack(ARGV,2,#ARGV-1))",
  "redis.call('EXPIRE',KEYS[1],ARGV[#ARGV])",
  "return result",
].join(";");

/**
 * Quotes one exact Redis argument using the subset accepted by the backend parser.
 * @param value - UTF-8 key, field, member, or value.
 * @returns A double-quoted redis-cli-compatible argument.
 * Side effects: none.
 */
function quoteRedisArgument(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, "\\\"")
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")}"`;
}

/**
 * Encodes Base64 editor content as one binary-safe redis-cli argument.
 * @param value - Base64 text representing the exact Redis byte sequence.
 * @returns A quoted hexadecimal-escape argument, or `null` for invalid Base64.
 * Side effects: none.
 */
function quoteRedisBinaryArgument(value: string): string | null {
  try {
    const bytes = window.atob(value.trim());
    const escaped = Array.from(
      bytes,
      (byte) => `\\x${byte.charCodeAt(0).toString(16).padStart(2, "0")}`,
    ).join("");
    return `"${escaped}"`;
  } catch {
    return null;
  }
}

/**
 * Converts one transport-safe result cell into editable display text.
 * @param cell - Optional result cell emitted by the query channel.
 * @returns A human-readable, lossless-enough string for Redis operations.
 * Side effects: none.
 */
function cellText(cell: CellValue | undefined): string {
  if (!cell || cell.kind === "null") {
    return "";
  }
  if (cell.kind === "boolean") {
    return cell.value ? "true" : "false";
  }
  if (cell.kind === "json") {
    return JSON.stringify(cell.value);
  }
  if (cell.kind === "binary") {
    return `base64:${cell.value}`;
  }
  return String(cell.value);
}

/**
 * Reads the first scalar value from a complete internal query.
 * @param result - Completed query result.
 * @returns The first cell as text, or an empty string for an absent value.
 * Side effects: none.
 */
function scalarText(result: QueryExecutionResult): string {
  return cellText(result.rows[0]?.[0]);
}

/**
 * Converts a Redis inspection command persisted by the sidebar back into its exact key.
 * @param sqlText - Persisted command editor contents.
 * @returns The decoded key, or `null` when the tab was not created by key inspection.
 * Side effects: none.
 */
function inspectionKeyFromSql(sqlText: string): string | null {
  const quoted = sqlText.match(/^TYPE\s+"((?:\\.|[^"])*)";?/iu);
  if (quoted?.[1] !== undefined) {
    return quoted[1].replace(/\\([\\nrt"])/gu, (_match, escaped: string) => ({
      "\\": "\\",
      n: "\n",
      r: "\r",
      t: "\t",
      "\"": "\"",
    })[escaped] ?? escaped);
  }
  const bare = sqlText.match(/^TYPE\s+([^\s;]+);?/iu);
  return bare?.[1] ?? null;
}

/**
 * Formats an environment for the compact immutable connection strip.
 * @param environment - Stored profile environment.
 * @returns A short Chinese label.
 * Side effects: none.
 */
function environmentLabel(environment: ConnectionProfile["environment"]): string {
  return { production: "生产", development: "开发", unspecified: "未指定" }[environment];
}

/**
 * Formats byte counts with one compact binary unit.
 * @param bytes - Redis-reported memory usage.
 * @returns A readable size, or an em dash when unavailable.
 * Side effects: none.
 */
function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Formats Redis TTL sentinel values and positive seconds.
 * @param ttl - TTL in seconds, `-1` for persistent, or `-2` for missing.
 * @returns A concise status label.
 * Side effects: none.
 */
function formatTtl(ttl: number | null): string {
  if (ttl === null) {
    return "—";
  }
  if (ttl === -1) {
    return "永久";
  }
  if (ttl === -2) {
    return "已失效";
  }
  if (ttl >= 86400) {
    return `${Math.floor(ttl / 86400)} 天`;
  }
  if (ttl >= 3600) {
    return `${Math.floor(ttl / 3600)} 小时`;
  }
  if (ttl >= 60) {
    return `${Math.floor(ttl / 60)} 分钟`;
  }
  return `${Math.max(0, ttl)} 秒`;
}

/**
 * Extracts a safe display message from a backend or clipboard error.
 * @param error - Unknown rejected value.
 * @returns A concise user-facing message.
 * Side effects: none.
 */
function redisErrorMessage(error: unknown): string {
  if (
    typeof error === "object"
    && error !== null
    && "message" in error
    && typeof error.message === "string"
  ) {
    const technicalDetails = "technicalDetails" in error
      && typeof error.technicalDetails === "string"
      ? error.technicalDetails
      : null;
    return technicalDetails ? `${error.message}：${technicalDetails}` : error.message;
  }
  return "Redis 操作失败，请重试。";
}

/**
 * Builds the bounded read command appropriate for one Redis value type.
 * @param type - Redis TYPE response.
 * @param key - Exact key name.
 * @returns A non-mutating command, or `null` when the type has no structured reader.
 * Side effects: none.
 */
function valueCommand(type: string, key: string): string | null {
  const quotedKey = quoteRedisArgument(key);
  switch (type.toLowerCase()) {
    case "string":
      return `GET ${quotedKey}`;
    case "hash":
      return `HSCAN ${quotedKey} 0 MATCH "*" COUNT 200`;
    case "list":
      return `LRANGE ${quotedKey} 0 199`;
    case "set":
      return `SSCAN ${quotedKey} 0 MATCH "*" COUNT 200`;
    case "zset":
      return `ZSCAN ${quotedKey} 0 MATCH "*" COUNT 200`;
    case "stream":
      return `XRANGE ${quotedKey} - + COUNT 100`;
    case "rejson-rl":
    case "json":
      return `JSON.GET ${quotedKey}`;
    default:
      return null;
  }
}

/**
 * Renders one connection-bound Redis key browser beside the existing command workbench.
 * @param props - Fixed connection, persisted tab, theme, and workspace callbacks.
 * @returns The Redis browser and CLI surfaces for one tab.
 * Side effects: runs bounded Redis reads and explicit, confirmed mutations through Tauri.
 */
export function RedisWorkspace({
  profile,
  tab,
  theme,
  persistenceError,
  onDatabaseChange,
  onRetryPersistence,
  onRunningChange,
  onSqlChange,
}: RedisWorkspaceProps) {
  const shortcuts = useShortcutSettings();
  const initialKey = useMemo(() => inspectionKeyFromSql(tab.sqlText), [tab.id]);
  const [mode, setMode] = useState<RedisWorkspaceMode>(
    initialKey || tab.sqlText.trim().toUpperCase() === "PING" ? "browser" : "cli",
  );
  const [searchDraft, setSearchDraft] = useState("");
  const [searchPattern, setSearchPattern] = useState("*");
  const [typeFilter, setTypeFilter] = useState<RedisDataType>("all");
  const [keys, setKeys] = useState<string[]>([]);
  const [cursor, setCursor] = useState("0");
  const [selectedKey, setSelectedKey] = useState<string | null>(initialKey);
  const [details, setDetails] = useState<RedisKeyDetails | null>(null);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [cliRunning, setCliRunning] = useState(false);
  const [mutationRunning, setMutationRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [pendingMutation, setPendingMutation] = useState<MutationPlan | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<CreatableRedisDataType>("string");
  const [createName, setCreateName] = useState("");
  const [createValue, setCreateValue] = useState("");
  const [createAuxiliary, setCreateAuxiliary] = useState("");
  const [createTtl, setCreateTtl] = useState("");
  const [stringDraft, setStringDraft] = useState("");
  const [stringDraftIsBinary, setStringDraftIsBinary] = useState(false);
  const [entryPrimary, setEntryPrimary] = useState("");
  const [entrySecondary, setEntrySecondary] = useState("");
  const [ttlDraft, setTtlDraft] = useState("");
  const [renameDraft, setRenameDraft] = useState("");
  const [databaseDraft, setDatabaseDraft] = useState(profile.database ?? "0");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const keyRequestIdRef = useRef(0);
  const detailRequestIdRef = useRef(0);
  const browserTabId = `${tab.id}-redis-browser-tab`;
  const browserPanelId = `${tab.id}-redis-browser-panel`;
  const cliTabId = `${tab.id}-redis-cli-tab`;
  const cliPanelId = `${tab.id}-redis-cli-panel`;

  useEffect(() => {
    setDatabaseDraft(profile.database ?? "0");
  }, [profile.database]);

  /**
   * Validates and applies the database number entered in the workspace context strip.
   * Parameters: none.
   * @returns Nothing (`void`).
   * Side effects: clears stale key details and requests an app-level Redis database switch.
   */
  function commitDatabaseDraft(): void {
    const database = Number(databaseDraft);
    if (!Number.isInteger(database) || database < 0) {
      setDatabaseDraft(profile.database ?? "0");
      setError("Redis 数据库编号必须是非负整数。");
      return;
    }
    const normalizedDatabase = String(database);
    setDatabaseDraft(normalizedDatabase);
    if (normalizedDatabase === (profile.database ?? "0")) {
      return;
    }
    detailRequestIdRef.current += 1;
    setSelectedKey(null);
    setDetails(null);
    onDatabaseChange(normalizedDatabase);
  }

  /**
   * Applies Enter and restores the active database with Escape in the DB input.
   * @param event - Keyboard event raised by the database number input.
   * @returns Nothing (`void`).
   * Side effects: may blur the input, apply a switch, or restore its current value.
   */
  function handleDatabaseInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setDatabaseDraft(profile.database ?? "0");
      event.currentTarget.blur();
    }
  }

  /**
   * Loads one bounded SCAN page and optionally replaces the current key list.
   * @param nextCursor - Cursor returned by the previous SCAN page.
   * @param replace - Whether this is a fresh search rather than pagination.
   * @returns A promise settled after list state is synchronized.
   * Side effects: runs SCAN and updates visible keys/cursor.
   */
  const loadKeys = useCallback(async (nextCursor: string, replace: boolean): Promise<void> => {
    const requestId = replace
      ? keyRequestIdRef.current + 1
      : keyRequestIdRef.current;
    if (replace) {
      keyRequestIdRef.current = requestId;
    }
    setLoadingKeys(true);
    setError(null);
    try {
      const scanPattern = searchPattern === "*" || /[*?[\]]/u.test(searchPattern)
        ? searchPattern
        : `*${searchPattern}*`;
      const typeClause = typeFilter === "all" ? "" : ` TYPE ${typeFilter}`;
      const result = await executeQueryOnce(
        profile.id,
        `SCAN ${nextCursor} MATCH ${quoteRedisArgument(scanPattern)} COUNT 200${typeClause}`,
        profile.database ?? "0",
      );
      const nextKeys = result.rows
        .map((row) => cellText(row[1]))
        .filter((key) => key.length > 0);
      const returnedCursor = result.rows[0] ? cellText(result.rows[0][0]) : "0";
      if (keyRequestIdRef.current !== requestId) {
        return;
      }
      setKeys((current) => {
        const combined = replace ? nextKeys : [...current, ...nextKeys];
        return [...new Set(combined)];
      });
      setCursor(returnedCursor || "0");
    } catch (loadError: unknown) {
      if (keyRequestIdRef.current === requestId) {
        setError(redisErrorMessage(loadError));
      }
    } finally {
      if (keyRequestIdRef.current === requestId) {
        setLoadingKeys(false);
      }
    }
  }, [profile.database, profile.id, searchPattern, typeFilter]);

  /**
   * Loads key metadata and a bounded type-specific value preview.
   * @param key - Exact key selected from SCAN or created by a mutation.
   * @returns A promise settled after the latest selection wins.
   * Side effects: runs TYPE, TTL, MEMORY USAGE, and one type-specific read.
   */
  const loadDetails = useCallback(async (key: string): Promise<void> => {
    const requestId = detailRequestIdRef.current + 1;
    detailRequestIdRef.current = requestId;
    setSelectedKey(key);
    setLoadingDetails(true);
    setError(null);
    try {
      const quotedKey = quoteRedisArgument(key);
      const database = profile.database ?? "0";
      const typeResult = await executeQueryOnce(profile.id, `TYPE ${quotedKey}`, database);
      const type = scalarText(typeResult);
      if (type.toLowerCase() === "none") {
        throw {
          code: "not_found",
          message: "该键已不存在，键列表可能已发生变化。",
          technicalDetails: null,
          retryable: true,
        } satisfies AppError;
      }
      const command = valueCommand(type, key);
      const [ttlResult, memoryResult, valueResult] = await Promise.all([
        executeQueryOnce(profile.id, `TTL ${quotedKey}`, database).catch(() => null),
        executeQueryOnce(profile.id, `MEMORY USAGE ${quotedKey}`, database).catch(() => null),
        command
          ? executeQueryOnce(profile.id, command, database)
          : Promise.resolve({ columns: [], rows: [], affectedRows: 0 }),
      ]);
      if (detailRequestIdRef.current !== requestId) {
        return;
      }
      const ttl = ttlResult ? Number.parseInt(scalarText(ttlResult), 10) : Number.NaN;
      const memoryBytes = memoryResult
        ? Number.parseInt(scalarText(memoryResult), 10)
        : Number.NaN;
      const nextDetails: RedisKeyDetails = {
        key,
        type,
        ttl: Number.isNaN(ttl) ? null : ttl,
        memoryBytes: Number.isNaN(memoryBytes) ? null : memoryBytes,
        columns: valueResult.columns,
        rows: valueResult.rows,
      };
      setDetails(nextDetails);
      const scalarCell = valueResult.rows[0]?.[0];
      setStringDraft(scalarCell?.kind === "binary" ? scalarCell.value : cellText(scalarCell));
      setStringDraftIsBinary(scalarCell?.kind === "binary");
      setRenameDraft(key);
      setTtlDraft(nextDetails.ttl !== null && nextDetails.ttl >= 0 ? String(nextDetails.ttl) : "");
      setEntryPrimary("");
      setEntrySecondary("");
    } catch (loadError: unknown) {
      if (detailRequestIdRef.current === requestId) {
        setDetails(null);
        setError(redisErrorMessage(loadError));
      }
    } finally {
      if (detailRequestIdRef.current === requestId) {
        setLoadingDetails(false);
      }
    }
  }, [profile.database, profile.id]);

  /**
   * Executes a validated mutation plan and restores browser state around its result.
   * @param plan - Commands and post-success navigation chosen by the initiating control.
   * @returns A promise settled after commands and refreshes complete.
   * Side effects: mutates Redis, refreshes SCAN/details, and reports status.
   */
  const executeMutation = useCallback(async (plan: MutationPlan): Promise<void> => {
    if (mutationRunning) {
      return;
    }
    setMutationRunning(true);
    setPendingMutation(null);
    setError(null);
    setFeedback(null);
    try {
      for (const command of plan.commands) {
        await executeQueryOnce(profile.id, command, profile.database ?? "0");
      }
      setFeedback(`${plan.title}成功`);
      if (plan.refreshKeys) {
        await loadKeys("0", true);
      }
      if (plan.nextKey === null) {
        detailRequestIdRef.current += 1;
        setSelectedKey(null);
        setDetails(null);
      } else {
        const keyToLoad = plan.nextKey ?? selectedKey;
        if (keyToLoad) {
          await loadDetails(keyToLoad);
        }
      }
    } catch (mutationError: unknown) {
      setError(redisErrorMessage(mutationError));
    } finally {
      setMutationRunning(false);
    }
  }, [loadDetails, loadKeys, mutationRunning, profile.database, profile.id, selectedKey]);

  /**
   * Mirrors CLI execution state so its editor cannot be unmounted mid-command.
   * @param tabId - Persisted Redis workspace tab.
   * @param running - Whether the native command is still active.
   * @returns Nothing (`void`).
   * Side effects: updates the local mode guard and the app-level busy tab.
   */
  const handleCliRunningChange = useCallback((tabId: string, running: boolean): void => {
    setCliRunning(running);
    onRunningChange(tabId, running);
  }, [onRunningChange]);

  /**
   * Applies the production safety gate or executes a non-destructive development write.
   * @param plan - Validated Redis mutation plan.
   * @returns Nothing (`void`).
   * Side effects: opens a confirmation layer or starts the mutation.
   */
  function requestMutation(plan: MutationPlan): void {
    if (profile.environment === "production" || plan.destructive) {
      setPendingMutation(plan);
      return;
    }
    void executeMutation(plan);
  }

  /**
   * Starts a fresh key search from user-visible pattern and type filters.
   * @param event - Optional form submission event.
   * @returns Nothing (`void`).
   * Side effects: resets cursor and requests the first SCAN page.
   */
  function submitSearch(event?: React.FormEvent): void {
    event?.preventDefault();
    setSearchPattern(searchDraft.trim() || "*");
  }

  /**
   * Copies exact key content without placing credentials or values in status logs.
   * @returns A promise settled after the OS clipboard responds.
   * Side effects: writes the selected key name to the system clipboard.
   */
  async function copySelectedKey(): Promise<void> {
    if (!selectedKey) {
      return;
    }
    try {
      await writeText(selectedKey);
      setFeedback("已复制键名");
    } catch (copyError: unknown) {
      setError(redisErrorMessage(copyError));
    }
  }

  /**
   * Creates the command plan for the visible new-key form.
   * @returns Nothing (`void`).
   * Side effects: validates form state and requests a Redis mutation.
   */
  function createKey(): void {
    const name = createName.trim();
    if (!name) {
      setError("请输入键名。");
      return;
    }
    const key = quoteRedisArgument(name);
    const value = quoteRedisArgument(createValue);
    const auxiliary = quoteRedisArgument(createAuxiliary);
    const ttl = createTtl.trim() ? Number(createTtl) : null;
    if (ttl !== null && (!Number.isInteger(ttl) || ttl <= 0)) {
      setError("TTL 必须是大于 0 的整数秒数。");
      return;
    }
    let commandName: string;
    let commandArguments: string[];
    switch (createType) {
      case "string":
        commandName = "SET";
        commandArguments = [value];
        break;
      case "hash":
        if (!createAuxiliary) {
          setError("Hash 需要字段名。");
          return;
        }
        commandName = "HSET";
        commandArguments = [auxiliary, value];
        break;
      case "list":
        commandName = "RPUSH";
        commandArguments = [value];
        break;
      case "set":
        commandName = "SADD";
        commandArguments = [value];
        break;
      case "zset": {
        const score = Number(createAuxiliary);
        if (!Number.isFinite(score)) {
          setError("ZSet 需要有效分数。");
          return;
        }
        commandName = "ZADD";
        commandArguments = [quoteRedisArgument(String(score)), value];
        break;
      }
      case "stream":
        if (!createAuxiliary) {
          setError("Stream 需要字段名。");
          return;
        }
        commandName = "XADD";
        commandArguments = [quoteRedisArgument("*"), auxiliary, value];
        break;
    }
    const command = ttl === null
      ? [commandName, key, ...commandArguments].join(" ")
      : createType === "string"
        ? [commandName, key, ...commandArguments, "EX", String(ttl)].join(" ")
        : [
            "EVAL",
            quoteRedisArgument(ATOMIC_CREATE_WITH_TTL_SCRIPT),
            "1",
            key,
            quoteRedisArgument(commandName),
            ...commandArguments,
            String(ttl),
          ].join(" ");
    requestMutation({
      title: "创建键",
      summary: `创建 ${createType} 键“${name}”${ttl ? `，并设置 ${ttl} 秒 TTL` : ""}。`,
      commands: [command],
      nextKey: name,
      refreshKeys: true,
    });
    setCreateOpen(false);
  }

  /**
   * Saves a String or RedisJSON value while preserving an existing String TTL.
   * @returns Nothing (`void`).
   * Side effects: requests SET or JSON.SET for the selected key.
   */
  function saveScalarValue(): void {
    if (!details) {
      return;
    }
    const key = quoteRedisArgument(details.key);
    const isJson = ["json", "rejson-rl"].includes(details.type.toLowerCase());
    const valueArgument = stringDraftIsBinary
      ? quoteRedisBinaryArgument(stringDraft)
      : quoteRedisArgument(stringDraft);
    if (!valueArgument) {
      setError("二进制值必须是有效的 Base64。");
      return;
    }
    if (isJson) {
      try {
        JSON.parse(stringDraft);
      } catch {
        setError("JSON 内容格式无效。");
        return;
      }
    }
    requestMutation({
      title: "保存值",
      summary: `更新“${details.key}”的${isJson ? " JSON" : ""}内容。`,
      commands: [
        isJson
          ? `JSON.SET ${key} $ ${quoteRedisArgument(stringDraft)}`
          : `SET ${key} ${valueArgument} KEEPTTL`,
      ],
    });
  }

  /**
   * Adds or updates one collection entry based on the selected key type.
   * @param position - Optional list insertion side.
   * @returns Nothing (`void`).
   * Side effects: validates form state and requests one collection mutation.
   */
  function saveCollectionEntry(position: "left" | "right" = "right"): void {
    if (!details) {
      return;
    }
    const key = quoteRedisArgument(details.key);
    const primary = quoteRedisArgument(entryPrimary);
    const secondary = quoteRedisArgument(entrySecondary);
    let command: string;
    switch (details.type.toLowerCase()) {
      case "hash":
        if (!entryPrimary) {
          setError("请输入 Hash 字段名。");
          return;
        }
        command = `HSET ${key} ${primary} ${secondary}`;
        break;
      case "list":
        command = `${position === "left" ? "LPUSH" : "RPUSH"} ${key} ${primary}`;
        break;
      case "set":
        command = `SADD ${key} ${primary}`;
        break;
      case "zset": {
        const score = Number(entrySecondary);
        if (!Number.isFinite(score)) {
          setError("请输入有效的 ZSet 分数。");
          return;
        }
        command = `ZADD ${key} ${score} ${primary}`;
        break;
      }
      case "stream":
        if (!entryPrimary) {
          setError("请输入 Stream 字段名。");
          return;
        }
        command = `XADD ${key} * ${primary} ${secondary}`;
        break;
      default:
        return;
    }
    requestMutation({
      title: "保存元素",
      summary: `更新“${details.key}”中的一个元素。`,
      commands: [command],
    });
  }

  /**
   * Deletes one Hash, Set, or ZSet entry after the applicable safety gate.
   * @param primary - Exact field or member.
   * @returns Nothing (`void`).
   * Side effects: requests a targeted Redis collection mutation.
   */
  function deleteCollectionEntry(primary: CellValue): void {
    if (!details) {
      return;
    }
    const type = details.type.toLowerCase();
    const commandName = type === "hash" ? "HDEL" : type === "set" ? "SREM" : "ZREM";
    const primaryArgument = primary.kind === "binary"
      ? quoteRedisBinaryArgument(primary.value)
      : quoteRedisArgument(cellText(primary));
    if (!primaryArgument) {
      setError("无法解析该二进制元素。");
      return;
    }
    requestMutation({
      title: "删除元素",
      summary: `从“${details.key}”中删除“${cellText(primary)}”。`,
      commands: [
        `${commandName} ${quoteRedisArgument(details.key)} ${primaryArgument}`,
      ],
      destructive: true,
    });
  }

  useEffect(() => {
    void loadKeys("0", true);
  }, [loadKeys]);

  useEffect(() => {
    if (initialKey) {
      void loadDetails(initialKey);
    }
  }, [initialKey, loadDetails]);

  useEffect(() => {
    if (!feedback) {
      return;
    }
    const timeoutId = window.setTimeout(() => setFeedback(null), 2800);
    return () => window.clearTimeout(timeoutId);
  }, [feedback]);

  useEffect(() => {
    if (!createOpen && !pendingMutation) {
      return;
    }
    /** Closes the topmost idle Redis dialog with the conventional Escape key. */
    function handleDialogEscape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || mutationRunning) {
        return;
      }
      if (pendingMutation) {
        setPendingMutation(null);
      } else {
        setCreateOpen(false);
      }
    }
    document.addEventListener("keydown", handleDialogEscape);
    return () => document.removeEventListener("keydown", handleDialogEscape);
  }, [createOpen, mutationRunning, pendingMutation]);

  useEffect(() => {
    if (mode !== "browser") {
      return;
    }
    /** Maps shared run/find shortcuts to refresh and key search while the browser owns focus. */
    function handleBrowserShortcut(event: KeyboardEvent): void {
      if (document.querySelector("[aria-modal='true']")) {
        return;
      }
      if (matchesShortcut(event, shortcuts.bindings.find)) {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (!matchesShortcut(event, shortcuts.bindings.executeQuery)) {
        return;
      }
      event.preventDefault();
      if (selectedKey) {
        void loadDetails(selectedKey);
      } else {
        void loadKeys("0", true);
      }
    }
    document.addEventListener("keydown", handleBrowserShortcut, true);
    return () => document.removeEventListener("keydown", handleBrowserShortcut, true);
  }, [
    loadDetails,
    loadKeys,
    mode,
    selectedKey,
    shortcuts.bindings.executeQuery,
    shortcuts.bindings.find,
  ]);

  const detailType = details?.type.toLowerCase() ?? "";
  const collectionOffset = 1;
  const collectionRows = (details?.rows ?? []).filter(
    (row) => row[collectionOffset]?.kind !== "null",
  );
  const firstLabel = detailType === "hash" || detailType === "stream"
    ? detailType === "stream" ? "消息" : "字段"
    : detailType === "zset" ? "成员" : "值";
  const secondLabel = detailType === "zset" ? "分数" : "值";

  return (
    <section className="redis-workspace" aria-label="Redis 工作区">
      <header className="redis-workspace__modebar">
        <span className="redis-workspace__context">
          <strong>{profile.name}</strong>
          <span>{profile.host}:{profile.port}</span>
          <label className="redis-workspace__database">
            <span>DB</span>
            <input
              aria-label="切换 Redis 数据库"
              disabled={cliRunning || mutationRunning}
              inputMode="numeric"
              min={0}
              onBlur={commitDatabaseDraft}
              onChange={(event) => setDatabaseDraft(event.target.value)}
              onKeyDown={handleDatabaseInputKeyDown}
              type="number"
              value={databaseDraft}
            />
          </label>
          <span className={`environment environment--${profile.environment}`}>
            {environmentLabel(profile.environment)}
          </span>
        </span>
        <span className="redis-workspace__modes" aria-label="Redis 工作区模式" role="tablist">
          <button
            aria-controls={browserPanelId}
            aria-selected={mode === "browser"}
            className={mode === "browser" ? "is-active" : ""}
            disabled={cliRunning}
            id={browserTabId}
            onClick={() => setMode("browser")}
            role="tab"
            type="button"
          >
            <Database size={13} aria-hidden="true" />
            键浏览器
          </button>
          <button
            aria-controls={cliPanelId}
            aria-selected={mode === "cli"}
            className={mode === "cli" ? "is-active" : ""}
            id={cliTabId}
            onClick={() => setMode("cli")}
            role="tab"
            type="button"
          >
            <Terminal size={13} aria-hidden="true" />
            命令工作台
          </button>
        </span>
        {profile.environment === "production" ? (
          <span className="redis-workspace__production">
            <AlertTriangle size={12} aria-hidden="true" />
            写操作需确认
          </span>
        ) : null}
      </header>

      <div
        aria-labelledby={browserTabId}
        className="redis-workspace__pane"
        hidden={mode !== "browser"}
        id={browserPanelId}
        role="tabpanel"
      >
        <aside className="redis-key-browser" aria-label="Redis 键列表">
          <div className="redis-key-browser__toolbar">
            <form onSubmit={submitSearch} role="search">
              <Search size={13} aria-hidden="true" />
              <input
                aria-label="搜索 Redis 键"
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="搜索键，支持 * ? []"
                ref={searchInputRef}
                type="search"
                value={searchDraft}
              />
              {searchDraft ? (
                <button
                  aria-label="清空键搜索"
                  onClick={() => {
                    setSearchDraft("");
                    setSearchPattern("*");
                  }}
                  type="button"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              ) : null}
              <button aria-label="执行键搜索" type="submit">
                搜索
              </button>
            </form>
            <span>
              <button
                aria-label="刷新键列表"
                disabled={loadingKeys}
                onClick={() => void loadKeys("0", true)}
                title="刷新"
                type="button"
              >
                <RefreshCw className={loadingKeys ? "spin" : ""} size={13} aria-hidden="true" />
              </button>
              <button
                onClick={() => {
                  setError(null);
                  setCreateName("");
                  setCreateValue("");
                  setCreateAuxiliary("");
                  setCreateTtl("");
                  setCreateOpen(true);
                }}
                type="button"
              >
                <Plus size={13} aria-hidden="true" />
                新建键
              </button>
            </span>
          </div>
          <div className="redis-type-filter" aria-label="按数据类型筛选">
            {REDIS_DATA_TYPES.map((type) => (
              <button
                aria-pressed={typeFilter === type.value}
                className={typeFilter === type.value ? "is-active" : ""}
                key={type.value}
                onClick={() => {
                  setTypeFilter(type.value);
                  setCursor("0");
                }}
                type="button"
              >
                {type.label}
              </button>
            ))}
          </div>
          <div className="redis-key-browser__summary">
            <span>{searchPattern === "*" ? "当前数据库" : `匹配 ${searchPattern}`}</span>
            <span>{keys.length} 个已加载</span>
          </div>
          <div className="redis-key-list" role="listbox" aria-label="Redis 键">
            {keys.map((key) => {
              const namespace = key.includes(":") ? key.split(":", 1)[0] : null;
              return (
                <button
                  aria-selected={selectedKey === key}
                  className={selectedKey === key ? "is-active" : ""}
                  key={key}
                  onClick={() => void loadDetails(key)}
                  role="option"
                  title={key}
                  type="button"
                >
                  <Database size={12} aria-hidden="true" />
                  <span>{key}</span>
                  {namespace ? <small>{namespace}</small> : null}
                </button>
              );
            })}
            {!loadingKeys && keys.length === 0 ? (
              <p>没有匹配的键。可调整搜索词或类型。</p>
            ) : null}
          </div>
          {cursor !== "0" ? (
            <button
              className="redis-key-browser__more"
              disabled={loadingKeys}
              onClick={() => void loadKeys(cursor, false)}
              type="button"
            >
              {loadingKeys ? "正在加载…" : "继续加载"}
            </button>
          ) : null}
        </aside>

        <main className="redis-key-details" aria-label="Redis 键详情">
          {error ? (
            <div className="redis-inline-message redis-inline-message--error" role="alert">
              <AlertTriangle size={14} aria-hidden="true" />
              <span>{error}</span>
              <button aria-label="关闭错误" onClick={() => setError(null)} type="button">
                <X size={12} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {feedback ? (
            <div className="redis-inline-message" role="status">{feedback}</div>
          ) : null}

          {loadingDetails ? (
            <div className="redis-detail-empty" role="status">
              <RefreshCw className="spin" size={20} aria-hidden="true" />
              <strong>正在读取键</strong>
              <span>检查类型、TTL、内存和数据预览…</span>
            </div>
          ) : details ? (
            <>
              <header className="redis-key-details__header">
                <span>
                  <small>KEY</small>
                  <h2 title={details.key}>{details.key}</h2>
                </span>
                <span className="redis-key-details__actions">
                  <button onClick={() => void copySelectedKey()} title="复制键名" type="button">
                    <Copy size={13} aria-hidden="true" />
                    复制
                  </button>
                  <button
                    disabled={mutationRunning}
                    onClick={() => void loadDetails(details.key)}
                    title="刷新键"
                    type="button"
                  >
                    <RefreshCw size={13} aria-hidden="true" />
                    刷新
                  </button>
                  <button
                    className="is-danger"
                    disabled={mutationRunning}
                    onClick={() => requestMutation({
                      title: "删除键",
                      summary: `永久删除“${details.key}”。此操作无法撤销。`,
                      commands: [`DEL ${quoteRedisArgument(details.key)}`],
                      destructive: true,
                      nextKey: null,
                      refreshKeys: true,
                    })}
                    type="button"
                  >
                    <Trash2 size={13} aria-hidden="true" />
                    删除
                  </button>
                </span>
              </header>
              <div className="redis-key-metadata">
                <span><small>类型</small><strong>{details.type}</strong></span>
                <span><small>TTL</small><strong>{formatTtl(details.ttl)}</strong></span>
                <span><small>内存</small><strong>{formatBytes(details.memoryBytes)}</strong></span>
                <span><small>预览</small><strong>最多 {detailType === "stream" ? "100" : "200"} 项</strong></span>
              </div>

              <section className="redis-key-details__section" aria-labelledby="redis-value-title">
                <header>
                  <span>
                    <h3 id="redis-value-title">数据</h3>
                    <p>按数据类型提供常用编辑；大型集合仅读取首个有界分页。</p>
                  </span>
                </header>
                {["string", "json", "rejson-rl"].includes(detailType) ? (
                  <div className="redis-scalar-editor">
                    <textarea
                      aria-label={stringDraftIsBinary ? "Redis 二进制键值（Base64）" : "Redis 键值"}
                      onChange={(event) => setStringDraft(event.target.value)}
                      spellCheck={false}
                      value={stringDraft}
                    />
                    {stringDraftIsBinary ? (
                      <span className="redis-binary-note">二进制值以 Base64 安全编辑</span>
                    ) : null}
                    <button
                      disabled={mutationRunning}
                      onClick={saveScalarValue}
                      type="button"
                    >
                      <Save size={13} aria-hidden="true" />
                      保存值
                    </button>
                  </div>
                ) : collectionRows.length > 0 ? (
                  <div className="redis-collection-table">
                    <table>
                      <thead>
                        <tr>
                          {detailType === "list" || detailType === "stream" ? <th>索引 / ID</th> : null}
                          <th>{firstLabel}</th>
                          {["hash", "zset"].includes(detailType) ? <th>{secondLabel}</th> : null}
                          {["hash", "set", "zset"].includes(detailType) ? <th aria-label="操作" /> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {collectionRows.map((row, index) => {
                          const primaryCell = row[collectionOffset];
                          const secondaryCell = row[collectionOffset + 1];
                          const primary = cellText(primaryCell);
                          const secondary = cellText(row[collectionOffset + 1]);
                          const hasBinaryEntry = primaryCell?.kind === "binary"
                            || secondaryCell?.kind === "binary";
                          return (
                            <tr key={`${primary}:${index}`}>
                              {detailType === "list" || detailType === "stream"
                                ? <td className="redis-collection-table__index">{cellText(row[0])}</td>
                                : null}
                              <td title={primary}>{primary || <em>空值</em>}</td>
                              {["hash", "zset"].includes(detailType)
                                ? <td title={secondary}>{secondary || <em>空值</em>}</td>
                                : null}
                              {["hash", "set", "zset"].includes(detailType) ? (
                                <td>
                                  {detailType !== "set" ? (
                                    <button
                                      aria-label={`编辑 ${primary}`}
                                      disabled={hasBinaryEntry}
                                      onClick={() => {
                                        setEntryPrimary(primary);
                                        setEntrySecondary(secondary);
                                      }}
                                      title={hasBinaryEntry ? "二进制元素请使用命令工作台编辑" : "编辑"}
                                      type="button"
                                    >
                                      <Pencil size={12} aria-hidden="true" />
                                    </button>
                                  ) : null}
                                  <button
                                    aria-label={`删除 ${primary}`}
                                    disabled={mutationRunning}
                                    onClick={() => {
                                      if (primaryCell) {
                                        deleteCollectionEntry(primaryCell);
                                      }
                                    }}
                                    title="删除"
                                    type="button"
                                  >
                                    <Trash2 size={12} aria-hidden="true" />
                                  </button>
                                </td>
                              ) : null}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="redis-detail-empty redis-detail-empty--compact">
                    <strong>{valueCommand(details.type, details.key) ? "该键当前为空" : "暂不支持结构化预览"}</strong>
                    <span>可切换到命令工作台执行更专业的 Redis 命令。</span>
                  </div>
                )}

                {["hash", "list", "set", "zset", "stream"].includes(detailType) ? (
                  <div className="redis-entry-form">
                    <label>
                      <span>{firstLabel}</span>
                      <input
                        onChange={(event) => setEntryPrimary(event.target.value)}
                        placeholder={detailType === "list" || detailType === "set" ? "输入值" : `输入${firstLabel}`}
                        value={entryPrimary}
                      />
                    </label>
                    {["hash", "zset", "stream"].includes(detailType) ? (
                      <label>
                        <span>{secondLabel}</span>
                        <input
                          onChange={(event) => setEntrySecondary(event.target.value)}
                          placeholder={`输入${secondLabel}`}
                          value={entrySecondary}
                        />
                      </label>
                    ) : null}
                    <span>
                      {detailType === "list" ? (
                        <button disabled={mutationRunning} onClick={() => saveCollectionEntry("left")} type="button">
                          从左添加
                        </button>
                      ) : null}
                      <button disabled={mutationRunning} onClick={() => saveCollectionEntry("right")} type="button">
                        <Plus size={13} aria-hidden="true" />
                        {detailType === "list" ? "从右添加" : detailType === "stream" ? "追加消息" : "保存元素"}
                      </button>
                    </span>
                  </div>
                ) : null}
              </section>

              <section className="redis-key-details__section redis-key-operations" aria-labelledby="redis-operations-title">
                <header>
                  <span>
                    <h3 id="redis-operations-title">键操作</h3>
                    <p>修改过期时间或重命名当前键。</p>
                  </span>
                </header>
                <div className="redis-operation-row">
                  <Clock size={14} aria-hidden="true" />
                  <label>
                    <span>TTL（秒）</span>
                    <input
                      inputMode="numeric"
                      onChange={(event) => setTtlDraft(event.target.value)}
                      placeholder="例如 3600"
                      value={ttlDraft}
                    />
                  </label>
                  <button
                    disabled={mutationRunning}
                    onClick={() => {
                      const ttl = Number(ttlDraft);
                      if (!Number.isInteger(ttl) || ttl <= 0) {
                        setError("TTL 必须是大于 0 的整数秒数。");
                        return;
                      }
                      requestMutation({
                        title: "设置 TTL",
                        summary: `将“${details.key}”设置为 ${ttl} 秒后过期。`,
                        commands: [`EXPIRE ${quoteRedisArgument(details.key)} ${ttl}`],
                      });
                    }}
                    type="button"
                  >
                    设置
                  </button>
                  <button
                    disabled={mutationRunning || details.ttl === -1}
                    onClick={() => requestMutation({
                      title: "移除 TTL",
                      summary: `将“${details.key}”设为永久键。`,
                      commands: [`PERSIST ${quoteRedisArgument(details.key)}`],
                    })}
                    type="button"
                  >
                    设为永久
                  </button>
                </div>
                <div className="redis-operation-row">
                  <Pencil size={14} aria-hidden="true" />
                  <label>
                    <span>重命名</span>
                    <input
                      onChange={(event) => setRenameDraft(event.target.value)}
                      value={renameDraft}
                    />
                  </label>
                  <button
                    disabled={mutationRunning || !renameDraft.trim() || renameDraft === details.key}
                    onClick={() => {
                      const nextKey = renameDraft.trim();
                      requestMutation({
                        title: "重命名键",
                        summary: `将“${details.key}”重命名为“${nextKey}”。目标键存在时 Redis 会覆盖它。`,
                        commands: [
                          `RENAME ${quoteRedisArgument(details.key)} ${quoteRedisArgument(nextKey)}`,
                        ],
                        destructive: true,
                        nextKey,
                        refreshKeys: true,
                      });
                    }}
                    type="button"
                  >
                    重命名
                  </button>
                </div>
              </section>
            </>
          ) : (
            <div className="redis-detail-empty">
              <Database size={22} aria-hidden="true" />
              <strong>选择一个键查看数据</strong>
              <span>支持 String、Hash、List、Set、ZSet、Stream 和 RedisJSON。</span>
              <button onClick={() => setMode("cli")} type="button">
                <Terminal size={13} aria-hidden="true" />
                打开命令工作台
              </button>
            </div>
          )}
        </main>
      </div>

      <div
        aria-labelledby={cliTabId}
        className="redis-workspace__pane redis-workspace__pane--cli"
        hidden={mode !== "cli"}
        id={cliPanelId}
        role="tabpanel"
      >
        {mode === "cli" ? (
          <QueryWorkspace
            onRetryPersistence={onRetryPersistence}
            onRunningChange={handleCliRunningChange}
            onSqlChange={onSqlChange}
            persistenceError={persistenceError}
            profile={profile}
            tab={tab}
            theme={theme}
          />
        ) : null}
      </div>

      {createOpen ? (
        <div className="redis-dialog-backdrop">
          <section aria-labelledby="redis-create-title" aria-modal="true" className="redis-dialog" role="dialog">
            <header>
              <span>
                <small>CREATE KEY</small>
                <h2 id="redis-create-title">新建 Redis 键</h2>
              </span>
              <button aria-label="关闭新建键对话框" onClick={() => setCreateOpen(false)} type="button">
                <X size={14} aria-hidden="true" />
              </button>
            </header>
            <div className="redis-dialog__body">
              {error ? <p className="redis-dialog__error" role="alert">{error}</p> : null}
              <label>
                <span>数据类型</span>
                <select value={createType} onChange={(event) => setCreateType(event.target.value as CreatableRedisDataType)}>
                  {REDIS_DATA_TYPES.filter((type) => type.value !== "all").map((type) => (
                    <option key={type.value} value={type.value}>{type.label}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>键名</span>
                <input autoFocus onChange={(event) => setCreateName(event.target.value)} value={createName} />
              </label>
              {["hash", "stream"].includes(createType) ? (
                <label>
                  <span>字段名</span>
                  <input onChange={(event) => setCreateAuxiliary(event.target.value)} value={createAuxiliary} />
                </label>
              ) : null}
              {createType === "zset" ? (
                <label>
                  <span>分数</span>
                  <input inputMode="decimal" onChange={(event) => setCreateAuxiliary(event.target.value)} value={createAuxiliary} />
                </label>
              ) : null}
              <label>
                <span>初始值</span>
                <textarea onChange={(event) => setCreateValue(event.target.value)} value={createValue} />
              </label>
              <label>
                <span>TTL（可选，秒）</span>
                <input inputMode="numeric" onChange={(event) => setCreateTtl(event.target.value)} placeholder="留空表示永久" value={createTtl} />
              </label>
            </div>
            <footer>
              <button onClick={() => setCreateOpen(false)} type="button">取消</button>
              <button className="button--primary" disabled={mutationRunning} onClick={createKey} type="button">
                创建键
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {pendingMutation ? (
        <div className="redis-dialog-backdrop">
          <section aria-labelledby="redis-confirm-title" aria-modal="true" className="redis-dialog redis-dialog--confirm" role="alertdialog">
            <header>
              <span>
                <small>{profile.environment === "production" ? "PRODUCTION WRITE" : "CONFIRM ACTION"}</small>
                <h2 id="redis-confirm-title">{pendingMutation.title}</h2>
              </span>
              <AlertTriangle size={18} aria-hidden="true" />
            </header>
            <div className="redis-dialog__body">
              <p>{pendingMutation.summary}</p>
              <pre>{pendingMutation.commands.join("\n")}</pre>
              {pendingMutation.destructive ? <strong>此操作可能导致数据丢失。</strong> : null}
            </div>
            <footer>
              <button autoFocus disabled={mutationRunning} onClick={() => setPendingMutation(null)} type="button">
                取消
              </button>
              <button
                className={pendingMutation.destructive ? "button--danger" : "button--primary"}
                disabled={mutationRunning}
                onClick={() => void executeMutation(pendingMutation)}
                type="button"
              >
                {mutationRunning ? "正在执行…" : "确认执行"}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </section>
  );
}
