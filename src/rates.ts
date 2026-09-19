/**
 * rates.ts — 联网获取 USD→CNY 汇率（FR-11 / ¥8 的自动汇率通道）。
 * 需求：¥2（展示层换算）、¥8（自动汇率可关闭）、NFR-7（出站目标白名单）、NFR-5（错误不上抛）
 *
 * 约束：
 *  - 本模块是**唯一**允许出现非回环出站目标的文件（质量门 tools/quality-gate.mjs 强制）。
 *  - 是否发起请求一律由调用方根据 `currency.autoRate` 决定；本模块自身不做任何开关判断，
 *    也不缓存结果（缓存与落盘由 dashboard/api.ts 负责）。
 *  - 任何失败都降级为 `quote: null` + `attempts[]`，绝不抛异常（NFR-5）。
 */

import { isRate, normalizeRate } from "./config.ts";

/** 自动汇率的重取间隔：12 小时（¥8：不是每次刷新都联网）。 */
export const AUTO_RATE_TTL_MS = 12 * 60 * 60 * 1000;

/** 单个汇率接口的超时（毫秒）。 */
export const RATE_TIMEOUT_MS = 6000;

/** 可注入的 fetch（测试注入 stub，运行期用全局 fetch）。 */
export type RateFetcher = typeof fetch;

export interface RateProvider {
  /** 提供方名称（写入配置的 `currency.rateSource` 之外的诊断信息，也用于失败提示）。 */
  name: string;
  url: string;
}

/**
 * 汇率提供方（按顺序尝试，首个成功者胜）。三者都返回 `{ rates: { CNY: number } }`：
 *  1. open.er-api.com  —— 免费、无需 key、每日更新；
 *  2. api.frankfurter.dev —— 欧洲央行参考汇率（无 CNY 时不受影响，工作日更新）；
 *  3. api.exchangerate-api.com/v4 —— 兜底。
 */
export const RATE_PROVIDERS: readonly RateProvider[] = [
  { name: "open.er-api.com", url: "https://open.er-api.com/v6/latest/USD" },
  { name: "api.frankfurter.dev", url: "https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY" },
  { name: "api.exchangerate-api.com", url: "https://api.exchangerate-api.com/v4/latest/USD" },
];

export interface RateQuote {
  /** USD→CNY，恒为 2 位小数（¥3）。 */
  rate: number;
  /** 提供方名称。 */
  provider: string;
  /** 提供方给出的数据日期（ISO 或原始字符串），缺失为 null。 */
  asOf: string | null;
}

export interface RateAttempt {
  provider: string;
  ok: boolean;
  /** 失败原因（单行、不含正文）。 */
  reason?: string;
}

export interface RateFetchResult {
  quote: RateQuote | null;
  attempts: RateAttempt[];
  /** 本次尝试时间（ISO）。 */
  fetchedAt: string;
}

/**
 * 从汇率响应体里取出 USD→CNY（纯函数）。
 * 兼容 `{rates:{CNY}}` 与 `{conversion_rates:{CNY}}` 两种形状；
 * 非有限数 / 超出 0.01..100 / 缺失一律返回 null（¥3）。
 */
export function pickCnyRate(payload: unknown): { rate: number; asOf: string | null } | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const rates = record["rates"] ?? record["conversion_rates"];
  if (rates === null || typeof rates !== "object" || Array.isArray(rates)) return null;
  const raw = (rates as Record<string, unknown>)["CNY"];
  if (typeof raw !== "number" || !isRate(raw)) return null;
  return { rate: normalizeRate(raw), asOf: pickAsOf(record) };
}

function pickAsOf(record: Record<string, unknown>): string | null {
  const date = record["date"];
  if (typeof date === "string" && date.length > 0) return date;
  const utc = record["time_last_update_utc"];
  if (typeof utc === "string" && utc.length > 0) return utc;
  const unix = record["time_last_updated"];
  if (typeof unix === "number" && Number.isFinite(unix) && unix > 0) {
    return new Date(unix * 1000).toISOString();
  }
  return null;
}

export interface FetchRateOptions {
  fetcher?: RateFetcher;
  timeoutMs?: number;
  /** 注入当前时间（测试用）。 */
  now?: () => number;
  providers?: readonly RateProvider[];
}

/** 按顺序尝试各提供方，返回首个成功的报价；全部失败时 `quote === null`。 */
export async function fetchUsdCnyRate(options: FetchRateOptions = {}): Promise<RateFetchResult> {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? RATE_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const providers = options.providers ?? RATE_PROVIDERS;
  const attempts: RateAttempt[] = [];

  for (const provider of providers) {
    try {
      const response = await fetcher(provider.url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        attempts.push({ provider: provider.name, ok: false, reason: `HTTP ${response.status}` });
        continue;
      }
      const payload: unknown = await response.json();
      const picked = pickCnyRate(payload);
      if (picked === null) {
        attempts.push({ provider: provider.name, ok: false, reason: "响应中缺少可用的 CNY 汇率" });
        continue;
      }
      attempts.push({ provider: provider.name, ok: true });
      return {
        quote: { rate: picked.rate, provider: provider.name, asOf: picked.asOf },
        attempts,
        fetchedAt: new Date(now()).toISOString(),
      };
    } catch (error) {
      attempts.push({ provider: provider.name, ok: false, reason: reasonOf(error) });
    }
  }

  return { quote: null, attempts, fetchedAt: new Date(now()).toISOString() };
}

/** 单行失败原因（NFR-5 / FR-14.6：只允许名称与状态，不含响应正文）。 */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 120 ? `${message.slice(0, 120)}…` : message;
}

/** 是否已过期需要重取（`fetchedAt` 缺失 / 非法 / 超过 TTL 都视为过期）。 */
export function isRateStale(fetchedAt: string | null, nowMs: number, ttlMs = AUTO_RATE_TTL_MS): boolean {
  if (fetchedAt === null || fetchedAt.length === 0) return true;
  const parsed = Date.parse(fetchedAt);
  if (!Number.isFinite(parsed)) return true;
  return nowMs - parsed >= ttlMs;
}
