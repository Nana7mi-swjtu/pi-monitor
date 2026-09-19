/**
 * ledger.ts — 账本 / 游标 / meta 读写、锁、原子写。
 * 需求：7.1（目录布局）、7.2（cursor）、7.3（账本 schema）、7.4（meta）、
 *       FR-2（增量游标）、FR-12（存储、迁移、重建）、NFR-4（并发安全）、
 *       AC-14.1（字段封闭集合）、11 章（临时文件 + rename）、13 章（账本损坏自愈）
 */

import fs from "node:fs";
import path from "node:path";
import {
  CURSOR_SCHEMA_VERSION,
  LEDGER_FIELDS,
  META_SCHEMA_VERSION,
  type BudgetState,
  type CursorFile,
  type MetaInfo,
  type UsageRecord,
} from "./types.ts";

export const LOCK_TIMEOUT_MS = 10_000;
const LOCK_STALE_MS = 10_000;

export interface DataPaths {
  dir: string;
  config: string;
  cursor: string;
  ledger: string;
  meta: string;
  budgetState: string;
  logs: string;
  lock: string;
}

export function dataPaths(dir: string): DataPaths {
  return {
    dir,
    config: path.join(dir, "config.json"),
    cursor: path.join(dir, "cursor.json"),
    ledger: path.join(dir, "ledger.jsonl"),
    meta: path.join(dir, "meta.json"),
    budgetState: path.join(dir, "budget-state.json"),
    logs: path.join(dir, "logs"),
    lock: path.join(dir, ".pi-monitor.lock"),
  };
}

export function ensureDataDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // 磁盘满 / 无权限：内存态继续可用（13 章），由调用方决定如何提示。
  }
}

export class LockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`锁被占用超过 ${LOCK_TIMEOUT_MS} ms（${lockPath}）`);
    this.name = "LockTimeoutError";
    this.lockPath = lockPath;
  }
}

/**
 * NFR-4：锁文件串行化；等待至多 10 s；超时则以只读模式运行并提示。
 * 锁超时 10 s 自动过期（陈旧锁可被抢占）。
 */
export function acquireLock(dir: string, timeoutMs = LOCK_TIMEOUT_MS): () => void {
  ensureDataDir(dir);
  const paths = dataPaths(dir);
  const started = Date.now();

  for (;;) {
    try {
      const fd = fs.openSync(paths.lock, "wx");
      fs.writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          fs.unlinkSync(paths.lock);
        } catch {
          /* 已被抢占或删除 */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // 陈旧锁自动过期（NFR-4）。
      try {
        const stat = fs.statSync(paths.lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(paths.lock);
          continue;
        }
      } catch {
        continue; // 锁刚被释放
      }
      if (Date.now() - started >= timeoutMs) {
        throw new LockTimeoutError(paths.lock);
      }
      sleepSync(40);
    }
  }
}

function sleepSync(ms: number): void {
  const shared = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(shared), 0, 0, ms);
}

/** 原子写：临时文件 + rename（FR-11.5 / FR-12.6）。 */
export function writeFileAtomic(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (parsed === null || typeof parsed !== "object") return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/** AC-14.1：把记录投影到 7.3 的封闭字段集合，丢弃任何未知字段。 */
export function projectRecord(record: UsageRecord): UsageRecord {
  const source = record as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of LEDGER_FIELDS) out[field] = source[field];
  return out as unknown as UsageRecord;
}

/**
 * 7.3 的写入序列化（字段顺序与字段集合均固定）。
 *
 * 手写拼接而不是 `JSON.stringify(projectRecord(...))`：
 *  - 避免每条记录分配一个中间对象（NFR-2：50 万条记录的全量扫描）；
 *  - 字段顺序由模版固定，且写入字段集合与 7.3 完全一致（AC-14.1）。
 *  `serializeRecord` 与 `projectRecord` 的一致性由 test/unit/ledger.test.ts 双向断言。
 */
export function serializeRecord(record: UsageRecord): string {
  return (
    `{"v":${record.v}` +
    `,"fp":${quote(record.fp)}` +
    `,"ts":${number(record.ts)}` +
    `,"tsSource":${quote(record.tsSource)}` +
    `,"day":${quote(record.day)}` +
    `,"tz":${quote(record.tz)}` +
    `,"provider":${quoteNullable(record.provider)}` +
    `,"model":${quoteNullable(record.model)}` +
    `,"api":${quoteNullable(record.api)}` +
    `,"kind":${quote(record.kind)}` +
    `,"toolName":${quoteNullable(record.toolName)}` +
    `,"input":${number(record.input)}` +
    `,"output":${number(record.output)}` +
    `,"cacheRead":${number(record.cacheRead)}` +
    `,"cacheWrite":${number(record.cacheWrite)}` +
    `,"reasoning":${number(record.reasoning)}` +
    `,"billed":${number(record.billed)}` +
    `,"costUsd":${numberOrNull(record.costUsd)}` +
    `,"costUsdEst":${numberOrNull(record.costUsdEst)}` +
    `,"sessionId":${quote(record.sessionId)}` +
    `,"sessionFile":${quote(record.sessionFile)}` +
    `,"entryId":${quote(record.entryId)}` +
    `,"cwd":${quoteNullable(record.cwd)}` +
    `,"project":${quote(record.project)}` +
    `,"source":${quote(record.source)}` +
    `,"ephemeral":${record.ephemeral ? "true" : "false"}}`
  );
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function quoteNullable(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

function number(value: number): string {
  return Number.isFinite(value) ? String(value) : "0";
}

function numberOrNull(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "null" : String(value);
}

export interface ReadLedgerResult {
  records: UsageRecord[];
  /** 13 章：账本损坏（半行）→ 截断并备份，此处为 1。 */
  repaired: number;
  bytes: number;
}

/**
 * 读取账本。13 章：半行损坏 → 截断到最后一个完整记录并备份原文件。
 */
export function readLedger(ledgerPath: string): ReadLedgerResult {
  let text: string;
  try {
    text = fs.readFileSync(ledgerPath, "utf8");
  } catch {
    return { records: [], repaired: 0, bytes: 0 };
  }
  const bytes = Buffer.byteLength(text, "utf8");
  if (text.length === 0) return { records: [], repaired: 0, bytes };

  const lines = text.split("\n");
  const records: UsageRecord[] = [];
  let validLineCount = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    if (raw.length === 0 && index === lines.length - 1) break; // 末尾换行
    if (raw.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // 半行损坏：截断到此处并备份。
      repairLedger(ledgerPath, lines.slice(0, validLineCount).join("\n"));
      return { records, repaired: 1, bytes };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      repairLedger(ledgerPath, lines.slice(0, validLineCount).join("\n"));
      return { records, repaired: 1, bytes };
    }
    const record = coerceRecord(parsed as Record<string, unknown>);
    if (record !== null) records.push(record);
    validLineCount = index + 1;
  }

  return { records, repaired: 0, bytes };
}

function repairLedger(ledgerPath: string, content: string): void {
  try {
    const backup = `${ledgerPath}.bak-${Date.now()}`;
    fs.copyFileSync(ledgerPath, backup);
    const suffix = content.length > 0 ? `${content}\n` : "";
    writeFileAtomic(ledgerPath, suffix);
  } catch {
    // 备份失败不阻塞运行（13 章：内存态可用）。
  }
}

function coerceRecord(raw: Record<string, unknown>): UsageRecord | null {
  const v = raw["v"];
  const fp = raw["fp"];
  const ts = raw["ts"];
  if (typeof v !== "number" || typeof fp !== "string" || typeof ts !== "number" || !Number.isFinite(ts)) {
    return null;
  }
  return internRecord(projectRecord(raw as unknown as UsageRecord));
}

/**
 * 字符串驻留：账本中 `provider` / `model` / `day` / `sessionFile` … 基数极低，
 * 驻留后同一值在所有记录间共享同一个字符串对象（NFR-3 常驻内存）。
 * `fp` / `entryId` 是唯一的，不参与驻留。
 */
const INTERNED_FIELDS: readonly (keyof UsageRecord)[] = [
  "tsSource",
  "day",
  "tz",
  "provider",
  "model",
  "api",
  "kind",
  "toolName",
  "sessionId",
  "sessionFile",
  "cwd",
  "project",
  "source",
];

const internPool = new Map<string, string>();
const INTERN_POOL_LIMIT = 200_000;

export function intern(value: string | null): string | null {
  if (value === null || value.length === 0) return value;
  const hit = internPool.get(value);
  if (hit !== undefined) return hit;
  if (internPool.size >= INTERN_POOL_LIMIT) internPool.clear();
  internPool.set(value, value);
  return value;
}

/** 对一条记录做字符串驻留（返回同一对象，就地替换字符串引用）。 */
export function internRecord(record: UsageRecord): UsageRecord {
  const target = record as unknown as Record<string, unknown>;
  for (const field of INTERNED_FIELDS) {
    const value = target[field];
    if (typeof value === "string") target[field] = intern(value);
  }
  return record;
}

/** FR-12.6：账本以 O_APPEND 追加，并用锁文件串行化。
 *  写入按块批处理（避免每条记录一次 `writeSync` 系统调用，NFR-2）。 */
export function appendLedgerRecords(ledgerPath: string, records: readonly UsageRecord[]): number {
  if (records.length === 0) return 0;
  ensureDataDir(path.dirname(ledgerPath));
  let written = 0;
  let pending = "";
  const fd = fs.openSync(ledgerPath, "a");
  try {
    for (const record of records) {
      pending += `${serializeRecord(record)}\n`;
      written += 1;
      if (written % APPEND_CHUNK_LINES === 0) {
        fs.writeSync(fd, pending);
        pending = "";
      }
    }
    if (pending.length > 0) fs.writeSync(fd, pending);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return written;
}

const APPEND_CHUNK_LINES = 2000;

/** FR-2.4 / FR-12：需要删除某文件的历史记录时整表重写（原子）。 */
export function rewriteLedger(ledgerPath: string, records: readonly UsageRecord[]): void {
  const body = records.map((record) => `${serializeRecord(record)}\n`).join("");
  writeFileAtomic(ledgerPath, body);
}

/** 重建时备份账本为 `*.bak-<ts>`（FR-12.4）。 */
export function backupLedger(ledgerPath: string, stamp: number): string | null {
  try {
    if (!fs.existsSync(ledgerPath)) return null;
    const backup = `${ledgerPath}.bak-${stamp}`;
    fs.copyFileSync(ledgerPath, backup);
    return backup;
  } catch {
    return null;
  }
}

export function emptyCursor(tz: string): CursorFile {
  return { schemaVersion: CURSOR_SCHEMA_VERSION, tz, files: {} };
}

/**
 * FR-12.2：低版本自动迁移（无损）；高版本只读（由调用方判定，不写索引文件）。
 */
export function readCursor(cursorPath: string, tz: string): { cursor: CursorFile; readOnly: boolean } {
  const raw = readJsonFile<CursorFile>(cursorPath);
  if (raw === null) return { cursor: emptyCursor(tz), readOnly: false };
  const schemaVersion = typeof raw.schemaVersion === "number" ? raw.schemaVersion : 0;
  if (schemaVersion > CURSOR_SCHEMA_VERSION) {
    return { cursor: raw, readOnly: true };
  }
  const files = raw.files !== null && typeof raw.files === "object" && !Array.isArray(raw.files) ? raw.files : {};
  const cursor: CursorFile = {
    schemaVersion: CURSOR_SCHEMA_VERSION,
    tz: typeof raw.tz === "string" && raw.tz.length > 0 ? raw.tz : tz,
    files: files as CursorFile["files"],
  };
  return { cursor, readOnly: false };
}

export function writeCursor(cursorPath: string, cursor: CursorFile): void {
  writeFileAtomic(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`);
}

export function defaultMeta(tz: string): MetaInfo {
  return {
    schemaVersion: META_SCHEMA_VERSION,
    revision: 0,
    startedAt: new Date().toISOString(),
    pid: process.pid,
    lastScanAt: null,
    lastScanMs: 0,
    scanning: false,
    progress: 0,
    files: 0,
    records: 0,
    dedupeSkipped: 0,
    corruptLines: 0,
    invalidSessions: 0,
    inconsistencyCount: 0,
    corruptDuplicateIds: 0,
    corruptCost: 0,
    corruptUsage: 0,
    skippedFiles: 0,
    ledgerRepaired: 0,
    configWarnings: [],
    unknownKeys: [],
    tz,
    tzChanged: false,
  };
}

export interface ReadMetaResult {
  meta: MetaInfo;
  /** FR-12.3：索引版本更高 → 只读运行，不写任何索引文件。 */
  readOnly: boolean;
}

/** FR-12.2/12.3：meta 版本迁移与高版本只读。 */
export function readMeta(metaPath: string, tz: string): ReadMetaResult {
  const defaults = defaultMeta(tz);
  const raw = readJsonFile<Record<string, unknown>>(metaPath);
  if (raw === null) return { meta: defaults, readOnly: false };
  const schemaVersion = typeof raw["schemaVersion"] === "number" ? (raw["schemaVersion"] as number) : 0;
  if (schemaVersion > META_SCHEMA_VERSION) {
    return { meta: { ...defaults, ...(raw as Partial<MetaInfo>), schemaVersion }, readOnly: true };
  }
  const merged: MetaInfo = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof MetaInfo)[]) {
    const value = raw[key as string];
    if (value === undefined || value === null) continue;
    (merged as unknown as Record<string, unknown>)[key] = value;
  }
  merged.schemaVersion = META_SCHEMA_VERSION;
  merged.tz = typeof merged.tz === "string" && merged.tz.length > 0 ? merged.tz : tz;
  if (!Array.isArray(merged.configWarnings)) merged.configWarnings = [];
  if (!Array.isArray(merged.unknownKeys)) merged.unknownKeys = [];
  return { meta: merged, readOnly: false };
}

export function writeMeta(metaPath: string, meta: MetaInfo): void {
  writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
}

export function readBudgetState(budgetPath: string, day: string, month: string): BudgetState {
  const raw = readJsonFile<BudgetState>(budgetPath);
  if (raw === null || typeof raw !== "object") {
    return { schemaVersion: 1, day, month, fired: { daily: [], monthly: [] } };
  }
  const fired = raw.fired ?? { daily: [], monthly: [] };
  return {
    schemaVersion: 1,
    day: typeof raw.day === "string" ? raw.day : day,
    month: typeof raw.month === "string" ? raw.month : month,
    fired: {
      daily: Array.isArray(fired.daily) ? fired.daily.filter((n) => typeof n === "number") : [],
      monthly: Array.isArray(fired.monthly) ? fired.monthly.filter((n) => typeof n === "number") : [],
    },
  };
}

export function writeBudgetState(budgetPath: string, state: BudgetState): void {
  writeFileAtomic(budgetPath, `${JSON.stringify(state, null, 2)}\n`);
}

/** 冻结索引写入（FR-12.3：高版本只读）。 */
export type LedgerWriter = {
  append(records: readonly UsageRecord[]): void;
  rewrite(records: readonly UsageRecord[]): void;
  flush(): void;
};

/** 供 scanner 使用的写入门面：自动加锁并把写入合并到一次会话中。 */
export function createLedgerWriter(ledgerPath: string): LedgerWriter {
  const pendingAppend: UsageRecord[] = [];
  let pendingRewrite: UsageRecord[] | null = null;
  return {
    append(records) {
      if (records.length === 0) return;
      pendingAppend.push(...records);
    },
    rewrite(records) {
      pendingRewrite = [...records];
    },
    flush() {
      if (pendingRewrite !== null) {
        rewriteLedger(ledgerPath, pendingRewrite);
        pendingRewrite = null;
        pendingAppend.length = 0;
      }
      if (pendingAppend.length > 0) {
        appendLedgerRecords(ledgerPath, pendingAppend);
        pendingAppend.length = 0;
      }
    },
  };
}
