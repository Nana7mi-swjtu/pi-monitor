/**
 * budget.ts — 预算提醒（纯函数，无 IO；状态由调用方读写）。
 * 需求：FR-10（含 AC-10.1~AC-10.5）、¥2、$4、M-4
 */

import { round6 } from "./money.ts";
import type { BudgetAlert, BudgetProgress, BudgetState, MoneyTotals, PiMonitorConfig } from "./types.ts";

export interface BudgetEvaluateInput {
  config: PiMonitorConfig;
  rate: number;
  /** 当前时区下的日键（YYYY-MM-DD）。 */
  day: string;
  /** 当前时区下的月键（YYYY-MM）。 */
  month: string;
  /** 今日 USD 合计（真实 / 估算分开）。 */
  todayUsd: MoneyTotals;
  /** 本月 USD 合计。 */
  monthUsd: MoneyTotals;
  state: BudgetState;
}

export interface BudgetEvaluateOutput {
  state: BudgetState;
  alerts: BudgetAlert[];
  progress: BudgetProgress[];
}

/** M-4：先合计 USD，再一次性换算为 CNY。 */
export function spendCNY(totals: MoneyTotals, rate: number, includeEstimated: boolean): number {
  const known = totals.known ?? 0;
  const estimated = includeEstimated ? (totals.estimated ?? 0) : 0;
  return round6((known + estimated) * rate);
}

/**
 * FR-10：判定与提醒。
 *  - FR-10.7：未启用时完全静默（返回空 alerts，且不改动 state）。
 *  - FR-10.5：同一周期同一阈值只提醒一次；日/月切换时重置。
 *  - AC-10.5：汇率在每次评估时读取，变更后立即生效。
 */
export function evaluateBudget(input: BudgetEvaluateInput): BudgetEvaluateOutput {
  const { config, rate, day, month, state } = input;

  if (!config.budget.enabled) {
    return { state, alerts: [], progress: [] };
  }

  // FR-10.5：日/月切换时重置阈值状态。
  const nextState: BudgetState = {
    schemaVersion: state.schemaVersion || 1,
    day,
    month,
    fired: {
      daily: state.day === day ? [...state.fired.daily] : [],
      monthly: state.month === month ? [...state.fired.monthly] : [],
    },
  };

  const alerts: BudgetAlert[] = [];
  const progress: BudgetProgress[] = [];
  const includeEstimated = config.budget.includeEstimated;
  const thresholds = [...config.budget.warnAt].filter((w) => w > 0 && w <= 1).sort((a, b) => a - b);

  const periods: Array<{ period: "daily" | "monthly"; limit: number | null; spentCNY: number }> = [
    { period: "daily", limit: config.budget.dailyCNY, spentCNY: spendCNY(input.todayUsd, rate, includeEstimated) },
    { period: "monthly", limit: config.budget.monthlyCNY, spentCNY: spendCNY(input.monthUsd, rate, includeEstimated) },
  ];

  for (const item of periods) {
    if (item.limit === null || item.limit === undefined || item.limit <= 0) continue;
    const ratio = item.spentCNY / item.limit;
    progress.push({
      period: item.period,
      limitCNY: item.limit,
      spentCNY: item.spentCNY,
      ratio,
      exceeded: item.spentCNY > item.limit,
      overCNY: round6(Math.max(0, item.spentCNY - item.limit)),
    });

    const fired = item.period === "daily" ? nextState.fired.daily : nextState.fired.monthly;
    for (const threshold of thresholds) {
      if (ratio < threshold) continue;
      if (fired.includes(threshold)) continue;
      fired.push(threshold);
      alerts.push({
        period: item.period,
        threshold,
        spentCNY: item.spentCNY,
        limitCNY: item.limit,
      });
    }
  }

  return { state: nextState, alerts, progress };
}

/** FR-10.6：预算进度条（未配置的量级不返回）。 */
export function budgetProgressOnly(output: BudgetEvaluateOutput): BudgetProgress[] {
  return output.progress;
}
