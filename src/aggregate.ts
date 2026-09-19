/**
 * aggregate.ts — 唯一聚合实现（纯函数，无 IO）。
 * 需求：FR-5（含 AC-5.1~AC-5.5）、第 8 章（8.1 伪代码、8.2 窗口、8.3 环比、
 *       8.4 热力图分桶、8.5 货币换算调用契约：M-4/M-5）、7.5 聚合结果 schema
 *
 * 禁止各处重复实现求和：全项目只允许通过 `sumTotals` 累计。
 */

import { addUsd, convertMoneyTotals } from "./money.ts";
import { monthKey, weekKey } from "./time.ts";
import type {
  AggregateDimension,
  AggregateResult,
  Buckets,
  DailyRow,
  GroupRow,
  MessageTotals,
  MetaInfo,
  MoneyTotals,
  QueryFilters,
  RateSource,
  TokenTotals,
  Totals,
  UsageRecord,
  WeekStart,
  WindowSpec,
} from "./types.ts";

export type Metric = "tokens" | "cost" | "messages";

/** FR-5.6：空结果返回结构完整的零值对象，禁止返回 `null`。 */
export function emptyTotals(): Totals {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billed: 0 },
    messages: { assistant: 0, toolResult: 0, total: 0 },
    cost: { usd: { known: null, estimated: null }, cny: { known: null, estimated: null } },
    sessions: 0,
    activeDays: 0,
  };
}

/**
 * 8.1：`sumTotals` 是唯一实现。
 * M-4：**先求 USD 合计再换算**（禁止逐条换算后求和）。
 * M-5：`rate` 由调用方读取一次后传入，保证同一响应内一致。
 */
export function sumTotals(records: readonly UsageRecord[], rate: number): Totals {
  const tokens: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, billed: 0 };
  const messages: MessageTotals = { assistant: 0, toolResult: 0, total: 0 };
  const usd: MoneyTotals = { known: null, estimated: null };
  const sessions = new Set<string>();
  const days = new Set<string>();

  for (const record of records) {
    tokens.input += record.input;
    tokens.output += record.output;
    tokens.cacheRead += record.cacheRead;
    tokens.cacheWrite += record.cacheWrite;
    tokens.billed += record.billed;
    if (record.kind === "assistant") messages.assistant += 1;
    if (record.kind === "toolResult") messages.toolResult += 1;
    messages.total += 1;
    usd.known = addUsd(usd.known, record.costUsd);
    usd.estimated = addUsd(usd.estimated, record.costUsdEst);
    sessions.add(record.sessionId);
    days.add(record.day);
  }

  return {
    tokens,
    messages,
    cost: { usd, cny: convertMoneyTotals(usd, rate) },
    sessions: sessions.size,
    activeDays: days.size,
  };
}

/** 8.1：窗口过滤（T-5：以 `ts` 定位，不以文件时间近似）。 */
export function filterByWindow(records: readonly UsageRecord[], window: WindowSpec): UsageRecord[] {
  return records.filter((record) => record.ts >= window.fromMs && record.ts <= window.toMs);
}

/** FR-5.2：过滤器可组合（AND）。 */
export function applyFilters(records: readonly UsageRecord[], filters: QueryFilters): UsageRecord[] {
  const hasAny =
    filters.project !== undefined ||
    filters.provider !== undefined ||
    filters.model !== undefined ||
    filters.source !== undefined ||
    filters.sessionId !== undefined;
  if (!hasAny) return [...records];
  return records.filter((record) => {
    if (filters.project !== undefined && record.project !== filters.project) return false;
    if (filters.provider !== undefined && (record.provider ?? "(unknown)") !== filters.provider) return false;
    if (filters.model !== undefined && (record.model ?? "(unknown)") !== filters.model) return false;
    if (filters.source !== undefined && record.source !== filters.source) return false;
    if (filters.sessionId !== undefined && record.sessionId !== filters.sessionId) return false;
    return true;
  });
}

/** FR-5.3：维度键。 */
export function dimensionKey(record: UsageRecord, dimension: AggregateDimension, weekStart: WeekStart): string {
  switch (dimension) {
    case "day":
      return record.day;
    case "week":
      return weekKey(record.day, weekStart);
    case "month":
      return monthKey(record.day);
    case "provider":
      return record.provider ?? "(unknown)";
    case "model":
      return record.model ?? "(unknown)";
    case "project":
      return record.project;
    case "session":
      return record.sessionId;
    case "source":
      return record.source;
    case "kind":
      return record.kind;
    default:
      return "(unknown)";
  }
}

const TIME_DIMENSIONS: readonly AggregateDimension[] = ["day", "week", "month"];

/** 8.3：`share = group.billed / totals.billed`，`billed == 0` 时 `share = 0`。 */
export function computeGroups(
  records: readonly UsageRecord[],
  dimension: AggregateDimension,
  rate: number,
  weekStart: WeekStart,
): GroupRow[] {
  const buckets = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const key = dimensionKey(record, dimension, weekStart);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [record]);
    else bucket.push(record);
  }

  const groups: GroupRow[] = [];
  for (const [key, bucketRecords] of buckets) {
    groups.push({ key, label: key, totals: sumTotals(bucketRecords, rate), share: 0 });
  }

  const totalBilled = groups.reduce((sum, group) => sum + group.totals.tokens.billed, 0);
  for (const group of groups) {
    group.share = totalBilled === 0 ? 0 : group.totals.tokens.billed / totalBilled;
  }

  if (TIME_DIMENSIONS.includes(dimension)) {
    groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  } else {
    groups.sort((a, b) => {
      const diff = b.totals.tokens.billed - a.totals.tokens.billed;
      if (diff !== 0) return diff;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });
  }
  return groups;
}

/** 8.1：`daily = groupBy(records, r => r.day)`，按日升序。 */
export function computeDaily(records: readonly UsageRecord[], rate: number): DailyRow[] {
  const buckets = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const bucket = buckets.get(record.day);
    if (bucket === undefined) buckets.set(record.day, [record]);
    else bucket.push(record);
  }
  return [...buckets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([day, bucketRecords]) => ({ day, totals: sumTotals(bucketRecords, rate) }));
}

/** 8.4：某日的指标值。 */
export function metricValue(row: DailyRow, metric: Metric): number {
  switch (metric) {
    case "tokens":
      return row.totals.tokens.billed;
    case "messages":
      return row.totals.messages.total;
    case "cost":
    default:
      // 真实成本 + 估算成本：热力图是可视化，合并仅用于分桶；
      // 任何“金额数字”展示仍遵守 $4（真实 / 估算分开）。
      return (row.totals.cost.cny.known ?? 0) + (row.totals.cost.cny.estimated ?? 0);
  }
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] as number;
}

/**
 * 8.4：分桶 —— 非零日的指标值按 `p50 / p75 / p90` 分 4 档；0 单独一档。
 * 非零日 < 4 天时退化为等距分桶，图例后追加「样本不足，使用等距分桶」。
 */
export function computeBuckets(daily: readonly DailyRow[], metric: Metric): Buckets {
  const nonZero = daily
    .map((row) => metricValue(row, metric))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);

  if (nonZero.length < 4) {
    const min = nonZero.length > 0 ? Math.min(...nonZero) : 0;
    const max = nonZero.length > 0 ? Math.max(...nonZero) : 0;
    const span = max - min;
    const edges = [0, 1, 2, 3].map((i) => min + (span * (i + 1)) / 4);
    return {
      metric,
      p50: edges[0] as number,
      p75: edges[1] as number,
      p90: edges[2] as number,
      legend: [
        "0",
        `≤${formatBucket(edges[0] as number)}`,
        `≤${formatBucket(edges[1] as number)}`,
        `≤${formatBucket(edges[2] as number)}`,
        `>${formatBucket(edges[2] as number)}`,
        "样本不足，使用等距分桶",
      ],
      equalBuckets: true,
      edges,
    };
  }

  const p50 = percentile(nonZero, 0.5);
  const p75 = percentile(nonZero, 0.75);
  const p90 = percentile(nonZero, 0.9);
  return {
    metric,
    p50,
    p75,
    p90,
    legend: [
      "0",
      `≤${formatBucket(p50)}`,
      `≤${formatBucket(p75)}`,
      `≤${formatBucket(p90)}`,
      `>${formatBucket(p90)}`,
    ],
    equalBuckets: false,
    edges: [p50, p75, p90],
  };
}

function formatBucket(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value === 0) return "0";
  if (Math.abs(value) >= 100) return String(Math.round(value));
  if (Math.abs(value) >= 1) return value.toFixed(1);
  return value.toFixed(4);
}

export interface AggregateOptions {
  records: readonly UsageRecord[];
  window: WindowSpec;
  filters: QueryFilters;
  rate: number;
  /** ¥8：汇率的来源（manual / auto），仅用于展示。 */
  rateSource?: RateSource;
  weekStart: WeekStart;
  now: number;
  locale: string;
  dimension?: AggregateDimension;
  withDaily?: boolean;
  withGroups?: boolean;
  metric?: Metric;
  limit?: number;
  live?: Totals;
  health?: MetaInfo;
  comparison?: { totals: Totals; hasData: boolean };
  labelFor: (window: WindowSpec) => string;
}

export interface AggregateOutcome {
  result: AggregateResult;
  /** 窗口内的记录（已过滤），供导出 CSV 复用，避免重复过滤。 */
  windowed: UsageRecord[];
  truncated: boolean;
}

/**
 * 8.1 的唯一聚合入口。
 * 返回结构严格遵循 7.5（`truncated` 仅在截断时出现）。
 */
export function buildAggregate(options: AggregateOptions): AggregateOutcome {
  const { records, window, filters, rate, weekStart, limit } = options;

  const inWindow = filterByWindow(records, window);
  const filtered = applyFilters(inWindow, filters);

  // "all" 窗口：真实边界由账本数据回填。
  let effectiveWindow = window;
  if (window.kind === "all") {
    let fromDay = "";
    let toDay = "";
    for (const record of filtered) {
      if (fromDay === "" || record.day < fromDay) fromDay = record.day;
      if (toDay === "" || record.day > toDay) toDay = record.day;
    }
    const days = fromDay === "" ? 0 : Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000) + 1;
    effectiveWindow = { ...window, fromDay, toDay, from: fromDay, to: toDay, days };
  }

  const totals = sumTotals(filtered, rate);

  const result: AggregateResult = {
    schemaVersion: 1,
    generatedAt: new Date(options.now).toISOString(),
    currency: { code: "CNY", symbol: "¥", rate, rateSource: options.rateSource ?? "manual" },
    window: {
      from: effectiveWindow.from,
      to: effectiveWindow.to,
      tz: effectiveWindow.tz,
      label: options.labelFor(effectiveWindow),
      days: effectiveWindow.days,
      ...(effectiveWindow.swapped ? { swapped: true } : {}),
    },
    filters,
    totals,
  };

  let truncated = false;

  if (options.withGroups && options.dimension !== undefined) {
    const all = computeGroups(filtered, options.dimension, rate, weekStart);
    if (limit !== undefined && all.length > limit) {
      truncated = true;
      result.groups = all.slice(0, limit);
    } else {
      result.groups = all;
    }
  }

  if (options.withDaily) {
    const daily = computeDaily(filtered, rate);
    result.daily = daily;
    result.buckets = computeBuckets(daily, options.metric ?? "tokens");
  }

  if (options.live !== undefined) result.live = options.live;
  if (options.health !== undefined) result.health = options.health;
  if (options.comparison !== undefined) result.comparison = options.comparison;
  if (truncated) result.truncated = true;

  return { result, windowed: filtered, truncated };
}

/** 8.3：环比 —— 当前窗口 vs 紧邻等长前一窗口；上一窗口无记录时无数据。 */
export function buildComparison(
  records: readonly UsageRecord[],
  previous: WindowSpec,
  filters: QueryFilters,
  rate: number,
): { totals: Totals; hasData: boolean } {
  const inWindow = applyFilters(filterByWindow(records, previous), filters);
  return { totals: sumTotals(inWindow, rate), hasData: inWindow.length > 0 };
}

/** 供 dashboard 的「本会话」卡片合并实时计数（FR-4）。 */
export function addTotals(a: Totals, b: Totals): Totals {
  return {
    tokens: {
      input: a.tokens.input + b.tokens.input,
      output: a.tokens.output + b.tokens.output,
      cacheRead: a.tokens.cacheRead + b.tokens.cacheRead,
      cacheWrite: a.tokens.cacheWrite + b.tokens.cacheWrite,
      billed: a.tokens.billed + b.tokens.billed,
    },
    messages: {
      assistant: a.messages.assistant + b.messages.assistant,
      toolResult: a.messages.toolResult + b.messages.toolResult,
      total: a.messages.total + b.messages.total,
    },
    cost: {
      usd: {
        known: addUsd(a.cost.usd.known, b.cost.usd.known),
        estimated: addUsd(a.cost.usd.estimated, b.cost.usd.estimated),
      },
      cny: {
        known: addUsd(a.cost.cny.known, b.cost.cny.known),
        estimated: addUsd(a.cost.cny.estimated, b.cost.cny.estimated),
      },
    },
    sessions: Math.max(a.sessions, b.sessions),
    activeDays: Math.max(a.activeDays, b.activeDays),
  };
}
