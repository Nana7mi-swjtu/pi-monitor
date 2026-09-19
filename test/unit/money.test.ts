/**
 * money.test.ts — 8.5 货币换算唯一实现（M-1~M-5）、AC-8.5.1~AC-8.5.3。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { addUsd, convertMoneyTotals, round6, toCNY } from "../../src/money.ts";

test("AC-8.5.1：rate=7.2、单条 0.000217578 → 0.001567（6 位，M-2 四舍五入）", () => {
  // 0.000217578 × 7.2 = 0.0015665616，四舍五入到 6 位为 0.001567（不是截断的 0.001566）。
  assert.equal(toCNY(0.000217578, 7.2), 0.001567);
  assert.notEqual(toCNY(0.000217578, 7.2), 0.001566, "M-2 要求四舍五入，不是截断");
});

test("AC-8.5.2 / M-3：USD 为 null 时 CNY 必须为 null（禁止 ¥0）", () => {
  assert.equal(toCNY(null, 7.2), null);
  assert.equal(convertMoneyTotals({ known: null, estimated: null }, 7.2).known, null);
  assert.equal(convertMoneyTotals({ known: null, estimated: null }, 7.2).estimated, null);
});

test("M-2：四舍五入到 6 位小数", () => {
  assert.equal(toCNY(0.00000012345, 7.2), round6(0.00000012345 * 7.2));
  assert.equal(round6(1.0000004), 1);
  assert.equal(round6(1.2345674), 1.234567);
});

test("AC-8.5.3 / M-4：先合计 USD 再换算，与逐条换算后求和可区分", () => {
  // 构造 1000 条会放大误差的记录：逐条换算会得到不同的 6 位结果。
  const perRecord = 0.0000001;
  const count = 1000;
  let usdTotal: number | null = null;
  for (let index = 0; index < count; index += 1) usdTotal = addUsd(usdTotal, perRecord);
  const correct = toCNY(usdTotal as number, 7.2);

  let wrong = 0;
  for (let index = 0; index < count; index += 1) wrong += toCNY(perRecord, 7.2) as number;

  assert.equal(correct, 0.00072, "先合计再换算");
  assert.notEqual(wrong, correct, "逐条换算会产生不同的结果（本用例证明 M-4 不是等价改写）");
});

test("M-1（¥2）：换算不产生任何账本写入（纯函数，无副作用）", () => {
  const input = { known: 0.1, estimated: 0.2 };
  const frozen = Object.freeze({ ...input });
  const output = convertMoneyTotals(frozen, 7.2);
  assert.deepEqual(frozen, { known: 0.1, estimated: 0.2 });
  assert.deepEqual(output, { known: 0.72, estimated: 1.44 });
});

test("¥3：汇率必须由调用方传入（本模块没有默认汇率常量）", () => {
  assert.equal(toCNY(1, 1), 1);
  assert.equal(toCNY(1, 100), 100);
});
