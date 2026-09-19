/**
 * dashboard/api.ts — 路由 → aggregate 适配（10.2 HTTP API 契约）。
 * 需求：FR-5、FR-8、FR-9.6、FR-12、10.2（全部端点）、7.5（响应结构）、T-1、T-6
 *
 * 本模块只做「查询参数 → 聚合调用 → 响应对象」的编排，不实现任何求和逻辑（8.1）。
 */

import { buildAggregate, buildComparison, type Metric } from "../aggregate.ts";
import { WRITABLE_CONFIG_PATHS, flatten, updateConfigFile, writeCurrencyState, type LoadedConfig } from "../config.ts";
import { buildHealthReport, measureIndexSize, type HealthReport } from "../health.ts";
import { windowLabel } from "../i18n.ts";
import { fetchUsdCnyRate, isRateStale, type RateAttempt, type RateFetcher } from "../rates.ts";
import type { MonitorEngine } from "../scanner.ts";
import { civilDayDiff, dayKey, heatmapGridRange, heatmapRange, isValidTimezone, parseWindowInput, previousWindow, resolveTimezone, resolveWindow } from "../time.ts";
import type {
  AggregateDimension,
  AggregateResult,
  DedupeSkip,
  HeatmapGrid,
  Locale,
  QueryFilters,
  RateSource,
  UsageRecord,
  WindowSpec,
} from "../types.ts";

export interface MonitorContext {
  engine: MonitorEngine;
  loaded: LoadedConfig;
  configPath: string;
  logPath: string | null;
  locale: Locale;
  readOnly: boolean;
  lockTimeout: boolean;
  /** 本次进程内的会话 id（用于「本会话」实时卡）。 */
  sessionId: string | null;
  /** 汇率请求的可注入实现（测试用）；缺省时用全局 `fetch`。 */
  rateFetcher?: RateFetcher;
}

export interface QueryOptions {
  window?: string;
  tz?: string;
  from?: string;
  to?: string;
  project?: string;
  provider?: string;
  model?: string;
  source?: string;
  sessionId?: string;
  metric?: string;
  year?: string;
  dim?: string;
  limit?: string;
  cursor?: string;
}

const DIMENSIONS: readonly AggregateDimension[] = [
  "day",
  "week",
  "month",
  "provider",
  "model",
  "project",
  "session",
  "source",
  "kind",
];

export function readFilters(query: QueryOptions): QueryFilters {
  const filters: QueryFilters = {};
  if (query.project !== undefined && query.project.length > 0) filters.project = query.project;
  if (query.provider !== undefined && query.provider.length > 0) filters.provider = query.provider;
  if (query.model !== undefined && query.model.length > 0) filters.model = query.model;
  if (query.source !== undefined && query.source.length > 0) filters.source = query.source;
  if (query.sessionId !== undefined && query.sessionId.length > 0) filters.sessionId = query.sessionId;
  return filters;
}

/** 解析查询时区：`?tz=` 覆盖配置（T-1）。非法值回退配置值。 */
export function resolveQueryTimezone(ctx: MonitorContext, query: QueryOptions): string {
  const raw = query.tz;
  if (raw === undefined || raw.length === 0) return ctx.engine.timezone;
  if (!isValidTimezone(raw)) return ctx.engine.timezone;
  return resolveTimezone(raw).tz;
}

/** 解析窗口：`window`（名 / 最近 N 天）/ `from`+`to` / 配置默认窗口（FR-5.1、FR-12）。 */
export function resolveQueryWindow(ctx: MonitorContext, query: QueryOptions, tz: string): WindowSpec {
  const now = Date.now();
  const weekStart = ctx.engine.config.weekStart;

  const hasFrom = query.from !== undefined && query.from.length > 0;
  const hasTo = query.to !== undefined && query.to.length > 0;
  if (hasFrom || hasTo) {
    const fromDay = query.from ?? (query.to as string);
    const toDay = query.to ?? (query.from as string);
    return resolveWindow({ kind: "custom", fromDay, toDay }, { tz, weekStart, now });
  }

  const fallback = parseWindowInput(ctx.engine.config.defaultWindow, { kind: "last7d" });
  const input =
    query.window === undefined || query.window.length === 0 ? fallback : parseWindowInput(query.window, fallback);
  return resolveWindow(input, { tz, weekStart, now });
}

/** T-6：按请求时区重算日键（仅在 `?tz=` 与索引时区不同时发生）。 */
export function recordsForTimezone(records: readonly UsageRecord[], tz: string): UsageRecord[] {
  if (records.every((record) => record.tz === tz)) return [...records];
  return records.map((record) => (record.tz === tz ? record : { ...record, day: dayKey(record.ts, tz), tz }));
}

function labelFor(locale: Locale): (window: WindowSpec) => string {
  return (window) => windowLabel(locale, window);
}

/** `GET /api/summary`：`Totals` + 环比（10.2）。 */
export function buildSummary(ctx: MonitorContext, query: QueryOptions): AggregateResult {
  const tz = resolveQueryTimezone(ctx, query);
  const window = resolveQueryWindow(ctx, query, tz);
  const rate = ctx.engine.config.currency.rate;
  const filters = readFilters(query);
  const records = recordsForTimezone(ctx.engine.records, tz);

  // 8.3：环比 = 当前窗口 vs 紧邻等长前一窗口。
  const comparison = buildComparison(records, previousWindow(window, ctx.engine.config.weekStart), filters, rate);
  return buildAggregate({
    records,
    window,
    filters,
    rate,
    rateSource: ctx.engine.config.currency.rateSource,
    weekStart: ctx.engine.config.weekStart,
    now: Date.now(),
    locale: ctx.locale,
    health: ctx.engine.meta,
    comparison,
    labelFor: labelFor(ctx.locale),
  }).result;
}

/** `GET /api/daily`：`daily[]` + `buckets`（10.2 / 8.4）+ `grid`（周对齐网格区间）。 */
export function buildDaily(ctx: MonitorContext, query: QueryOptions): AggregateResult {
  const tz = resolveQueryTimezone(ctx, query);
  const weekStart = ctx.engine.config.weekStart;
  const now = Date.now();

  // 8.4：`year` 存在时按该自然年取范围（忽略 window/from/to）；非法值等同未提供。
  const year = parseYear(query.year);
  const window = year === null
    ? resolveQueryWindow(ctx, query, tz)
    : resolveWindow(
        { kind: "custom", fromDay: `${year}-01-01`, toDay: `${year}-12-31` },
        { tz, weekStart, now },
      );

  const result = buildAggregate({
    records: recordsForTimezone(ctx.engine.records, tz),
    window,
    filters: readFilters(query),
    rate: ctx.engine.config.currency.rate,
    rateSource: ctx.engine.config.currency.rateSource,
    weekStart,
    now,
    locale: ctx.locale,
    withDaily: true,
    metric: normalizeMetric(query.metric),
    labelFor: labelFor(ctx.locale),
  }).result;

  // 8.4：网格区间由服务端给出，前端不得自行实现周对齐。
  // `window=all` 的真实末日由 aggregate 回填到 `result.window.to`。
  const anchorDay = result.window.to.length > 0 ? result.window.to : dayKey(now, tz);
  const span = year === null
    ? heatmapRange(anchorDay, weekStart, 53)
    : heatmapGridRange(`${year}-01-01`, `${year}-12-31`, weekStart);
  // AC-8.8：`recent` 模式的统计范围就是这 53 周网格本身（否则除锚点日以外的格子
  // 会被当成补齐格而不着色）；`year` 模式的统计范围是该自然年，网格首尾多余日为补齐格。
  const fromDay = year === null ? span.startDay : `${year}-01-01`;
  const toDay = year === null ? span.endDay : `${year}-12-31`;
  const grid: HeatmapGrid = {
    startDay: span.startDay,
    endDay: span.endDay,
    weeks: Math.floor((civilDayDiff(span.startDay, span.endDay) + 1) / 7),
    weekStart,
    mode: year === null ? "recent" : "year",
    year,
    fromDay,
    toDay,
  };

  return { ...result, grid };
}

/** `year` 只接受 1970..2200 的四位数字，其余一律当作未提供（10.2）。 */
function parseYear(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{4}$/.test(raw)) return null;
  const year = Number(raw);
  return year >= 1970 && year <= 2200 ? year : null;
}

/** `GET /api/breakdown`：`groups[]`（10.2 / FR-5.3）。 */
export function buildBreakdown(ctx: MonitorContext, query: QueryOptions): AggregateResult {
  const tz = resolveQueryTimezone(ctx, query);
  const window = resolveQueryWindow(ctx, query, tz);
  return buildAggregate({
    records: recordsForTimezone(ctx.engine.records, tz),
    window,
    filters: readFilters(query),
    rate: ctx.engine.config.currency.rate,
    rateSource: ctx.engine.config.currency.rateSource,
    weekStart: ctx.engine.config.weekStart,
    now: Date.now(),
    locale: ctx.locale,
    dimension: normalizeDimension(query.dim),
    withGroups: true,
    limit: normalizeLimit(query.limit, ctx.engine.config.tableLimit, 200),
    labelFor: labelFor(ctx.locale),
  }).result;
}

/** `GET /api/export?window=&format=json`：与页面一致的聚合 JSON（FR-9.6）。 */
export function buildExport(ctx: MonitorContext, query: QueryOptions): AggregateResult {
  const tz = resolveQueryTimezone(ctx, query);
  const window = resolveQueryWindow(ctx, query, tz);
  return buildAggregate({
    records: recordsForTimezone(ctx.engine.records, tz),
    window,
    filters: readFilters(query),
    rate: ctx.engine.config.currency.rate,
    rateSource: ctx.engine.config.currency.rateSource,
    weekStart: ctx.engine.config.weekStart,
    now: Date.now(),
    locale: ctx.locale,
    dimension: normalizeDimension(query.dim ?? "model"),
    withDaily: true,
    withGroups: true,
    metric: normalizeMetric(query.metric),
    limit: 200,
    health: ctx.engine.meta,
    labelFor: labelFor(ctx.locale),
  }).result;
}

/** `token_stats` 工具取数（FR-7）：`totals` + `groups` + `daily`，金额为人民币。 */
export function buildToolAggregate(ctx: MonitorContext, query: QueryOptions, limit: number): AggregateResult {
  const tz = resolveQueryTimezone(ctx, query);
  const window = resolveQueryWindow(ctx, query, tz);
  return buildAggregate({
    records: recordsForTimezone(ctx.engine.records, tz),
    window,
    filters: readFilters(query),
    rate: ctx.engine.config.currency.rate,
    rateSource: ctx.engine.config.currency.rateSource,
    weekStart: ctx.engine.config.weekStart,
    now: Date.now(),
    locale: ctx.locale,
    dimension: normalizeDimension(query.dim),
    withDaily: true,
    withGroups: true,
    metric: normalizeMetric(query.metric),
    limit,
    health: ctx.engine.meta,
    labelFor: labelFor(ctx.locale),
  }).result;
}

export interface RecordsPage {
  records: UsageRecord[];
  total: number;
  nextCursor: string | null;
  limit: number;
}

/** `GET /api/records?window=&limit=100&cursor=`：分页原始记录（≤ 500/页）。 */
export function buildRecords(ctx: MonitorContext, query: QueryOptions): RecordsPage {
  const tz = resolveQueryTimezone(ctx, query);
  const window = resolveQueryWindow(ctx, query, tz);
  const limit = Math.min(500, normalizeLimit(query.limit, 100, 500));
  const filters = readFilters(query);
  const filtered = recordsForTimezone(ctx.engine.records, tz)
    .filter(
      (record) =>
        record.ts >= window.fromMs && record.ts <= window.toMs && matchesFilters(record, filters),
    )
    .sort((a, b) => (a.ts === b.ts ? (a.fp < b.fp ? -1 : 1) : a.ts - b.ts));

  const offset = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
  const page = filtered.slice(offset, offset + limit);
  return {
    records: page,
    total: filtered.length,
    nextCursor: offset + limit < filtered.length ? String(offset + limit) : null,
    limit,
  };
}

function matchesFilters(record: UsageRecord, filters: QueryFilters): boolean {
  if (filters.project !== undefined && record.project !== filters.project) return false;
  if (filters.provider !== undefined && (record.provider ?? "(unknown)") !== filters.provider) return false;
  if (filters.model !== undefined && (record.model ?? "(unknown)") !== filters.model) return false;
  if (filters.source !== undefined && record.source !== filters.source) return false;
  if (filters.sessionId !== undefined && record.sessionId !== filters.sessionId) return false;
  return true;
}

/** `GET /api/health`（10.2 / FR-12.7）。 */
export function buildHealthResponse(ctx: MonitorContext): HealthReport {
  return buildHealthReport({
    meta: ctx.engine.meta,
    indexSizeBytes: measureIndexSize([ctx.engine.paths.ledger, ctx.engine.paths.cursor, ctx.engine.paths.meta]),
    dataDir: ctx.engine.dataDir,
    logPath: ctx.logPath,
    readOnly: ctx.readOnly || ctx.engine.readOnly,
    lockTimeout: ctx.lockTimeout || ctx.engine.lockTimeout,
    dedupeDisabled: ctx.engine.config.dedupe === "off",
  });
}

/** 10.1 预算进度条：日/月各一条；未配置时隐藏。 */
export interface BudgetProgressPayload {
  limitCNY: number;
  spentCNY: number;
  ratio: number;
  exceeded: boolean;
  overCNY: number;
}

export interface ConfigResponse {
  locale: Locale;
  localeSetting: string;
  currency: {
    code: "CNY";
    symbol: "¥";
    rate: number;
    rateSource: RateSource;
    /** ¥8：是否允许联网自动获取汇率。 */
    autoRate: boolean;
    /** 上次自动获取时间（ISO）或 null；用于「是否过期」判定。 */
    rateFetchedAt: string | null;
  };
  theme: string;
  timezone: string;
  weekStart: string;
  dedupe: string;
  budget: {
    enabled: boolean;
    dailyCNY: number | null;
    monthlyCNY: number | null;
    warnAt: number[];
    includeEstimated: boolean;
    injectMessage: boolean;
  };
  budgetProgress: { daily: BudgetProgressPayload | null; monthly: BudgetProgressPayload | null };
  dashboard: {
    allowLan: boolean;
    port: number;
    stopOnExit: boolean;
    linkMessage: boolean;
    enabled: boolean;
    autoRefresh: boolean;
  };
  tool: { enabled: boolean };
  tableLimit: number;
  defaultWindow: string | number;
  writableKeys: string[];
  warnings: string[];
  readOnly: boolean;
}

/** `GET /api/config`：只读配置子集 + `locale` + `currency`（10.2 / FR-11.6）。 */
export function buildConfigResponse(ctx: MonitorContext): ConfigResponse {
  const config = ctx.engine.config;
  const rate = config.currency.rate;
  const tz = ctx.engine.timezone;
  const weekStart = config.weekStart;
  const now = Date.now();
  const records = recordsForTimezone(ctx.engine.records, tz);
  const includeEstimated = config.budget.includeEstimated;

  // FR-10.2 / FR-10.6：预算判定使用真实成本，`includeEstimated` 时才计入估算（$4 / ¥2）。
  const daily = buildAggregate({
    records,
    window: resolveWindow({ kind: "today" }, { tz, weekStart, now }),
    filters: {},
    rate,
    rateSource: config.currency.rateSource,
    weekStart,
    now,
    locale: ctx.locale,
    labelFor: labelFor(ctx.locale),
  }).result.totals;
  const monthly = buildAggregate({
    records,
    window: resolveWindow({ kind: "month" }, { tz, weekStart, now }),
    filters: {},
    rate,
    rateSource: config.currency.rateSource,
    weekStart,
    now,
    locale: ctx.locale,
    labelFor: labelFor(ctx.locale),
  }).result.totals;

  return {
    locale: ctx.locale,
    localeSetting: config.locale,
    currency: {
      code: "CNY",
      symbol: "¥",
      rate,
      rateSource: config.currency.rateSource,
      autoRate: config.currency.autoRate,
      rateFetchedAt: config.currency.rateFetchedAt,
    },
    theme: config.dashboard.theme,
    timezone: tz,
    weekStart,
    dedupe: config.dedupe,
    budget: { ...config.budget },
    budgetProgress: {
      daily: buildBudgetProgress(config.budget.dailyCNY, daily.cost.cny.known, includeEstimated ? daily.cost.cny.estimated : null),
      monthly: buildBudgetProgress(
        config.budget.monthlyCNY,
        monthly.cost.cny.known,
        includeEstimated ? monthly.cost.cny.estimated : null,
      ),
    },
    dashboard: { ...config.dashboard },
    tool: { ...config.tool },
    tableLimit: config.tableLimit,
    defaultWindow: config.defaultWindow,
    // FR-11.6：可写键列表直接来自配置层白名单，避免两处漂移。
    writableKeys: [...WRITABLE_CONFIG_PATHS],
    warnings: ctx.loaded.warnings,
    readOnly: ctx.readOnly || ctx.engine.readOnly,
  };
}

function buildBudgetProgress(
  limit: number | null,
  known: number | null,
  estimated: number | null,
): BudgetProgressPayload | null {
  if (limit === null || limit === undefined || limit <= 0) return null;
  const spent = (known ?? 0) + (estimated ?? 0);
  return {
    limitCNY: limit,
    spentCNY: spent,
    ratio: spent / limit,
    exceeded: spent > limit,
    overCNY: Math.max(0, spent - limit),
  };
}

export interface ConfigUpdateOutcome {
  ok: boolean;
  rejected: string[];
  warnings: string[];
  unknownKeys: string[];
}

/** `PUT /api/config`：仅白名单键（FR-11.6 / AC-11.5）。 */
export function applyConfigUpdate(ctx: MonitorContext, patch: Record<string, unknown>): ConfigUpdateOutcome {
  if (ctx.readOnly || ctx.engine.readOnly) {
    return { ok: false, rejected: Object.keys(patch), warnings: ["index is read-only"], unknownKeys: [] };
  }
  const result = updateConfigFile(ctx.configPath, patch, ctx.loaded);
  if (!result.ok) {
    return { ok: false, rejected: result.rejected, warnings: ctx.loaded.warnings, unknownKeys: ctx.loaded.unknownKeys };
  }
  // ¥4 / ¥8：用户手动写入 `currency.rate` 就把来源标为「手动设置」并清空获取时间；
  // 否则在下一次自动获取之前，页头会被错误地标成「自动获取」。
  const manualRate = flatten(patch)["currency.rate"] !== undefined;
  const next: LoadedConfig = manualRate
    ? writeCurrencyState(
        ctx.configPath,
        { config: result.config, warnings: result.warnings, unknownKeys: result.unknownKeys, raw: result.raw, exists: true },
        { rateSource: "manual", rateFetchedAt: null },
      )
    : { config: result.config, warnings: result.warnings, unknownKeys: result.unknownKeys, raw: result.raw, exists: true };
  // 就地更新（不换对象）：扩展与 engine 共享同一个 LoadedConfig 引用。
  adoptConfig(ctx, next);
  return { ok: true, rejected: [], warnings: result.warnings, unknownKeys: result.unknownKeys };
}

/** 把新的 `LoadedConfig` 合并进现有上下文与引擎（¥5：汇率变更立即生效且不动 revision）。 */
function adoptConfig(ctx: MonitorContext, next: LoadedConfig): void {
  ctx.loaded.config = next.config;
  ctx.loaded.warnings = next.warnings;
  ctx.loaded.unknownKeys = next.unknownKeys;
  ctx.loaded.raw = next.raw;
  ctx.loaded.exists = next.exists;
  ctx.engine.setConfig(next.config);
}

export interface AutoRateOutcome {
  ok: boolean;
  /** 本次是否真的重新取回了汇率（false = 不需要或不符条件）。 */
  applied: boolean;
  /** ¥8 开关是否打开。 */
  autoRate: boolean;
  /** 本次调用后是否需要（仍需要）联网取回。 */
  stale: boolean;
  rate: number;
  rateSource: RateSource;
  fetchedAt: string | null;
  asOf: string | null;
  provider: string | null;
  /** 失败原因（单行）；成功时为 null。 */
  reason: string | null;
  attempts: RateAttempt[];
}

/** ¥8：当前是否处于「需要重新联网取汇率」的状态。 */
export function isAutoRateStale(ctx: MonitorContext, nowMs = Date.now()): boolean {
  const config = ctx.engine.config;
  if (!config.currency.autoRate) return false;
  if (config.currency.rateSource !== "auto") return true;
  return isRateStale(config.currency.rateFetchedAt, nowMs);
}

/**
 * ¥8：按开关与 TTL 获取并应用自动汇率。
 *  - `force: true`（仪表盘「立即更新」/`POST /api/rate/refresh`）：忽略 TTL 与开关，强制取一次；
 *  - 默认：仅在 `currency.autoRate` 打开且 已过期（或从未取过）时才联网；
 *  - 任何失败都不影响现有汇率（只回退到上次的值）；
 *  - 只读模式（高版本索引 / 锁超时）不写盘。
 */
export async function refreshAutoRate(
  ctx: MonitorContext,
  options: { force?: boolean; nowMs?: number } = {},
): Promise<AutoRateOutcome> {
  const force = options.force === true;
  const nowMs = options.nowMs ?? Date.now();
  const config = ctx.engine.config;
  const current = {
    rate: config.currency.rate,
    rateSource: config.currency.rateSource,
    fetchedAt: config.currency.rateFetchedAt,
  };

  if (!force && !isAutoRateStale(ctx, nowMs)) {
    return {
      ok: true,
      applied: false,
      autoRate: config.currency.autoRate,
      stale: false,
      rate: current.rate,
      rateSource: current.rateSource,
      fetchedAt: current.fetchedAt,
      asOf: null,
      provider: null,
      reason: null,
      attempts: [],
    };
  }

  const result = await fetchUsdCnyRate(
    ctx.rateFetcher === undefined ? { now: () => nowMs } : { fetcher: ctx.rateFetcher, now: () => nowMs },
  );
  if (result.quote === null) {
    const failed = result.attempts.filter((attempt) => !attempt.ok && attempt.reason !== undefined);
    const reason = failed.length > 0
      ? `${failed[0]!.provider}: ${failed[0]!.reason}`
      : "没有可用的汇率来源";
    return {
      ok: false,
      applied: false,
      autoRate: config.currency.autoRate,
      stale: config.currency.autoRate,
      rate: current.rate,
      rateSource: current.rateSource,
      fetchedAt: current.fetchedAt,
      asOf: null,
      provider: null,
      reason,
      attempts: result.attempts,
    };
  }

  if (!ctx.readOnly && !ctx.engine.readOnly) {
    adoptConfig(
      ctx,
      writeCurrencyState(ctx.configPath, ctx.loaded, {
        rate: result.quote.rate,
        rateSource: "auto",
        rateFetchedAt: result.fetchedAt,
      }),
    );
  } else {
    // 只读运行：内存里仍然用取到的汇率展示（¥5：不写盘、不动 revision）。
    const next = structuredClone(ctx.engine.config);
    next.currency.rate = result.quote.rate;
    next.currency.rateSource = "auto";
    next.currency.rateFetchedAt = result.fetchedAt;
    ctx.engine.setConfig(next);
  }

  return {
    ok: true,
    applied: true,
    autoRate: ctx.engine.config.currency.autoRate,
    stale: false,
    rate: ctx.engine.config.currency.rate,
    rateSource: ctx.engine.config.currency.rateSource,
    fetchedAt: ctx.engine.config.currency.rateFetchedAt,
    asOf: result.quote.asOf,
    provider: result.quote.provider,
    reason: null,
    attempts: result.attempts,
  };
}

export interface DedupeResponse {
  total: number;
  items: DedupeSkip[];
}

/** `GET /api/dedupe`：去重跳过明细，最多 200 条（FR-3.2 / D-3）。 */
export function buildDedupeResponse(ctx: MonitorContext): DedupeResponse {
  return { total: ctx.engine.dedupeSkips.length, items: ctx.engine.dedupeSkips.slice(0, 200) };
}

function normalizeMetric(metric: string | undefined): Metric {
  if (metric === "cost" || metric === "messages") return metric;
  return "tokens";
}

function normalizeDimension(dim: string | undefined): AggregateDimension {
  if (dim !== undefined && (DIMENSIONS as readonly string[]).includes(dim)) return dim as AggregateDimension;
  return "model";
}

function normalizeLimit(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(max, value));
}
