/**
 * cost.ts — 成本兜底与估算（纯函数，无 IO）。
 * 需求：4.6.1（$1~$6）、C-4、AC-8.5.2、13 章（成本为负按 null 处理）
 *
 * 定价单位约定：`ModelPricing` 的四分量均为 **USD / 1M tokens**（与
 * `~/.pi/agent/models.json` 的 `cost` 字段以及 pi 内部计费一致）。
 */

export interface ModelPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface TokenComponents {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface CostInput {
  /** $1：`usage.cost.total`（已校验为有限数；负值由本函数按 $5 处理）。 */
  usageCostTotal: number | null;
  tokens: TokenComponents;
  /** $2：模型定价；未知时为 null（$3）。 */
  pricing: ModelPricing | null;
}

export interface CostResult {
  /** $1：真实成本（美元）。 */
  costUsd: number | null;
  /** $2：估算成本（美元）。 */
  costUsdEst: number | null;
  /** $5：负成本视为损坏。 */
  corruptCost: boolean;
}

/** $2：按四分量 × 定价（USD/1M）计算估算成本。 */
export function estimateCostUsd(tokens: TokenComponents, pricing: ModelPricing | null): number | null {
  if (pricing === null) return null;
  const usd =
    (tokens.input * pricing.input +
      tokens.output * pricing.output +
      tokens.cacheRead * pricing.cacheRead +
      tokens.cacheWrite * pricing.cacheWrite) /
    1_000_000;
  if (!Number.isFinite(usd) || usd < 0) return null;
  return Math.round(usd * 1e9) / 1e9;
}

/**
 * $1~$5 + C-4：判定真实成本与估算成本。
 *  - $4：两个数字绝不合并。
 *  - C-4：真实成本缺失或为 0 且定价已知时才估算。
 */
export function computeRecordCost(input: CostInput): CostResult {
  let corruptCost = false;
  let costUsd: number | null = null;

  if (input.usageCostTotal !== null) {
    if (!Number.isFinite(input.usageCostTotal) || input.usageCostTotal < 0) {
      // $5：成本不得为负；负值视为损坏并按 null 处理。
      corruptCost = true;
      costUsd = null;
    } else {
      costUsd = input.usageCostTotal;
    }
  }

  const needsEstimate = costUsd === null || costUsd === 0;
  const estimated = needsEstimate ? estimateCostUsd(input.tokens, input.pricing) : null;

  // C-4：估算值必须计数 costUsdEst，绝不与真实成本混算。
  return {
    costUsd,
    costUsdEst: needsEstimate ? estimated : null,
    corruptCost,
  };
}
