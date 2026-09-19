/**
 * pricing.ts — 模型定价表加载（IO，仅 node:fs）。
 * 需求：$2（模型定价来源：`ctx.modelRegistry` 或 `~/.pi/agent/models.json` 的 `cost`）、$3
 *
 * 本模块不 import 任何宿主包（11 章依赖方向：`src/**` 禁止 import `@earendil-works/*`）。
 * 宿主侧可以把 `ctx.modelRegistry` 中的定价通过 `addPricing()` 注入进来。
 */

import fs from "node:fs";
import type { ModelPricing } from "./cost.ts";

export type PricingTable = Map<string, ModelPricing>;

export function emptyPricingTable(): PricingTable {
  return new Map<string, ModelPricing>();
}

function normalizePricing(value: unknown): ModelPricing | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const parts: Array<[keyof ModelPricing, unknown]> = [
    ["input", raw["input"]],
    ["output", raw["output"]],
    ["cacheRead", raw["cacheRead"]],
    ["cacheWrite", raw["cacheWrite"]],
  ];
  const out: ModelPricing = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const [key, rawValue] of parts) {
    if (rawValue === undefined || rawValue === null) continue;
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue) || rawValue < 0) return null;
    out[key] = rawValue;
  }
  return out;
}

/** 注册一条定价；同时登记 `provider/model` 与裸 `model` 两个键。 */
export function addPricing(table: PricingTable, provider: string | null, modelId: string, pricing: ModelPricing): void {
  if (provider && provider.length > 0) table.set(`${provider}/${modelId}`, pricing);
  if (!table.has(modelId)) table.set(modelId, pricing);
}

/** $2：优先 `provider/model`，回退裸 `model`。 */
export function lookupPricing(table: PricingTable, provider: string | null, model: string | null): ModelPricing | null {
  if (table.size === 0 || model === null || model.length === 0) return null;
  if (provider !== null && provider.length > 0) {
    const qualified = table.get(`${provider}/${model}`);
    if (qualified) return qualified;
  }
  return table.get(model) ?? null;
}

export interface LoadedPricing {
  table: PricingTable;
  warnings: string[];
  source: string | null;
}

/** 读取 `~/.pi/agent/models.json` 的 `providers.*.models[].cost`（$2）。 */
export function loadPricingTable(modelsJsonPath: string): LoadedPricing {
  const table = emptyPricingTable();
  const warnings: string[] = [];
  let source: string | null = null;

  let text: string;
  try {
    text = fs.readFileSync(modelsJsonPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`models.json: 读取失败（${(error as Error).message}）`);
    }
    return { table, warnings, source };
  }

  try {
    const parsed: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { table, warnings: ["models.json: 根节点不是对象"], source: null };
    }
    const providers = (parsed as Record<string, unknown>)["providers"];
    if (providers === null || typeof providers !== "object" || Array.isArray(providers)) {
      return { table, warnings: ["models.json: 缺少 providers 对象"], source: null };
    }
    source = modelsJsonPath;
    for (const [providerId, providerValue] of Object.entries(providers as Record<string, unknown>)) {
      if (providerValue === null || typeof providerValue !== "object" || Array.isArray(providerValue)) continue;
      const models = (providerValue as Record<string, unknown>)["models"];
      if (!Array.isArray(models)) continue;
      for (const modelValue of models) {
        if (modelValue === null || typeof modelValue !== "object" || Array.isArray(modelValue)) continue;
        const record = modelValue as Record<string, unknown>;
        const id = record["id"];
        if (typeof id !== "string" || id.length === 0) continue;
        const pricing = normalizePricing(record["cost"]);
        if (pricing === null) continue;
        addPricing(table, providerId, id, pricing);
      }
    }
  } catch (error) {
    warnings.push(`models.json: 解析失败（${(error as Error).message}）`);
  }

  return { table, warnings, source };
}
