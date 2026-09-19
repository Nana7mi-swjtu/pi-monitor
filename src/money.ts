/**
 * money.ts — USD→CNY 唯一换算实现（纯函数，无 IO）。
 * 需求：8.5（M-1~M-5）、4.6.2（¥1~¥9）、AC-8.5.1~AC-8.5.3、P-13、P-14
 *
 * 禁止在本模块以外做任何货币换算（P-14：禁止逐条换算后求和）。
 */

import type { MoneyTotals } from "./types.ts";

/** M-2：四舍五入到 6 位小数，避免多次舍入误差累积。 */
export function round6(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * M-1/M-2/M-3：`toCNY(usd) = usd == null ? null : round(usd * rate, 6)`。
 * ¥2：只在展示层换算，绝不改写账本。
 * ¥7：未知成本必须保持 `null`（禁止显示 ¥0.00）。
 */
export function toCNY(usd: number | null, rate: number): number | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  return round6(usd * rate);
}

/**
 * M-4：合计的换算顺序 —— **先求 USD 合计再换算**。
 * M-5：汇率在调用前读取一次并传入，保证同一响应内一致。
 */
export function convertMoneyTotals(usd: MoneyTotals, rate: number): MoneyTotals {
  return { known: toCNY(usd.known, rate), estimated: toCNY(usd.estimated, rate) };
}

/** 累加 USD 合计：`null` 表示“尚无数据”，一旦有记录参与即为数值（M-3）。 */
export function addUsd(current: number | null, value: number | null): number | null {
  if (value === null) return current;
  return (current ?? 0) + value;
}

/** ¥2 展示层：人民币金额是否“未知”。 */
export function isUnknownMoney(value: number | null): boolean {
  return value === null;
}
