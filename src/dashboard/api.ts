/**
 * dashboard/api.ts — 路由 → aggregate 适配（10.2 HTTP API 契约）。
 * 需求：FR-5、FR-8、FR-9.6、FR-12、10.2（全部端点）、7.5（响应结构）、T-1、T-6
 *
 * 本模块只做「查询参数 → 聚合调用 → 响应对象」的编排，不实现任何求和逻辑（8.1）。
 */

import { buildAggregate, buildComparison, type Metric } from "../aggregate.ts";
import { updateConfigFile, type LoadedConfig } from "../config.ts";
import { buildHealthReport, measureIndexSize, type HealthReport } from "../health.ts";
import { windowLabel } from "../i18n.ts";
import type { MonitorEngine } from "../scanner.ts";
import { civilDayDiff, dayKey, heatmapGridRange, heatmapRange, isValidTimezone, parseWindowInput, previousWindow, resolveTimezone, resolveWindow } from "../time.ts";
import type {
  AggregateDimension,
  AggregateResult,
  DedupeSkip,
  HeatmapGrid,
  Locale,
  QueryFilters,
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

/** `GET /api/summary`：`Totals` + 环比 + `live`（10.2）。 */
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
    weekStart: ctx.engine.config.weekStart,
    now: Date.now(),
    locale: ctx.locale,
    live: ctx.engine.getLiveTotals(rate),
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
  const fromDay = year === null ? anchorDay : `${year}-01-01`;
  const toDay = year === null ? anchorDay : `${year}-12-31`;
  const span = year === null
    ? heatmapRange(anchorDay, weekStart, 53)
    : heatmapGridRange(fromDay, toDay, weekStart);
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
  currency: { code: "CNY"; symbol: "¥"; rate: number; rateSource: "manual" };
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
  dashboard: { allowLan: boolean; port: number; stopOnExit: boolean; linkMessage: boolean; enabled: boolean };
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
    weekStart,
    now,
    locale: ctx.locale,
    labelFor: labelFor(ctx.locale),
  }).result.totals;

  return {
    locale: ctx.locale,
    localeSetting: config.locale,
    currency: { code: "CNY", symbol: "¥", rate, rateSource: "manual" },
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
    writableKeys: [
      "currency.rate",
      "dashboard.theme",
      "dashboard.allowLan",
      "locale",
      "budget.enabled",
      "budget.dailyCNY",
      "budget.monthlyCNY",
      "budget.warnAt",
      "budget.includeEstimated",
      "budget.injectMessage",
    ],
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
  ctx.loaded = {
    config: result.config,
    warnings: result.warnings,
    unknownKeys: result.unknownKeys,
    raw: ctx.loaded.raw,
    exists: true,
  };
  // ¥5：汇率变更立即生效，且不改变历史成本的美元值与账本 revision。
  ctx.engine.setConfig(result.config);
  return { ok: true, rejected: [], warnings: result.warnings, unknownKeys: result.unknownKeys };
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
