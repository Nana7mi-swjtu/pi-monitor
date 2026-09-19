/**
 * budget.test.ts — FR-10（AC-10.1~AC-10.5）、¥2、$4、M-4。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { evaluateBudget, spendCNY } from "../../src/budget.ts";
import { defaultConfig } from "../../src/config.ts";
import type { BudgetState, PiMonitorConfig } from "../../src/types.ts";

function config(overrides: Partial<PiMonitorConfig["budget"]> = {}): PiMonitorConfig {
  const base = defaultConfig();
  base.budget = { ...base.budget, enabled: true, dailyCNY: 10, monthlyCNY: null, ...overrides };
  return base;
}

function state(day: string, month: string, daily: number[] = [], monthly: number[] = []): BudgetState {
  return { schemaVersion: 1, day, month, fired: { daily, monthly } };
}

test("AC-10.1：日预算 ¥10、当日 ¥6 → 触发一次 50% 提醒；重复评估不重复提醒", () => {
  const input = {
    config: config(),
    rate: 1,
    day: "2026-09-19",
    month: "2026-09",
    todayUsd: { known: 6, estimated: null },
    monthUsd: { known: 6, estimated: null },
  };

  const first = evaluateBudget({ ...input, state: state("2026-09-19", "2026-09") });
  assert.equal(first.alerts.length, 1);
  assert.deepEqual(first.alerts[0], { period: "daily", threshold: 0.5, spentCNY: 6, limitCNY: 10 });
  assert.equal(first.progress.length, 1, "月预算未配置 → 不返回月进度条");

  const second = evaluateBudget({ ...input, state: first.state });
  assert.equal(second.alerts.length, 0, "FR-10.5：同周期同阈值只提醒一次");
  assert.deepEqual(second.state.fired.daily, [0.5]);
});

test("AC-10.1：跨过 80% 时会新增一次提醒（同周期不同阈值）", () => {
  const first = evaluateBudget({
    config: config(),
    rate: 1,
    day: "2026-09-19",
    month: "2026-09",
    todayUsd: { known: 6, estimated: null },
    monthUsd: { known: 6, estimated: null },
    state: state("2026-09-19", "2026-09"),
  });
  const second = evaluateBudget({
    config: config(),
    rate: 1,
    day: "2026-09-19",
    month: "2026-09",
    todayUsd: { known: 8.5, estimated: null },
    monthUsd: { known: 8.5, estimated: null },
    state: first.state,
  });
  assert.deepEqual(second.alerts.map((alert) => alert.threshold), [0.8]);
});

test("AC-10.2：跨日后阈值状态重置，可再次提醒", () => {
  const first = evaluateBudget({
    config: config(),
    rate: 1,
    day: "2026-09-19",
    month: "2026-09",
    todayUsd: { known: 6, estimated: null },
    monthUsd: { known: 6, estimated: null },
    state: state("2026-09-18", "2026-09", [0.5]),
  });
  assert.equal(first.alerts.length, 1, "新的一天必须重新提醒");
  assert.deepEqual(first.state.fired.daily, [0.5]);

  const nextMonth = evaluateBudget({
    config: config(),
    rate: 1,
    day: "2026-10-01",
    month: "2026-10",
    todayUsd: { known: 6, estimated: null },
    monthUsd: { known: 60, estimated: null },
    state: state("2026-09-30", "2026-09", [0.5], [0.5, 0.8, 1.0]),
  });
  assert.deepEqual(nextMonth.state.fired.monthly, [], "跨月必须重置月阈值");
});

test("AC-10.3：未启用时完全静默（0 次提醒，且不改动状态）", () => {
  const disabled = defaultConfig();
  assert.equal(disabled.budget.enabled, false);
  const before = state("2026-09-19", "2026-09", [0.5]);
  const outcome = evaluateBudget({
    config: disabled,
    rate: 1,
    day: "2026-09-19",
    month: "2026-09",
    todayUsd: { known: 1000, estimated: 0 },
    monthUsd: { known: 1000, estimated: 0 },
    state: before,
  });
  assert.deepEqual(outcome.alerts, []);
  assert.deepEqual(outcome.progress, []);
  assert.deepEqual(outcome.state, before);
});

test("AC-10.5：汇率变更后预算判定立即使用新汇率", () => {
  const atRate1 = evaluateBudget({
    config: config(),
    rate: 1,
    day: "2026-09-19",
    month: "2026-09",
    todayUsd: { known: 6, estimated: null },
    monthUsd: { known: 6, estimated: null },
    state: state("2026-09-19", "2026-09"),
  });
  assert.deepEqual(atRate1.alerts.map((alert) => alert.threshold), [0.5]);

  const atRate2 = evaluateBudget({
    config: config(),
    rate: 2,
    day: "2026-09-19",
    month: "2026-09",
    todayUsd: { known: 6, estimated: null },
    monthUsd: { known: 6, estimated: null },
    state: state("2026-09-19", "2026-09"),
  });
  assert.deepEqual(atRate2.alerts.map((alert) => alert.threshold), [0.5, 0.8, 1.0], "USD 值不变，汇率翻倍即超支");
  assert.equal(atRate2.progress[0]?.spentCNY, 12);
  assert.equal(atRate2.progress[0]?.exceeded, true);
  assert.equal(atRate2.progress[0]?.overCNY, 2);
});

test("$4 / ¥2：默认只用真实成本；includeEstimated 时才计入估算", () => {
  const withoutEstimated = evaluateBudget({
    config: config(),
    rate: 1,
    day: "2026-09-19",
    month: "2026-09",
    todayUsd: { known: 1, estimated: 100 },
    monthUsd: { known: 1, estimated: 100 },
    state: state("2026-09-19", "2026-09"),
  });
  assert.equal(withoutEstimated.alerts.length, 0, "估算成本默认不参与判定");
  assert.equal(withoutEstimated.progress[0]?.spentCNY, 1);

  const withEstimated = evaluateBudget({
    config: config({ includeEstimated: true }),
    rate: 1,
    day: "2026-09-19",
    month: "2026-09",
    todayUsd: { known: 1, estimated: 100 },
    monthUsd: { known: 1, estimated: 100 },
    state: state("2026-09-19", "2026-09"),
  });
  assert.deepEqual(withEstimated.alerts.map((alert) => alert.threshold), [0.5, 0.8, 1.0]);
});

test("M-4：spendCNY 先合计 USD 再一次性换算", () => {
  assert.equal(spendCNY({ known: 0, estimated: 0 }, 7.2, false), 0);
  assert.equal(spendCNY({ known: 0.1, estimated: 0.2 }, 7.2, false), 0.72);
  assert.equal(spendCNY({ known: 0.1, estimated: 0.2 }, 7.2, true), 2.16);
  assert.equal(spendCNY({ known: null, estimated: null }, 7.2, true), 0, "无数据视为 0 支出");
});

test("FR-10.6：预算进度条超额时给出超支金额", () => {
  const outcome = evaluateBudget({
    config: config({ dailyCNY: 10, monthlyCNY: 100 }),
    rate: 7.2,
    day: "2026-09-19",
    month: "2026-09",
    todayUsd: { known: 2, estimated: null },
    monthUsd: { known: 20, estimated: null },
    state: state("2026-09-19", "2026-09"),
  });
  assert.equal(outcome.progress.length, 2);
  const daily = outcome.progress.find((item) => item.period === "daily");
  assert.ok(daily);
  assert.equal(daily.spentCNY, 14.4);
  assert.equal(daily.exceeded, true);
  assert.equal(daily.overCNY, 4.4);
});
