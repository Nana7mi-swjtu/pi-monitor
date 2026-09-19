/**
 * cost.test.ts — 4.6.1（$1~$6）、C-4、AC-8.5.2、13 章（负成本）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { computeRecordCost, estimateCostUsd, type ModelPricing } from "../../src/cost.ts";
import { lookupPricing, addPricing, emptyPricingTable } from "../../src/pricing.ts";

const PRICING: ModelPricing = { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 };

test("$1：优先使用 usage.cost.total（真实成本），不产生估算", () => {
  const result = computeRecordCost({
    usageCostTotal: 0.000217578,
    tokens: { input: 223, output: 280, cacheRead: 5376, cacheWrite: 0 },
    pricing: PRICING,
  });
  assert.equal(result.costUsd, 0.000217578);
  assert.equal(result.costUsdEst, null, "$4：真实成本与估算成本绝不合并");
  assert.equal(result.corruptCost, false);
});

test("$2 / C-4：成本缺失或为 0 且定价已知时估算（USD / 1M tokens）", () => {
  const tokens = { input: 223, output: 280, cacheRead: 5376, cacheWrite: 0 };
  const expected = (223 * 0.15 + 280 * 0.6 + 5376 * 0.003) / 1_000_000;
  const missing = computeRecordCost({ usageCostTotal: null, tokens, pricing: PRICING });
  assert.equal(missing.costUsd, null);
  assert.ok(Math.abs((missing.costUsdEst as number) - expected) < 1e-12);

  const zero = computeRecordCost({ usageCostTotal: 0, tokens, pricing: PRICING });
  assert.equal(zero.costUsd, 0);
  assert.ok(zero.costUsdEst !== null, "0 成本的记录也应估算");
});

test("$3：定价未知时两个字段均为 null（展示为 —）", () => {
  const result = computeRecordCost({
    usageCostTotal: null,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    pricing: null,
  });
  assert.equal(result.costUsd, null);
  assert.equal(result.costUsdEst, null);
});

test("$5：负成本视为损坏，按 null 处理并标记 corruptCost", () => {
  const result = computeRecordCost({
    usageCostTotal: -1,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    pricing: null,
  });
  assert.equal(result.corruptCost, true);
  assert.equal(result.costUsd, null);
});

test("$5：非有限成本同样视为损坏", () => {
  const result = computeRecordCost({
    usageCostTotal: Number.POSITIVE_INFINITY,
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    pricing: null,
  });
  assert.equal(result.corruptCost, true);
  assert.equal(result.costUsd, null);
});

test("$4：真实成本存在时不产生估算值（即使定价为非零）", () => {
  const result = computeRecordCost({
    usageCostTotal: 5,
    tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    pricing: PRICING,
  });
  assert.equal(result.costUsd, 5);
  assert.equal(result.costUsdEst, null);
});

test("estimateCostUsd：四分量线性组合，单位 USD / 1M", () => {
  assert.equal(estimateCostUsd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, PRICING), 0.15);
  assert.equal(estimateCostUsd({ input: 0, output: 1_000_000, cacheRead: 0, cacheWrite: 0 }, PRICING), 0.6);
  assert.equal(estimateCostUsd({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, null), null);
});

test("$2：定价表按 provider/model 优先，回退裸 model 名", () => {
  const table = emptyPricingTable();
  addPricing(table, "acme", "acme-1", PRICING);
  assert.equal(lookupPricing(table, "acme", "acme-1"), PRICING);
  assert.equal(lookupPricing(table, null, "acme-1"), PRICING, "裸模型名回退");
  assert.equal(lookupPricing(table, "acme", "unknown"), null);
  assert.equal(lookupPricing(table, "other", "unknown"), null);
});
