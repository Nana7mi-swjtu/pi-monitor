/**
 * parser.ts — 会话 JSONL → 用量记录（FR-1.3~FR-1.7、4.3、4.7）。
 * 需求：FR-1.3~FR-1.7、AC-1.1~AC-1.4、4.2（C-1~C-5）、4.3（计数白名单）、
 *       4.7（source 判定）、$1~$5、NFR-10（前向兼容）、13 章（逐条计数不静默）
 *
 * 关键防坑条款（4.3）：`compaction.retainedTail[].usage` **禁止计数** ——
 * 那是被保留的历史消息副本，原消息已在同文件计数。
 */

import { computeRecordCost } from "./cost.ts";
import { fingerprintOf } from "./dedupe.ts";
import { lookupPricing, type PricingTable } from "./pricing.ts";
import type { RecordKind, SessionSource, TsSource } from "./types.ts";

/** FR-1.3：单行 > 4 MiB 视为损坏行。 */
export const MAX_LINE_BYTES = 4 * 1024 * 1024;

/** 已知 entry 类型；其余计入 `unknownEntryTypes`（NFR-10，不报错）。 */
const KNOWN_ENTRY_TYPES = new Set([
  "session",
  "message",
  "custom",
  "custom_message",
  "compaction",
  "branch_summary",
  "model_change",
  "thinking_level_change",
  "session_info",
  "label",
]);

export interface ParseStats {
  corruptLines: number;
  invalidSessions: number;
  corruptUsage: number;
  corruptDuplicateIds: number;
  inconsistencyCount: number;
  corruptCost: number;
  unknownEntryTypes: number;
}

export function emptyParseStats(): ParseStats {
  return {
    corruptLines: 0,
    invalidSessions: 0,
    corruptUsage: 0,
    corruptDuplicateIds: 0,
    inconsistencyCount: 0,
    corruptCost: 0,
    unknownEntryTypes: 0,
  };
}

/** 解析产物：尚未带 `day`/`tz`/`project`/`sessionFile`/`ephemeral`（由 scanner 补齐）。 */
export interface RawUsageRecord {
  fp: string;
  ts: number;
  tsSource: TsSource;
  provider: string | null;
  model: string | null;
  api: string | null;
  kind: RecordKind;
  toolName: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  billed: number;
  costUsd: number | null;
  costUsdEst: number | null;
  entryId: string;
}

export interface ParsedSession {
  /** FR-1.5：首行非 `type:"session"` → 整文件跳过。 */
  valid: boolean;
  /** 文件头信息（增量续读时用于复用）。 */
  header: SessionHeaderInfo;
  sessionId: string;
  cwd: string | null;
  parentSession: string | null;
  version: number | null;
  source: SessionSource;
  records: RawUsageRecord[];
  stats: ParseStats;
  /** 已消费的字节偏移（增量扫描用，含 `initialOffset`）。 */
  bytesConsumed: number;
  /** 最后一行（未终止行）的字节长度（含换行），用于避免吞掉半行。 */
  lastLineBytes: number;
  lineCount: number;
}

export interface UsageComponents {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  billed: number;
  costUsd: number | null;
  costUsdEst: number | null;
  /** C-3：`totalTokens` 与四分量之和不一致。 */
  inconsistent: boolean;
  /** $5：成本为负或非有限数。 */
  corruptCost: boolean;
}

/**
 * C-1~C-5 + $1~$5 的唯一实现（账本与实时计数器共用）。
 * 返回 `null` 表示 usage 类型异常（调用方计入 `corruptUsage`）。
 */
export function readUsageComponents(
  usage: unknown,
  provider: string | null,
  model: string | null,
  pricing: PricingTable,
): UsageComponents | null {
  if (usage === null || typeof usage !== "object" || Array.isArray(usage)) return null;
  const usageObject = usage as Record<string, unknown>;

  const input = readCount(usageObject["input"]);
  const output = readCount(usageObject["output"]);
  const cacheRead = readCount(usageObject["cacheRead"]);
  const cacheWrite = readCount(usageObject["cacheWrite"]);
  if (input === null || output === null || cacheRead === null || cacheWrite === null) return null;

  const reasoning = readCount(usageObject["reasoning"]) ?? 0;
  // C-1：billedTokens = input + output + cacheRead + cacheWrite
  const billed = input + output + cacheRead + cacheWrite;

  // C-3：totalTokens 仅用于一致性校验；不等时以 billedTokens 为准。
  const totalTokens = usageObject["totalTokens"];
  const inconsistent =
    typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens !== billed;

  let sawCorruptCost = false;
  // $1/$5：从 usage.cost.total 取真实成本；非有限数按损坏计数。
  const costTotal = readCostTotal(usageObject["cost"], () => {
    sawCorruptCost = true;
  });
  const cost = computeRecordCost({
    usageCostTotal: costTotal,
    tokens: { input, output, cacheRead, cacheWrite },
    pricing: lookupPricing(pricing, provider, model),
  });

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    billed,
    costUsd: cost.costUsd,
    costUsdEst: cost.costUsdEst,
    inconsistent,
    corruptCost: sawCorruptCost || cost.corruptCost,
  };
}

export interface SessionHeaderInfo {
  sessionId: string;
  cwd: string | null;
  parentSession: string | null;
  version: number | null;
}

export interface SessionParserOptions {
  sessionFile: string;
  pricing: PricingTable;
  /** FR-2.3：增量续读时，第一行不再是文件头（默认 true）。 */
  expectHeader?: boolean;
  /** FR-2.3：增量续读时复用的文件头信息。 */
  initialHeader?: SessionHeaderInfo;
  /** FR-2.3：增量续读的起始字节偏移（用于累计 `bytesConsumed`）。 */
  initialOffset?: number;
}

/**
 * 逐行会话解析器（FR-1.3：由调用方用 `node:readline` 流式喂入）。
 * 所有 IO/解析错误都容忍，永不抛出（NFR-5）。
 */
export class SessionParser {
  private readonly sessionFile: string;
  private readonly pricing: PricingTable;
  private readonly stats: ParseStats = emptyParseStats();
  private readonly records: RawUsageRecord[] = [];
  private readonly seenEntryIds = new Set<string>();

  private lineIndex = 0;
  private valid = true;
  private sawHeader = false;
  private sessionId = "";
  private cwd: string | null = null;
  private parentSession: string | null = null;
  private version: number | null = null;
  private sawPiWeb = false;
  private sawPiWebSubagent = false;
  private bytesConsumed: number;
  private lastLineBytes = 0;
  private lineCount = 0;
  private readonly expectHeader: boolean;
  /** 增量续读时本段是否看到了 pi-web 标记（用于合并缓存的 source）。 */
  sawPiWebMarker = false;
  sawPiWebSubagentMarker = false;

  constructor(options: SessionParserOptions) {
    this.sessionFile = options.sessionFile;
    this.pricing = options.pricing;
    this.expectHeader = options.expectHeader ?? true;
    this.bytesConsumed = options.initialOffset ?? 0;
    const header = options.initialHeader;
    if (header !== undefined) {
      this.sessionId = header.sessionId;
      this.cwd = header.cwd;
      this.parentSession = header.parentSession;
      this.version = header.version;
    }
  }

  /** 文件头信息（增量续读时用于写入游标缓存）。 */
  headerInfo(): SessionHeaderInfo {
    return {
      sessionId: this.sessionId,
      cwd: this.cwd,
      parentSession: this.parentSession,
      version: this.version,
    };
  }

  /** 喂入一行。
   *  `byteLength` 由调用方（按字节切分的读取器）提供，避免对每一行重复做 UTF-8 编码。
   *  `terminated` 为 false 表示这是文件末尾未以换行结束的行 —— 此时不推进字节偏移，
   *  使下一次扫描能从该行开头重新读取（FR-2.3）。
   */
  feed(rawLine: string, byteLength?: number, terminated = true): void {
    const lineBytes = byteLength ?? Buffer.byteLength(rawLine, "utf8");
    this.lineCount += 1;
    this.bytesConsumed += terminated ? lineBytes + 1 : 0;
    this.lastLineBytes = lineBytes + (terminated ? 1 : 0);

    let line = rawLine;
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (this.lineIndex === 0 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
    if (line.trim().length === 0) {
      this.lineIndex += 1;
      return;
    }

    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      // FR-1.3：超长行视为损坏行跳过并计数。
      this.stats.corruptLines += 1;
      this.lineIndex += 1;
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // FR-1.4：非 JSON 行 → corruptLines++，不中断。
      this.stats.corruptLines += 1;
      this.lineIndex += 1;
      return;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      // FR-1.4：非对象行 → corruptLines++。
      this.stats.corruptLines += 1;
      this.lineIndex += 1;
      return;
    }

    const entry = parsed as Record<string, unknown>;
    const type = entry["type"];

    if (this.lineIndex === 0 && this.expectHeader) {
      this.lineIndex += 1;
      if (type !== "session") {
        // FR-1.5：首行非 session → invalidSessions++，整文件跳过。
        this.stats.invalidSessions += 1;
        this.valid = false;
        return;
      }
      this.readHeader(entry);
      return;
    }
    if (this.lineIndex === 0 && !this.expectHeader && type === "session") {
      // 增量续读时若恰好碰到重复的文件头，跳过即可。
      this.lineIndex += 1;
      return;
    }

    this.lineIndex += 1;
    if (!this.valid) return;

    if (typeof type !== "string") {
      // FR-1.4：缺 `type` 的行 → corruptLines++。
      this.stats.corruptLines += 1;
      return;
    }

    if (!KNOWN_ENTRY_TYPES.has(type)) {
      // AC-1.4 / NFR-10：未知 entry 类型不影响结果，且不报错。
      this.stats.unknownEntryTypes += 1;
      return;
    }

    try {
      this.handleEntry(type, entry);
    } catch {
      // NFR-5 / P-9：不吞错不计数 —— 计入 corruptUsage 以便健康面板可见。
      this.stats.corruptUsage += 1;
    }
  }

  finish(): ParsedSession {
    if (this.expectHeader && !this.sawHeader && this.stats.invalidSessions === 0) {
      // FR-1.5：文件为空或完全没有文件头 → 无效会话，整文件跳过。
      this.stats.invalidSessions += 1;
      this.valid = false;
    }
    const source: SessionSource = this.sawPiWebSubagent
      ? "pi-web:subagent"
      : this.sawPiWeb
        ? "pi-web"
        : this.parentSession !== null
          ? "pi-fork"
          : "pi";
    return {
      valid: this.valid,
      header: this.headerInfo(),
      sessionId: this.sessionId,
      cwd: this.cwd,
      parentSession: this.parentSession,
      version: this.version,
      source,
      records: this.records,
      stats: this.stats,
      bytesConsumed: this.bytesConsumed,
      lastLineBytes: this.lastLineBytes,
      lineCount: this.lineCount,
    };
  }

  private readHeader(entry: Record<string, unknown>): void {
    this.sawHeader = true;
    const id = entry["id"];
    this.sessionId = typeof id === "string" ? id : "";
    const cwd = entry["cwd"];
    this.cwd = typeof cwd === "string" && cwd.trim().length > 0 ? cwd : null;
    const parent = entry["parentSession"];
    this.parentSession = typeof parent === "string" && parent.trim().length > 0 ? parent : null;
    const version = entry["version"];
    this.version = typeof version === "number" && Number.isFinite(version) ? version : null;
  }

  private handleEntry(type: string, entry: Record<string, unknown>): void {
    if (type === "custom") {
      const customType = entry["customType"];
      if (typeof customType === "string") {
        // 4.7：判定仅允许读取 `customType`，不解析其 data。
        if (customType === "pi-web:subagent") {
          this.sawPiWebSubagent = true;
          this.sawPiWebSubagentMarker = true;
        } else if (customType.startsWith("pi-web:")) {
          this.sawPiWeb = true;
          this.sawPiWebMarker = true;
        }
      }
      return;
    }

    if (type === "message") {
      const message = entry["message"];
      if (message === null || typeof message !== "object" || Array.isArray(message)) return;
      const record = message as Record<string, unknown>;
      const role = record["role"];

      if (role === "assistant") {
        if (record["usage"] === undefined) return; // 4.3：无 usage → 不计数（非错误）
        this.pushRecord(entry, record, "assistant", null);
        return;
      }

      if (role === "toolResult") {
        if (record["usage"] === undefined) return;
        const toolName = typeof record["toolName"] === "string" ? record["toolName"] : null;
        this.pushRecord(entry, record, "toolResult", toolName);
        return;
      }

      return;
    }

    if (type === "compaction" || type === "branch_summary") {
      // 4.3：compaction / branch_summary 自身的 usage 计入；
      // `retainedTail[].usage` 绝不读取（防重复计数）。
      if (entry["usage"] === undefined) return;
      const kind: RecordKind = type === "compaction" ? "compaction" : "branchSummary";
      // 这两类 entry 没有消息级时间戳，时间来源恒为行级 (`tsSource: "entry"`)。
      this.pushRecord(entry, null, kind, null);
    }
  }

  private pushRecord(
    entry: Record<string, unknown>,
    message: Record<string, unknown> | null,
    kind: RecordKind,
    toolName: string | null,
  ): void {
    const usageHolder: Record<string, unknown> = message ?? entry;
    const entryId = typeof entry["id"] === "string" ? (entry["id"] as string) : "";
    // D-6：同一文件内重复 entry id 视为文件损坏，保留首条并计数。
    if (entryId.length > 0) {
      if (this.seenEntryIds.has(entryId)) {
        this.stats.corruptDuplicateIds += 1;
        return;
      }
      this.seenEntryIds.add(entryId);
    }

    const provider = readString(usageHolder["provider"]);
    const model = readString(usageHolder["model"]);
    const api = readString(usageHolder["api"]);

    const components = readUsageComponents(usageHolder["usage"], provider, model, this.pricing);
    if (components === null) {
      // 13 章：usage 类型异常 → 丢弃该条，corruptUsage++。
      this.stats.corruptUsage += 1;
      return;
    }
    if (components.inconsistent) this.stats.inconsistencyCount += 1;
    if (components.corruptCost) this.stats.corruptCost += 1;

    const timestamp = this.resolveTimestamp(entry, message);
    if (timestamp === null) {
      this.stats.corruptUsage += 1;
      return;
    }

    const record: RawUsageRecord = {
      fp: fingerprintOf({
        entryId,
        ts: timestamp.ts,
        provider,
        model,
        input: components.input,
        output: components.output,
        cacheRead: components.cacheRead,
        cacheWrite: components.cacheWrite,
      }),
      ts: timestamp.ts,
      tsSource: timestamp.source,
      provider,
      model,
      api,
      kind,
      toolName,
      input: components.input,
      output: components.output,
      cacheRead: components.cacheRead,
      cacheWrite: components.cacheWrite,
      reasoning: components.reasoning,
      billed: components.billed,
      costUsd: components.costUsd,
      costUsdEst: components.costUsdEst,
      entryId,
    };
    this.records.push(record);
  }

  /** 4.1 / T-5：消息级 `message.timestamp`（Unix ms）；缺失回退行级 `timestamp`。 */
  private resolveTimestamp(
    entry: Record<string, unknown>,
    message: Record<string, unknown> | null,
  ): { ts: number; source: TsSource } | null {
    const messageTs = message === null ? undefined : message["timestamp"];
    if (typeof messageTs === "number" && Number.isFinite(messageTs) && messageTs > 0) {
      return { ts: messageTs, source: "message" };
    }
    if (typeof messageTs === "string") {
      const parsed = Date.parse(messageTs);
      if (Number.isFinite(parsed)) return { ts: parsed, source: "message" };
    }
    const entryTs = entry["timestamp"];
    if (typeof entryTs === "string") {
      const parsed = Date.parse(entryTs);
      if (Number.isFinite(parsed)) return { ts: parsed, source: "entry" };
    }
    if (typeof entryTs === "number" && Number.isFinite(entryTs) && entryTs > 0) {
      return { ts: entryTs, source: "entry" };
    }
    return null;
  }

  /** 供诊断：当前会话文件（不参与解析逻辑）。 */
  get file(): string {
    return this.sessionFile;
  }
}

/** 计数校验：未定义/null → 0；非有限数或负数 → null（视为损坏）。 */
function readCount(value: unknown): number | null {
  if (value === undefined || value === null) return 0;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** $1：`usage.cost.total`；返回有限数（允许负值，由 $5 判定）或 null。 */
function readCostTotal(cost: unknown, onCorrupt: () => void): number | null {
  if (cost === undefined || cost === null) return null;
  if (typeof cost !== "object" || Array.isArray(cost)) {
    onCorrupt();
    return null;
  }
  const total = (cost as Record<string, unknown>)["total"];
  if (total === undefined || total === null) return null;
  if (typeof total !== "number" || !Number.isFinite(total)) {
    onCorrupt();
    return null;
  }
  return total;
}
