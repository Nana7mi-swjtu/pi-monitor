/**
 * aggregate.test.ts — 第 8 章（8.1~8.4）、FR-5、AC-5.1~AC-5.4、AC-7.4。
 *
 * 8.1 的不变量以属性测试形式验证：`sum(按维度分解) == 窗口总计`（token / 成本 / 消息数三者）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyFilters,
  buildAggregate,
  computeBuckets,
  computeDaily,
  computeGroups,
  emptyTotals,
  filterByWindow,
  metricValue,
  sumTotals,
} from "../../src/aggregate.ts";
import { materializeRecords } from "../../src/scanner.ts";
import { resolveWindow } from "../../src/time.ts";
import type { AggregateDimension, DailyRow, Totals, UsageRecord } from "../../src/types.ts";
import { fixturePath, parseFixture } from "../helpers.ts";

const EXPECTED_TZ = "UTC";

async function fixtureRecords(name: string): Promise<UsageRecord[]> {
  const parsed = await parseFixture(name);
  return materializeRecords(parsed, fixturePath(name), EXPECTED_TZ);
}

function allWindow(now: number) {
  return resolveWindow({ kind: "all" }, { tz: EXPECTED_TZ, weekStart: "monday", now });
}

const ALL_DIMENSIONS: readonly AggregateDimension[] = [
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

test("AC-5.1 / AC-5.2：sum(按维度分解) == 窗口总计（token / 成本 / 消息数）", async () => {
  const records = [
    ...(await fixtureRecords("normal-basic.jsonl")),
    ...(await fixtureRecords("cache-heavy.jsonl")),
    ...(await fixtureRecords("mixed-currency.jsonl")),
    ...(await fixtureRecords("compaction-usage.jsonl")),
  ];
  const now = Date.parse("2026-09-20T00:00:00.000Z");
  const window = allWindow(now);
  const rate = 7.2;
  const totals = sumTotals(filterByWindow(records, window), rate);

  for (const dimension of ALL_DIMENSIONS) {
    const groups = computeGroups(filterByWindow(records, window), dimension, rate, "monday");
    const sum = groups.reduce(
      (acc, group) => ({
        billed: acc.billed + group.totals.tokens.billed,
        input: acc.input + group.totals.tokens.input,
        messages: acc.messages + group.totals.messages.total,
        usdKnown: (acc.usdKnown ?? 0) + (group.totals.cost.usd.known ?? 0),
        usdEstimated: (acc.usdEstimated ?? 0) + (group.totals.cost.usd.estimated ?? 0),
      }),
      { billed: 0, input: 0, messages: 0, usdKnown: null as number | null, usdEstimated: null as number | null },
    );
    assert.equal(sum.billed, totals.tokens.billed, `${dimension} billed 求和`);
    assert.equal(sum.input, totals.tokens.input, `${dimension} input 求和`);
    assert.equal(sum.messages, totals.messages.total, `${dimension} 消息数求和`);
    assert.ok(Math.abs((sum.usdKnown ?? 0) - (totals.cost.usd.known ?? 0)) < 1e-9, `${dimension} USD 真实成本求和`);
    assert.ok(
      Math.abs((sum.usdEstimated ?? 0) - (totals.cost.usd.estimated ?? 0)) < 1e-9,
      `${dimension} USD 估算成本求和`,
    );
    // 占比之和为 100%（AC-8.3），无数据时除外。
    if (totals.tokens.billed > 0) {
      const shareSum = groups.reduce((acc, group) => acc + group.share, 0);
      assert.ok(Math.abs(shareSum - 1) < 1e-9, `${dimension} 占比之和必须为 1`);
    }
  }
});

test("AC-5.1：sum(每日) == 窗口总计", async () => {
  const records = await fixtureRecords("normal-basic.jsonl");
  const window = allWindow(Date.parse("2026-09-20T00:00:00.000Z"));
  const inWindow = filterByWindow(records, window);
  const totals = sumTotals(inWindow, 7.2);
  const daily = computeDaily(inWindow, 7.2);
  const billedSum = daily.reduce((sum, row) => sum + row.totals.tokens.billed, 0);
  assert.equal(billedSum, totals.tokens.billed);
  const costSum = daily.reduce((sum, row) => sum + (row.totals.cost.usd.known ?? 0), 0);
  assert.ok(Math.abs(costSum - (totals.cost.usd.known as number)) < 1e-12);
});

test("AC-5.4：空窗口返回结构完整的零值对象（禁止返回 null）", () => {
  const window = resolveWindow(
    { kind: "custom", fromDay: "1999-01-01", toDay: "1999-01-02" },
    { tz: EXPECTED_TZ, weekStart: "monday", now: Date.now() },
  );
  const { result } = buildAggregate({
    records: [],
    window,
    filters: {},
    rate: 7.2,
    weekStart: "monday",
    now: Date.now(),
    locale: "en-US",
    dimension: "model",
    withDaily: true,
    withGroups: true,
    labelFor: () => "empty",
  });
  assert.deepEqual(result.totals, emptyTotals());
  assert.deepEqual(result.groups, [], "空结果必须是空数组而非 undefined");
  assert.deepEqual(result.daily, []);
  assert.equal(result.totals.cost.cny.known, null, "未知成本必须为 null（¥7）");
  assert.equal(result.currency.symbol, "¥");
  assert.equal(result.schemaVersion, 1);
});

test("FR-5.2：过滤器可组合（AND）", async () => {
  const records = [
    ...(await fixtureRecords("normal-basic.jsonl")),
    ...(await fixtureRecords("piweb-custom.jsonl")),
  ];
  assert.equal(applyFilters(records, {}).length, records.length);
  assert.equal(applyFilters(records, { source: "pi" }).length, 2);
  assert.equal(applyFilters(records, { source: "pi-web" }).length, 1);
  assert.equal(applyFilters(records, { model: "acme-1" }).length, 2, "toolResult 无 model，归入 (unknown)");
  assert.equal(applyFilters(records, { model: "acme-1", source: "pi" }).length, 1, "过滤器为 AND");
  assert.equal(applyFilters(records, { model: "acme-1", sessionId: "sess-piweb" }).length, 1);
  assert.equal(applyFilters(records, { provider: "nobody" }).length, 0);
  assert.equal(applyFilters(records, { provider: "(unknown)" }).length, 1, "null provider 归入 (unknown)");
  assert.equal(applyFilters(records, { project: "D:\\fixtures\\proj-piweb" }).length, 1);
});

test("M-3 / M-4：真实成本与估算成本分开合计，且 CNY 由 USD 合计换算得出", async () => {
  const records = await fixtureRecords("mixed-currency.jsonl");
  const window = allWindow(Date.parse("2026-09-20T00:00:00.000Z"));
  const totals = sumTotals(filterByWindow(records, window), 7.2);
  assert.equal(totals.cost.usd.known, 0.000015);
  assert.equal(totals.cost.usd.estimated, null, "$3：无定价 → 估算为 null（展示 —）");
  assert.equal(totals.cost.cny.known, 0.000108, "0.000015 × 7.2");
  assert.equal(totals.cost.cny.estimated, null);
});

test("8.3：上一窗口无记录时 comparison.hasData=false", async () => {
  const records = await fixtureRecords("normal-basic.jsonl");
  const window = resolveWindow(
    { kind: "custom", fromDay: "2026-09-19", toDay: "2026-09-19" },
    { tz: EXPECTED_TZ, weekStart: "monday", now: Date.parse("2026-09-19T12:00:00Z") },
  );
  const { result } = buildAggregate({
    records,
    window,
    filters: {},
    rate: 7.2,
    weekStart: "monday",
    now: Date.parse("2026-09-19T12:00:00Z"),
    locale: "en-US",
    comparison: { totals: sumTotals([], 7.2), hasData: false },
    labelFor: () => "custom",
  });
  assert.equal(result.comparison?.hasData, false);
});

test("8.4：非零日 < 4 时退化为等距分桶并追加图例说明", () => {
  const rows: DailyRow[] = [
    { day: "2026-09-01", totals: withBilled(10) },
    { day: "2026-09-02", totals: withBilled(20) },
    { day: "2026-09-03", totals: withBilled(0) },
  ];
  const buckets = computeBuckets(rows, "tokens");
  assert.equal(buckets.equalBuckets, true);
  assert.equal(buckets.legend.length, 6);
  assert.equal(buckets.legend[5], "样本不足，使用等距分桶");
});

test("8.4：非零日 >= 4 时按 p50/p75/p90 分 4 档", () => {
  const rows: DailyRow[] = [10, 20, 30, 40, 50].map((value, index) => ({
    day: `2026-09-0${index + 1}`,
    totals: withBilled(value),
  }));
  const buckets = computeBuckets(rows, "tokens");
  assert.equal(buckets.equalBuckets, false);
  assert.deepEqual(buckets.edges, [30, 40, 50]);
  assert.equal(buckets.legend[0], "0");
  assert.equal(buckets.legend.length, 5);
});

test("8.4：热力图指标切换（tokens / cost / messages）使用不同数值来源", () => {
  const row: DailyRow = { day: "2026-09-19", totals: withBilled(100) };
  assert.equal(metricValue(row, "tokens"), 100);
  assert.equal(metricValue(row, "messages"), 3);
  assert.equal(metricValue(row, "cost"), 7.2);
});

test("AC-7.4：工具/仪表盘共用同一聚合实现（all 窗口同一数字）", async () => {
  const records = await fixtureRecords("cache-heavy.jsonl");
  const window = allWindow(Date.parse("2026-09-20T00:00:00.000Z"));
  const viaSum = sumTotals(filterByWindow(records, window), 7.2);
  const { result } = buildAggregate({
    records,
    window,
    filters: {},
    rate: 7.2,
    weekStart: "monday",
    now: Date.parse("2026-09-20T00:00:00.000Z"),
    locale: "en-US",
    labelFor: () => "all",
  });
  assert.equal(result.totals.tokens.billed, viaSum.tokens.billed);
  assert.equal(result.window.from, "2026-09-19");
  assert.equal(result.window.to, "2026-09-19");
  assert.equal(result.window.days, 1);
});

test("limit 截断：groups 被裁剪且 truncated 为 true（AC-7.2 的结构前提）", async () => {
  const records = await fixtureRecords("normal-basic.jsonl");
  const window = allWindow(Date.parse("2026-09-20T00:00:00.000Z"));
  const { result, truncated } = buildAggregate({
    records,
    window,
    filters: {},
    rate: 7.2,
    weekStart: "monday",
    now: Date.now(),
    locale: "en-US",
    dimension: "kind",
    withGroups: true,
    limit: 1,
    labelFor: () => "all",
  });
  assert.equal(truncated, true);
  assert.equal(result.truncated, true);
  assert.equal(result.groups?.length, 1);
});

function withBilled(billed: number): Totals {
  const totals = emptyTotals();
  totals.tokens.billed = billed;
  totals.tokens.input = billed;
  totals.messages.total = 3;
  totals.cost.usd.known = billed / 100;
  totals.cost.cny.known = (billed / 100) * 7.2;
  return totals;
}
