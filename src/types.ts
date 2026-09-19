/**
 * types.ts — 全部类型定义（纯类型，无 IO，禁止 import 任何宿主包）。
 * 需求：7.2（cursor）、7.3（账本记录，字段封闭集合）、7.4（meta）、7.5（聚合结果）、
 *       FR-5、FR-6、FR-7、FR-10、FR-12.7、AC-14.1
 *
 * 注意（AC-14.1）：`UsageRecord` 的字段集合是封闭的，新增字段必须先修订 PRD 7.3。
 */

/** 账本 schema 版本（7.3 `v`）。 */
export const LEDGER_SCHEMA_VERSION = 1;
/** cursor.json schema 版本（7.2）。 */
export const CURSOR_SCHEMA_VERSION = 1;
/** meta.json schema 版本（7.4）。 */
export const META_SCHEMA_VERSION = 1;
/** config.json schema 版本（第 12 章）。 */
export const CONFIG_SCHEMA_VERSION = 1;

export type RecordKind = "assistant" | "toolResult" | "compaction" | "branchSummary";
export type SessionSource = "pi" | "pi-web" | "pi-web:subagent" | "pi-fork";
export type TsSource = "message" | "entry";
export type DedupeMode = "fingerprint" | "off";
export type Locale = "zh-CN" | "en-US";
export type LocaleSetting = Locale | "auto";
export type WeekStart = "monday" | "sunday";
export type ThemeMode = "auto" | "light" | "dark";
export type LogLevel = "off" | "error" | "info" | "debug";

/** 7.3 账本记录。金额字段单位恒为美元（$6），人民币只在展示层换算（¥2）。 */
export interface UsageRecord {
  v: number;
  fp: string;
  ts: number;
  tsSource: TsSource;
  day: string;
  tz: string;
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
  sessionId: string;
  sessionFile: string;
  entryId: string;
  cwd: string | null;
  project: string;
  source: SessionSource;
  ephemeral: boolean;
}

/** AC-14.1：账本记录的字段名白名单（顺序即写入顺序）。 */
export const LEDGER_FIELDS: readonly (keyof UsageRecord)[] = [
  "v",
  "fp",
  "ts",
  "tsSource",
  "day",
  "tz",
  "provider",
  "model",
  "api",
  "kind",
  "toolName",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "billed",
  "costUsd",
  "costUsdEst",
  "sessionId",
  "sessionFile",
  "entryId",
  "cwd",
  "project",
  "source",
  "ephemeral",
] as const;

/** 7.2 单文件游标。 */
export interface CursorEntry {
  size: number;
  mtimeMs: number;
  offset: number;
  records: number;
  lastScanAt: string;
  prefixHash: string;
}

/** 7.2 cursor.json。 */
export interface CursorFile {
  schemaVersion: number;
  tz: string;
  files: Record<string, CursorEntry>;
}

/** 7.4 meta.json（含第 13 章要求的诊断计数）。 */
export interface MetaInfo {
  schemaVersion: number;
  revision: number;
  startedAt: string;
  pid: number;
  lastScanAt: string | null;
  lastScanMs: number;
  scanning: boolean;
  progress: number;
  files: number;
  records: number;
  dedupeSkipped: number;
  corruptLines: number;
  invalidSessions: number;
  inconsistencyCount: number;
  corruptDuplicateIds: number;
  corruptCost: number;
  corruptUsage: number;
  skippedFiles: number;
  ledgerRepaired: number;
  configWarnings: string[];
  unknownKeys: string[];
  tz: string;
  tzChanged: boolean;
  lastScanDurationMs?: number;
}

/** 7.5 金额合计。`null` 表示“没有记录贡献过该口径的金额”，展示为 `—`（¥7）。
 *  这是 7.5 中 `known: number; estimated: number` 的展示必需扩展：0 与“无数据”必须可区分。 */
export interface MoneyTotals {
  known: number | null;
  estimated: number | null;
}

/** 7.5 token 合计。 */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  billed: number;
}

/** 7.5 消息计数。 */
export interface MessageTotals {
  assistant: number;
  toolResult: number;
  total: number;
}

/** 7.5 Totals。 */
export interface Totals {
  tokens: TokenTotals;
  messages: MessageTotals;
  cost: { usd: MoneyTotals; cny: MoneyTotals };
  sessions: number;
  activeDays: number;
}

export type AggregateDimension =
  | "day"
  | "week"
  | "month"
  | "provider"
  | "model"
  | "project"
  | "session"
  | "source"
  | "kind";

export interface WindowSpec {
  kind:
    | "today"
    | "yesterday"
    | "week"
    | "month"
    | "last7d"
    | "last30d"
    | "all"
    | "custom"
    | "lastN";
  /** 最近 N 天（kind === "lastN"）。 */
  n?: number;
  fromMs: number;
  toMs: number;
  fromDay: string;
  toDay: string;
  from: string;
  to: string;
  days: number;
  tz: string;
  swapped: boolean;
}

export interface QueryFilters {
  project?: string;
  provider?: string;
  model?: string;
  source?: string;
  sessionId?: string;
}

export interface GroupRow {
  key: string;
  label: string;
  totals: Totals;
  share: number;
}

export interface DailyRow {
  day: string;
  totals: Totals;
}

export interface Buckets {
  metric: string;
  p50: number;
  p75: number;
  p90: number;
  legend: string[];
  /** 非零日 < 4 时退化为等距分桶（8.4）。 */
  equalBuckets: boolean;
  edges: number[];
}

/** 7.5 聚合结果（仪表盘 / 工具 / 导出共用）。 */
export interface AggregateResult {
  schemaVersion: 1;
  generatedAt: string;
  currency: { code: "CNY"; symbol: "¥"; rate: number; rateSource: "manual" };
  window: {
    from: string;
    to: string;
    tz: string;
    label: string;
    days: number;
    swapped?: boolean;
  };
  filters: QueryFilters;
  totals: Totals;
  groups?: GroupRow[];
  daily?: DailyRow[];
  buckets?: Buckets;
  live?: Totals;
  health?: MetaInfo;
  comparison?: { totals: Totals; hasData: boolean };
  truncated?: boolean;
}

/** 去重跳过明细（FR-3.2 / D-3）。 */
export interface DedupeSkip {
  fp: string;
  entryId: string;
  ts: number;
  keptFile: string;
  skippedFile: string;
}

/** 预算提醒状态（FR-10.5）。 */
export interface BudgetState {
  schemaVersion: number;
  day: string;
  month: string;
  fired: { daily: number[]; monthly: number[] };
}

export interface BudgetAlert {
  period: "daily" | "monthly";
  threshold: number;
  spentCNY: number;
  limitCNY: number;
}

export interface BudgetProgress {
  period: "daily" | "monthly";
  limitCNY: number;
  spentCNY: number;
  ratio: number;
  exceeded: boolean;
  overCNY: number;
}

/** FR-6.4 端口策略 + FR-6.7 绑定地址。 */
export interface DashboardRuntimeInfo {
  url: string;
  port: number;
  startedAt: string;
  pid: number;
  token: string;
  allowLan: boolean;
}

/** `token_stats` 工具的输入（FR-7）。 */
export interface TokenStatsInput {
  window?: string | number;
  from?: string;
  to?: string;
  groupBy?: AggregateDimension;
  project?: string;
  provider?: string;
  model?: string;
  source?: string;
  limit?: number;
}

/** 第 12 章配置项清单（`<agentDir>/pi-monitor/config.json`）。 */
export interface PiMonitorConfig {
  schemaVersion: number;
  locale: LocaleSetting;
  timezone: string;
  weekStart: WeekStart;
  extraSessionDirs: string[];
  dedupe: DedupeMode;
  ephemeralCapture: boolean;
  defaultWindow: string | number;
  tableLimit: number;
  tool: { enabled: boolean };
  currency: { code: "CNY"; rate: number };
  dashboard: {
    enabled: boolean;
    port: number;
    portRange: number;
    allowLan: boolean;
    stopOnExit: boolean;
    linkMessage: boolean;
    theme: ThemeMode;
  };
  budget: {
    enabled: boolean;
    dailyCNY: number | null;
    monthlyCNY: number | null;
    warnAt: number[];
    includeEstimated: boolean;
    injectMessage: boolean;
  };
  logging: { level: LogLevel; maxFiles: number; maxBytes: number };
}

/** 诊断日志级别（NFR-6 / 第 12 章 logging.*）。 */
export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
}
