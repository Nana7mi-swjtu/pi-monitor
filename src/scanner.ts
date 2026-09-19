/**
 * scanner.ts — 索引编排：发现 → 解析 → 去重 → 落账 → 更新 meta（含进度）。
 * 需求：FR-2（AC-2.1~AC-2.4）、FR-3、FR-4（实时计数器）、FR-12（重建 / 迁移）、
 *       T-6（时区变更重算日键）、NFR-4（并发安全）、NFR-5（错误不上抛）、13 章
 *
 * 本模块是唯一拥有「扫描 + 账本写入 + 实时计数」状态的编排层；
 * 纯计算一律委托 aggregate/money/time/cost/format。
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import { emptyTotals } from "./aggregate.ts";
import { dedupeRecords, type DedupeResult } from "./dedupe.ts";
import { discoverSessionFiles } from "./discover.ts";
import { createLogger } from "./health.ts";
import {
  appendLedgerRecords,
  acquireLock,
  backupLedger,
  dataPaths,
  defaultMeta,
  ensureDataDir,
  internRecord,
  LockTimeoutError,
  readCursor,
  readLedger,
  readMeta,
  rewriteLedger,
  writeCursor,
  writeMeta,
  type DataPaths,
} from "./ledger.ts";
import { round6 } from "./money.ts";
import { SessionParser, readUsageComponents, type ParsedSession, type SessionHeaderInfo } from "./parser.ts";
import { normalizePath, normalizeProject, pathKey, resolveDataDir, resolveSessionRoots } from "./paths.ts";
import { loadPricingTable, emptyPricingTable, type PricingTable } from "./pricing.ts";
import { dayKey, resolveTimezone, type ResolvedTimezone } from "./time.ts";
import {
  CURSOR_SCHEMA_VERSION,
  type CursorEntry,
  type CursorFile,
  type DedupeSkip,
  type Logger,
  type MetaInfo,
  type MoneyTotals,
  type PiMonitorConfig,
  type RecordKind,
  type SessionSource,
  type Totals,
  type UsageRecord,
} from "./types.ts";

/** FR-2.3：前缀哈希取样长度。 */
const PREFIX_HASH_BYTES = 4096;

export interface ScanSummary {
  revision: number;
  /** 本次实际解析的文件数。 */
  scanned: number;
  files: number;
  records: number;
  durationMs: number;
  fullRescan: boolean;
  readOnly: boolean;
}

export interface ScanOptions {
  /** FR-12.4：重建（备份 + 清空 + 全量扫描）。 */
  rebuild?: boolean;
  /** 忽略游标，全量重解析（文件被删除/截断时的正确性兜底）。 */
  fullRescan?: boolean;
  onProgress?: (progress: number) => void;
}

interface FileMetaCache {
  header: SessionHeaderInfo;
  source: SessionSource;
  project: string;
}

export interface EngineOptions {
  agentDir: string;
  config: PiMonitorConfig;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  pricing?: PricingTable;
}

/** 实时计数器（FR-4）：只保留 USD 口径，人民币在读取时按当前汇率换算（¥5）。 */
interface LiveCounters {
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; billed: number };
  messages: { assistant: number; toolResult: number; total: number };
  usd: MoneyTotals;
  sessions: Set<string>;
  lastEntryAt: number | null;
}

function emptyLive(): LiveCounters {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billed: 0 },
    messages: { assistant: 0, toolResult: 0, total: 0 },
    usd: { known: null, estimated: null },
    sessions: new Set<string>(),
    lastEntryAt: null,
  };
}

/**
 * 索引引擎（FR-2 增量、FR-3 去重、FR-4 实时、FR-12 存储）。
 * 所有 IO/解析错误都被降级处理，绝不抛到 agent 主流程（NFR-5）。
 */
export class MonitorEngine {
  readonly agentDir: string;
  readonly dataDir: string;
  readonly paths: DataPaths;

  config: PiMonitorConfig;
  meta: MetaInfo;
  records: UsageRecord[] = [];
  dedupeSkips: DedupeSkip[] = [];
  readOnly = false;
  lockTimeout = false;
  lastError: string | null = null;
  startedAt: string;
  indexSizeBytes = 0;

  private pricing: PricingTable;
  private readonly logger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private tzInfo: ResolvedTimezone;
  private readonly fileMeta = new Map<string, FileMetaCache>();
  private live: LiveCounters = emptyLive();
  private scanInFlight: Promise<ScanSummary> | null = null;
  /** 内存中的 `records` 是否可信（已 load 或已完整扫描过）。用于 NFR-2 热启动短路。 */
  private recordsLoaded = false;
  /** FR-6.2：命令已声明「准备扫描」，但真正的 scan() 尚未开始（大账本载入期间保持进度条）。 */
  private scanPending = false;
  private readonly currencyWarnings: string[] = [];

  constructor(options: EngineOptions) {
    this.agentDir = options.agentDir;
    this.dataDir = resolveDataDir(options.agentDir);
    this.paths = dataPaths(this.dataDir);
    this.config = options.config;
    this.env = options.env ?? process.env;
    this.logger =
      options.logger ??
      createLogger({ logsDir: this.paths.logs, level: "off", maxFiles: 7, maxBytes: 5_242_880 });
    this.tzInfo = resolveTimezone(this.config.timezone);
    this.startedAt = new Date().toISOString();
    this.meta = defaultMeta(this.tzInfo.tz);

    if (options.pricing !== undefined) {
      this.pricing = options.pricing;
    } else {
      // $2：从 `~/.pi/agent/models.json` 的 `cost` 读取定价；宿主可另行注入 modelRegistry 定价。
      const loaded = loadPricingTable(joinPath(this.agentDir, "models.json"));
      this.pricing = loaded.table;
      if (loaded.warnings.length > 0) this.currencyWarnings.push(...loaded.warnings);
    }
  }

  /** 当前时区（T-1）。 */
  get timezone(): string {
    return this.tzInfo.tz;
  }

  /** 是否处于扫描中（FR-6.6 / AC-6.8）。 */
  get scanning(): boolean {
    return this.meta.scanning;
  }

  /** 供命令与 HTTP API 共用的惰性载入（幂等、不抛异常）。 */
  ensureRecordsLoaded(): void {
    if (this.recordsLoaded) return;
    this.load();
  }

  /**
   * FR-6.2 / AC-6.8：命令返回前先同步标出「正在建立索引」，
   * 使首屏能立即显示进度条（真正的载入与扫描在后台进行）。
   */
  markScanning(): void {
    this.scanPending = true;
    this.meta = { ...this.meta, scanning: true, progress: 0 };
  }

  /** 载入索引（账本 + 游标 + meta）。不触发扫描。 */
  load(): void {
    ensureDataDir(this.dataDir);
    const { cursor, readOnly: cursorReadOnly } = readCursor(this.paths.cursor, this.tzInfo.tz);
    const { meta, readOnly: metaReadOnly } = readMeta(this.paths.meta, this.tzInfo.tz);
    this.readOnly = cursorReadOnly || metaReadOnly;

    const ledger = readLedger(this.paths.ledger);
    this.records = ledger.records;

    this.meta = { ...meta, startedAt: this.startedAt, pid: process.pid };
    if (this.scanPending) {
      this.meta.scanning = true;
      this.meta.progress = 0;
    }
    if (ledger.repaired > 0) {
      this.meta.ledgerRepaired = (this.meta.ledgerRepaired ?? 0) + ledger.repaired;
    }
    this.meta.records = this.records.length;
    this.meta.configWarnings = [...new Set([...this.meta.configWarnings, ...this.currencyWarnings])];
    this.indexSizeBytes = ledger.bytes;
    this.recordsLoaded = true;
    void cursor;
  }

  /** 汇率 / 语言等展示层配置变更（¥5：不改变账本 revision）。 */
  setConfig(config: PiMonitorConfig): void {
    this.config = config;
    const next = resolveTimezone(config.timezone);
    this.tzInfo = next;
  }

  /** 会话根（FR-1.1）。 */
  sessionRoots(): string[] {
    return resolveSessionRoots(this.agentDir, this.config.extraSessionDirs, this.env);
  }

  /** FR-4：实时（可能尚未落盘）的「本会话」合计。 */
  getLiveTotals(rate: number): Totals {
    const totals = emptyTotals();
    totals.tokens = { ...this.live.tokens };
    totals.messages = { ...this.live.messages };
    totals.cost.usd = { ...this.live.usd };
    totals.cost.cny = {
      known: this.live.usd.known === null ? null : round6(this.live.usd.known * rate),
      estimated: this.live.usd.estimated === null ? null : round6(this.live.usd.estimated * rate),
    };
    totals.sessions = this.live.sessions.size;
    totals.activeDays = this.live.lastEntryAt === null ? 0 : 1;
    return totals;
  }

  /** FR-4.3：`session_start` 时重置（含 new/resume/fork）。 */
  resetLive(sessionId?: string): void {
    this.live = emptyLive();
    if (sessionId !== undefined && sessionId.length > 0) this.live.sessions.add(sessionId);
  }

  /**
   * FR-4.1：`message_end` 中 assistant / toolResult 且含 `usage` 的累加。
   * 4.2/4.3：`reasoning` 已包含在 `output` 中，不重复累加。
   */
  recordLiveUsage(input: {
    kind: RecordKind;
    toolName?: string | null;
    usage: unknown;
    provider: string | null;
    model: string | null;
    sessionId: string;
    timestamp?: number;
  }): void {
    const components = readUsageComponents(input.usage, input.provider, input.model, this.pricing);
    if (components === null) return;
    this.live.tokens.input += components.input;
    this.live.tokens.output += components.output;
    this.live.tokens.cacheRead += components.cacheRead;
    this.live.tokens.cacheWrite += components.cacheWrite;
    this.live.tokens.billed += components.billed;
    if (input.kind === "assistant") this.live.messages.assistant += 1;
    if (input.kind === "toolResult") this.live.messages.toolResult += 1;
    this.live.messages.total += 1;
    if (components.costUsd !== null) this.live.usd.known = (this.live.usd.known ?? 0) + components.costUsd;
    if (components.costUsdEst !== null) this.live.usd.estimated = (this.live.usd.estimated ?? 0) + components.costUsdEst;
    this.live.sessions.add(input.sessionId);
    this.live.lastEntryAt = input.timestamp ?? Date.now();
  }

  /**
   * FR-4.5 / 13 章：临时会话结束后把内存记录写入账本并标记 `ephemeral: true`。
   * 返回实际写入的条数。
   */
  persistEphemeral(records: readonly UsageRecord[]): number {
    if (records.length === 0) return 0;
    if (this.readOnly) return 0;
    const existing = new Set(this.records.map((record) => record.fp));
    const fresh = records.filter((record) => record.ephemeral && !existing.has(record.fp));
    if (fresh.length === 0) return 0;
    const result = this.writeWithLock(() => {
      appendLedgerRecords(this.paths.ledger, fresh);
    });
    if (!result.ok) return 0;
    this.records = [...this.records, ...fresh];
    this.meta.records = this.records.length;
    this.meta.revision += 1;
    this.persistMeta();
    this.recordsLoaded = true;
    return fresh.length;
  }

  /** FR-12.5：仅做增量扫描（`POST /api/rescan`）。 */
  async scan(options: ScanOptions = {}): Promise<ScanSummary> {
    if (this.scanInFlight !== null) return this.scanInFlight;
    this.scanInFlight = this.runScan(options).finally(() => {
      this.scanInFlight = null;
    });
    return this.scanInFlight;
  }

  /** FR-12.4：重建索引（备份 → 清空 → 全量扫描）。 */
  async rebuild(): Promise<ScanSummary> {
    if (this.readOnly) {
      return {
        revision: this.meta.revision,
        scanned: 0,
        files: this.meta.files,
        records: this.meta.records,
        durationMs: 0,
        fullRescan: false,
        readOnly: true,
      };
    }
    const stamp = Date.now();
    backupLedger(this.paths.ledger, stamp);
    const summary = await this.scan({ rebuild: true, fullRescan: true });
    return summary;
  }

  /** 供 `POST /api/rescan` 返回 `{revision, scanned, durationMs}`（10.2）。 */
  async rescan(): Promise<ScanSummary> {
    return this.scan({});
  }

  private async runScan(options: ScanOptions): Promise<ScanSummary> {
    const started = Date.now();
    // 幂等载入：保证 revision 与统计来自磁盘，而不是构造函数里的默认值。
    this.ensureRecordsLoaded();
    this.meta = { ...this.meta, scanning: true, progress: 0, startedAt: this.startedAt, pid: process.pid };
    if (this.scanPending) this.meta.revision = this.meta.revision;
    this.persistMeta();

    const summary = await this.performScan(options, started);

    this.scanPending = false;
    this.meta = {
      ...this.meta,
      scanning: false,
      progress: 1,
      lastScanAt: new Date().toISOString(),
      lastScanMs: Date.now() - started,
      revision: this.meta.revision + 1,
    };
    this.persistMeta();
    return { ...summary, revision: this.meta.revision };
  }

  private async performScan(options: ScanOptions, startedAt: number): Promise<ScanSummary> {
    const readOnlyAtStart = this.readOnly;
    if (readOnlyAtStart) {
      // FR-12.3：索引版本更高 → 只读运行，不写任何索引文件。
      return {
        revision: this.meta.revision,
        scanned: 0,
        files: this.meta.files,
        records: this.meta.records,
        durationMs: Date.now() - startedAt,
        fullRescan: false,
        readOnly: true,
      };
    }

    const rebuild = options.rebuild === true;
    const fullRescan = options.fullRescan === true || rebuild;
    const roots = this.sessionRoots();
    const discovery = await discoverSessionFiles(roots);

    const { cursor } = readCursor(this.paths.cursor, this.tzInfo.tz);
    // T-6：时区变更后按当前时区重算日键，并提示重建（健康面板）。
    const tzChanged = cursor.tz !== this.tzInfo.tz;

    const total = discovery.files.length;
    const stats_: Array<{ file: { path: string; root: string }; cursorKey: string; key: string; stat: fs.Stats; previous: CursorEntry | undefined }> = [];

    // 先只做 stat 与游标比对：没有变化时不得读取账本。
    // （NFR-2：100 个未变化文件的热启动扫描 < 150 ms；账本可能上百 MB。）
    for (let index = 0; index < total; index += 1) {
      const file = discovery.files[index] as { path: string; root: string };
      options.onProgress?.(total === 0 ? 1 : (index / total) * 0.2);
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(file.path);
      } catch {
        // 13 章：会话文件不存在/无权限 → 跳过并统计。
        discovery.skippedFiles += 1;
        continue;
      }
      const cursorKey = normalizePath(file.path);
      const previous = cursor.files[cursorKey];
      if (!fullRescan && previous !== undefined && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) {
        // FR-2.2：size 与 mtimeMs 均相同 → 跳过。
        continue;
      }
      stats_.push({ file, cursorKey, key: pathKey(cursorKey), stat, previous });
    }

    // 已删除的文件：游标中存在但本次未发现。
    const livePaths = new Set(discovery.files.map((file) => pathKey(file.path)));
    const vanished: string[] = [];
    for (const cursorKey of Object.keys(cursor.files)) {
      if (!livePaths.has(pathKey(cursorKey))) vanished.push(cursorKey);
    }

    if (!fullRescan && this.recordsLoaded && stats_.length === 0 && vanished.length === 0 && !tzChanged) {
      // 无事发生：直接回放缓存结果（包括 `dedupeSkipped` 等统计）。
      options.onProgress?.(1);
      return {
        revision: this.meta.revision,
        scanned: 0,
        files: discovery.files.length,
        records: this.records.length,
        durationMs: Date.now() - startedAt,
        fullRescan: false,
        readOnly: false,
      };
    }

    const ledger = rebuild || this.recordsLoaded ? null : readLedger(this.paths.ledger);
    const existing = rebuild ? [] : ledger === null ? this.records : ledger.records;
    const base = tzChanged ? rekeyDays(existing, this.tzInfo.tz) : existing;

    const changedKeys = new Set<string>();
    const parsedFiles: Array<{
      path: string;
      cursorKey: string;
      entry: CursorEntry;
      records: UsageRecord[];
      stats: ParsedSession["stats"];
      meta: FileMetaCache;
    }> = [];
    let scanned = 0;
    /** 本次扫描中是否发现「被重写」的文件（重写 → 可能丢失被跳过的重复记录）。 */
    let rewriteDetected = false;
    for (let index = 0; index < stats_.length; index += 1) {
      const item = stats_[index] as (typeof stats_)[number];
      const file = item.file;
      const cursorKey = item.cursorKey;
      const key = item.key;
      const stat = item.stat;
      const previous = item.previous;
      options.onProgress?.(0.2 + (total === 0 ? 0.8 : (index / total) * 0.8));

      const cached = this.fileMeta.get(key);
      // FR-2.3 / FR-2.4：前缀哈希用于区分「追加」与「重写」。
      const prefixHash = previous === undefined ? null : await hashPrefix(file.path, PREFIX_HASH_BYTES);
      // 重写（长度变短或前缀变化）意味着该文件旧的指纹可能整个消失，
      // 此时此前被去重跳过的同指纹记录会丢失 —— 必须全量重扫（FR-3 幂等）。
      const isRewrite =
        previous !== undefined && (stat.size < previous.size || prefixHash !== previous.prefixHash);
      if (isRewrite) rewriteDetected = true;

      let startOffset = 0;
      let header: SessionHeaderInfo | undefined;
      let expectHeader = true;

      if (
        !fullRescan &&
        !isRewrite &&
        previous !== undefined &&
        stat.size > previous.size &&
        cached !== undefined
      ) {
        // FR-2.3：size > cursor.size 且前缀哈希一致 → 从 offset 续读（追加场景）。
        startOffset = previous.offset;
        header = cached.header;
        expectHeader = false;
      }

      let parsed: ParsedSession;
      try {
        parsed = await parseSessionFile(file.path, this.pricing, {
          startOffset,
          expectHeader,
          header,
        });
      } catch (error) {
        discovery.skippedFiles += 1;
        discovery.errors.push(`parse ${file.path}: ${(error as Error).message}`);
        this.logger.error("会话文件解析失败", { path: file.path, reason: (error as Error).message });
        continue;
      }

      scanned += 1;
      changedKeys.add(key);

      const project = normalizeProject(parsed.cwd ?? cached?.header.cwd ?? null, cursorKey);
      const source = mergeSource(cached?.source, parsed.source, parsed.parentSession);
      const meta: FileMetaCache = { header: parsed.header, source, project };
      this.fileMeta.set(key, meta);

      const records = materializeRecords(parsed, cursorKey, this.tzInfo.tz, { source, project });
      // FR-2.3 续读位置：`bytesConsumed` 已排除「未终止的半行」，
      // 因此半行补全后会从该行开头重新读取。
      const newOffset = Math.max(startOffset, Math.min(stat.size, parsed.bytesConsumed));
      const entry: CursorEntry = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        offset: newOffset,
        records: previous === undefined || startOffset === 0 ? records.length : previous.records + records.length,
        lastScanAt: new Date().toISOString(),
        prefixHash: prefixHash ?? "",
      };
      parsedFiles.push({ path: cursorKey, cursorKey, entry, records, stats: parsed.stats, meta });
    }

    options.onProgress?.(1);

    // 记录被删除的文件：其历史记录必须从账本中移除。
    for (const cursorKey of vanished) {
      changedKeys.add(pathKey(cursorKey));
      this.fileMeta.delete(pathKey(cursorKey));
    }

    // 丢弃被改动文件的历史记录（它们将由本次重新解析的结果替代）。
    const survivors = base.filter((record) => !changedKeys.has(pathKey(record.sessionFile)));
    const removedCount = base.length - survivors.length;

    // 正确性优先级（FR-3 幂等）：
    //  - 被重写的文件：旧指纹可能整体消失，此前因去重被跳过的记录会永久丢失；
    //  - 被删除的文件：同理（且其曾作为 keeper）。
    // 单纯「追加」不会丢记录，因此保持增量扫描（NFR-2 热启动性能）。
    const needsFullRescan = !fullRescan && (rewriteDetected || vanished.length > 0);

    if (needsFullRescan) {
      return this.performScan({ ...options, fullRescan: true }, startedAt);
    }

    const newRecords = parsedFiles.flatMap((file) => file.records);
    const merged = [...survivors, ...newRecords];
    const deduped: DedupeResult<UsageRecord> = dedupeRecords(merged, this.config.dedupe);

    const stats = aggregateStats(parsedFiles.map((file) => file.stats));

    // 写入：无删除时用 O_APPEND 追加（FR-12.6）；有删除时整表重写（FR-2.4）。
    const removedAny = removedCount > 0 || rebuild;
    const freshRecords = pickAppendable(survivors, deduped.records);

    if (!removedAny && freshRecords.length > 0) {
      const written = this.writeWithLock(() => {
        appendLedgerRecords(this.paths.ledger, freshRecords);
      });
      if (!written.ok) {
        this.readOnly = true;
        this.lockTimeout = written.lockTimeout;
      } else {
        this.records = deduped.records;
      }
    } else if (removedAny || deduped.records.length !== survivors.length) {
      const written = this.writeWithLock(() => {
        rewriteLedger(this.paths.ledger, deduped.records);
      });
      if (!written.ok) {
        this.readOnly = true;
        this.lockTimeout = written.lockTimeout;
      } else {
        this.records = deduped.records;
      }
    } else {
      this.records = deduped.records;
    }
    this.recordsLoaded = true;

    const nextCursor: CursorFile = {
      schemaVersion: CURSOR_SCHEMA_VERSION,
      tz: this.tzInfo.tz,
      files: { ...cursor.files },
    };
    for (const cursorKey of vanished) delete nextCursor.files[cursorKey];
    for (const file of parsedFiles) nextCursor.files[file.cursorKey] = file.entry;

    this.dedupeSkips = deduped.skipped;
    this.meta = {
      ...this.meta,
      ...defaultMeta(this.tzInfo.tz),
      revision: this.meta.revision,
      startedAt: this.startedAt,
      pid: process.pid,
      scanning: true,
      progress: 1,
      files: discovery.files.length,
      records: this.records.length,
      dedupeSkipped: deduped.skipped.length,
      corruptLines: stats.corruptLines,
      invalidSessions: stats.invalidSessions,
      inconsistencyCount: stats.inconsistencyCount,
      corruptDuplicateIds: stats.corruptDuplicateIds,
      corruptCost: stats.corruptCost,
      corruptUsage: stats.corruptUsage,
      skippedFiles: discovery.skippedFiles,
      ledgerRepaired: this.meta.ledgerRepaired ?? 0,
      configWarnings: [...new Set([...this.configWarnings(), ...this.currencyWarnings])],
      unknownKeys: this.meta.unknownKeys,
      tz: this.tzInfo.tz,
      tzChanged,
      lastScanAt: this.meta.lastScanAt,
      lastScanMs: this.meta.lastScanMs,
    };

    if (!this.readOnly) {
      const cursorWritten = this.writeWithLock(() => {
        writeCursor(this.paths.cursor, nextCursor);
      });
      if (!cursorWritten.ok) {
        this.readOnly = true;
        this.lockTimeout = cursorWritten.lockTimeout;
      }
    }

    this.indexSizeBytes = measureIndexFor(this.paths);

    return {
      revision: this.meta.revision,
      scanned,
      files: discovery.files.length,
      records: this.records.length,
      durationMs: Date.now() - startedAt,
      fullRescan,
      readOnly: this.readOnly,
    };
  }

  /** 13 章：锁被占用 → 等待至多 10 s；超时则只读运行并提示。 */
  private writeWithLock(action: () => void): { ok: boolean; lockTimeout: boolean } {
    let release: (() => void) | null = null;
    try {
      release = acquireLock(this.dataDir);
    } catch (error) {
      if (error instanceof LockTimeoutError) {
        this.logger.error("索引锁超时，进入只读模式", { lock: error.lockPath });
        return { ok: false, lockTimeout: true };
      }
      this.logger.error("索引锁获取失败", { reason: (error as Error).message });
      return { ok: false, lockTimeout: false };
    }
    try {
      action();
      return { ok: true, lockTimeout: false };
    } catch (error) {
      this.lastError = (error as Error).message;
      this.logger.error("索引写入失败", { reason: (error as Error).message });
      return { ok: false, lockTimeout: false };
    } finally {
      release();
    }
  }

  private persistMeta(): void {
    if (this.readOnly) return;
    try {
      writeMeta(this.paths.meta, this.meta);
    } catch (error) {
      this.lastError = (error as Error).message;
    }
  }

  private configWarnings(): string[] {
    return this.meta.configWarnings ?? [];
  }
}

/** 追加场景判定：只有不在 survivors 中的新记录才允许 O_APPEND。 */
function pickAppendable(survivors: readonly UsageRecord[], deduped: readonly UsageRecord[]): UsageRecord[] {
  const survivorFps = new Set(survivors.map((record) => record.fp));
  return deduped.filter((record) => !survivorFps.has(record.fp));
}

function aggregateStats(statsList: readonly ParsedSession["stats"][]): ParsedSession["stats"] {
  const out = {
    corruptLines: 0,
    invalidSessions: 0,
    corruptUsage: 0,
    corruptDuplicateIds: 0,
    inconsistencyCount: 0,
    corruptCost: 0,
    unknownEntryTypes: 0,
  };
  for (const stats of statsList) {
    out.corruptLines += stats.corruptLines;
    out.invalidSessions += stats.invalidSessions;
    out.corruptUsage += stats.corruptUsage;
    out.corruptDuplicateIds += stats.corruptDuplicateIds;
    out.inconsistencyCount += stats.inconsistencyCount;
    out.corruptCost += stats.corruptCost;
    out.unknownEntryTypes += stats.unknownEntryTypes;
  }
  return out;
}

/** 已存在的 source 与增量段的 source 合并（4.7 优先级）。 */
function mergeSource(previous: SessionSource | undefined, segment: SessionSource, parentSession: string | null): SessionSource {
  if (segment === "pi-web:subagent") return "pi-web:subagent";
  if (previous === "pi-web:subagent") return "pi-web:subagent";
  if (segment === "pi-web") return "pi-web";
  if (previous === "pi-web") return "pi-web";
  if (parentSession !== null) return "pi-fork";
  return previous === "pi-fork" ? "pi-fork" : "pi";
}

/** T-6：时区变更后按当前时区重算 `day` / `tz`。 */
function rekeyDays(records: readonly UsageRecord[], tz: string): UsageRecord[] {
  return records.map((record) => ({ ...record, day: dayKey(record.ts, tz), tz }));
}

function toUsageRecord(
  raw: ParsedSession["records"][number],
  context: {
    sessionId: string;
    cwd: string | null;
    project: string;
    source: SessionSource;
    sessionFile: string;
    ephemeral: boolean;
  },
  tz: string,
): UsageRecord {
  return {
    v: 1,
    fp: raw.fp,
    ts: raw.ts,
    tsSource: raw.tsSource,
    day: dayKey(raw.ts, tz),
    tz,
    provider: raw.provider,
    model: raw.model,
    api: raw.api,
    kind: raw.kind,
    toolName: raw.toolName,
    input: raw.input,
    output: raw.output,
    cacheRead: raw.cacheRead,
    cacheWrite: raw.cacheWrite,
    reasoning: raw.reasoning,
    billed: raw.billed,
    costUsd: raw.costUsd,
    costUsdEst: raw.costUsdEst,
    sessionId: context.sessionId,
    sessionFile: context.sessionFile,
    entryId: raw.entryId,
    cwd: context.cwd,
    project: context.project,
    source: context.source,
    ephemeral: context.ephemeral,
  };
}
/**
 * 把解析结果落成 7.3 账本记录（扫描器与测试共用同一实现，避免出现第二份映射）。
 * 需求：7.3（字段封闭集合）、AC-1.1
 */
export function materializeRecords(
  parsed: ParsedSession,
  sessionFile: string,
  tz: string,
  overrides: Partial<{ source: SessionSource; project: string }> = {},
): UsageRecord[] {
  const context = {
    sessionId: parsed.sessionId,
    cwd: parsed.cwd,
    project: overrides.project ?? normalizeProject(parsed.cwd, sessionFile),
    source: overrides.source ?? parsed.source,
    sessionFile,
    ephemeral: false,
  };
  return parsed.records.map((raw) => internRecord(toUsageRecord(raw, context, tz)));
}

/** FR-2.3：前缀哈希（默认前 4096 字节）。 */
export async function hashPrefix(filePath: string, bytes = PREFIX_HASH_BYTES): Promise<string> {  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const stream = fs.createReadStream(filePath, { start: 0, end: Math.max(0, bytes - 1) });
    stream.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    stream.on("error", () => resolve(""));
    stream.on("end", () => {
      resolve(createHash("sha1").update(Buffer.concat(chunks)).digest("hex").slice(0, 16));
    });
  });
}

export interface ParseFileOptions {
  startOffset?: number;
  expectHeader?: boolean;
  header?: SessionHeaderInfo;
}

/**
 * FR-1.3：逐行流式读取。
 *
 * 使用「按字节切分」的读取器（而不是 `node:readline`）：
 *  - 每行的字节长度直接已知，不需要对每行重复做一次 UTF-8 长度计算（NFR-2）；
 *  - 文件末尾未以换行结束的半行不计入字节偏移，使下次扫描能完整重读该行（FR-2.3）；
 *  - 避免 readline 异步迭代器逐行的调度开销。
 */
export async function parseSessionFile(
  filePath: string,
  pricing: PricingTable,
  options: ParseFileOptions = {},
): Promise<ParsedSession> {
  const startOffset = options.startOffset ?? 0;
  const parser = new SessionParser({
    sessionFile: filePath,
    pricing,
    expectHeader: options.expectHeader,
    initialHeader: options.header,
    initialOffset: startOffset,
  });

  const stream = fs.createReadStream(filePath, { start: startOffset });
  let remainder: Buffer = EMPTY_BUFFER;
  try {
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      let cursor = 0;

      if (remainder.length > 0) {
        const newline = buffer.indexOf(0x0a, cursor);
        if (newline === -1) {
          remainder = Buffer.concat([remainder, buffer]);
          continue;
        }
        const merged = Buffer.concat([remainder, buffer.subarray(cursor, newline)]);
        parser.feed(merged.toString("utf8"), merged.length, true);
        remainder = EMPTY_BUFFER;
        cursor = newline + 1;
      }

      for (;;) {
        const newline = buffer.indexOf(0x0a, cursor);
        if (newline === -1) break;
        const line = buffer.subarray(cursor, newline);
        parser.feed(line.toString("utf8"), line.length, true);
        cursor = newline + 1;
      }

      if (cursor < buffer.length) {
        remainder = Buffer.from(buffer.subarray(cursor));
      }
    }
  } finally {
    stream.destroy();
  }

  if (remainder.length > 0) {
    parser.feed(remainder.toString("utf8"), remainder.length, false);
  }
  return parser.finish();
}

const EMPTY_BUFFER = Buffer.alloc(0);

function measureIndexFor(paths: DataPaths): number {
  let total = 0;
  for (const file of [paths.ledger, paths.cursor, paths.meta]) {
    try {
      total += fs.statSync(file).size;
    } catch {
      /* 不存在 */
    }
  }
  return total;
}

/** 直接构造一个空引擎（用于纯测试与 `dedupe: "off"` 复核）。 */
export function createEmptyEngine(options: EngineOptions): MonitorEngine {
  const engine = new MonitorEngine({ ...options, pricing: options.pricing ?? emptyPricingTable() });
  engine.meta = defaultMeta(engine.timezone);
  engine.records = [];
  return engine;
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${process.platform === "win32" ? "\\" : "/"}${name}`;
}

