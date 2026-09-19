/**
 * rates.test.ts — ¥8（联网自动汇率）与 NFR-7（出站目标白名单）。
 *
 * 全部用例都用注入的 fetcher，不做任何真实网络请求。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_RATE_TTL_MS,
  RATE_PROVIDERS,
  fetchUsdCnyRate,
  isRateStale,
  pickCnyRate,
  type RateFetcher,
} from "../../src/rates.ts";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/** 记录调用并按 URL 返回预设响应的 fetcher。 */
function stubFetcher(routes: Record<string, () => Response | Promise<Response>>): {
  fetcher: RateFetcher;
  calls: string[];
} {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : String(input);
    calls.push(url);
    assert.ok(init?.signal, "必须带超时 signal");
    const handler = routes[url];
    if (handler === undefined) throw new Error(`未预设的 URL：${url}`);
    return handler();
  }) as RateFetcher;
  return { fetcher, calls };
}

test("¥8：pickCnyRate 兼容三种响应形状并做范围校验", () => {
  assert.deepEqual(pickCnyRate({ rates: { CNY: 6.7 } }), { rate: 6.7, asOf: null });
  assert.deepEqual(pickCnyRate({ rates: { CNY: 6.7123 }, date: "2026-09-19" }), {
    rate: 6.71,
    asOf: "2026-09-19",
  });
  assert.deepEqual(pickCnyRate({ conversion_rates: { CNY: 7.005 } }), { rate: 7.01, asOf: null });
  assert.deepEqual(
    pickCnyRate({ rates: { CNY: 6.7 }, time_last_updated: 1_789_776_001 }),
    { rate: 6.7, asOf: new Date(1_789_776_001_000).toISOString() },
  );
  assert.deepEqual(pickCnyRate({ rates: { CNY: 6.7 }, time_last_update_utc: "Sat, 19 Sep 2026 00:02:31 +0000" }), {
    rate: 6.7,
    asOf: "Sat, 19 Sep 2026 00:02:31 +0000",
  });

  for (const bad of [
    null,
    undefined,
    42,
    "6.7",
    [],
    {},
    { rates: {} },
    { rates: { CNY: "6.7" } },
    { rates: { CNY: Number.NaN } },
    { rates: { CNY: Number.POSITIVE_INFINITY } },
    { rates: { CNY: 0 } },
    { rates: { CNY: 0.001 } },
    { rates: { CNY: 200 } },
    { rates: [] },
  ]) {
    assert.equal(pickCnyRate(bad), null, `${JSON.stringify(bad)} 必须被拒绝`);
  }
});

test("¥8：isRateStale 按 12 小时 TTL 判定（缺失/非法时间视为过期）", () => {
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  assert.equal(isRateStale(null, now), true, "从未获取过 → 过期");
  assert.equal(isRateStale("", now), true);
  assert.equal(isRateStale("not-a-date", now), true);
  assert.equal(isRateStale(new Date(now - AUTO_RATE_TTL_MS + 1000).toISOString(), now), false, "未到 TTL");
  assert.equal(isRateStale(new Date(now - AUTO_RATE_TTL_MS).toISOString(), now), true, "恰好到 TTL → 过期");
  assert.equal(isRateStale(new Date(now - AUTO_RATE_TTL_MS - 1).toISOString(), now), true);
});

test("¥8：首选提供方成功后不再请求后续提供方", async () => {
  const { fetcher, calls } = stubFetcher({
    [RATE_PROVIDERS[0]!.url]: () => jsonResponse({ rates: { CNY: 6.7012 }, date: "2026-09-19" }),
    [RATE_PROVIDERS[1]!.url]: () => jsonResponse({ rates: { CNY: 1 } }),
  });
  const result = await fetchUsdCnyRate({ fetcher, now: () => Date.parse("2026-09-19T12:00:00.000Z") });
  assert.equal(result.quote?.rate, 6.7);
  assert.equal(result.quote?.provider, RATE_PROVIDERS[0]!.name);
  assert.equal(result.quote?.asOf, "2026-09-19");
  assert.equal(result.fetchedAt, "2026-09-19T12:00:00.000Z");
  assert.equal(calls.length, 1, "只允许请求 1 个提供方");
  assert.deepEqual(result.attempts, [{ provider: RATE_PROVIDERS[0]!.name, ok: true }]);
});

test("¥8：提供方失败/响应不可用时按顺序回退，且记录失败原因", async () => {
  const { fetcher, calls } = stubFetcher({
    [RATE_PROVIDERS[0]!.url]: () => jsonResponse({ error: "busy" }, 503),
    [RATE_PROVIDERS[1]!.url]: () => jsonResponse({ rates: { CNY: "oops" } }),
    [RATE_PROVIDERS[2]!.url]: () => jsonResponse({ rates: { CNY: 6.9 } }),
  });
  const result = await fetchUsdCnyRate({ fetcher });
  assert.equal(result.quote?.rate, 6.9);
  assert.equal(result.quote?.provider, RATE_PROVIDERS[2]!.name);
  assert.equal(calls.length, 3);
  assert.deepEqual(result.attempts, [
    { provider: RATE_PROVIDERS[0]!.name, ok: false, reason: "HTTP 503" },
    { provider: RATE_PROVIDERS[1]!.name, ok: false, reason: "响应中缺少可用的 CNY 汇率" },
    { provider: RATE_PROVIDERS[2]!.name, ok: true },
  ]);
});

test("¥8 / NFR-5：网络异常/全部失败时返回 null 且绝不抛异常", async () => {
  const failing = (async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  }) as RateFetcher;
  const result = await fetchUsdCnyRate({ fetcher: failing });
  assert.equal(result.quote, null);
  assert.equal(result.attempts.length, RATE_PROVIDERS.length);
  assert.ok(result.attempts.every((attempt) => attempt.ok === false));
  assert.ok(result.attempts.every((attempt) => (attempt.reason ?? "").includes("ENOTFOUND")));
  assert.equal(typeof result.fetchedAt, "string");
});

test("NFR-7：出站目标只有 3 个固定的汇率接口，且都是 https", () => {
  assert.equal(RATE_PROVIDERS.length, 3);
  for (const provider of RATE_PROVIDERS) {
    assert.match(provider.url, /^https:\/\/[a-z0-9.-]+\//, provider.url);
    assert.equal(provider.name.length > 0, true);
  }
  const hosts = RATE_PROVIDERS.map((provider) => new URL(provider.url).host);
  assert.deepEqual([...new Set(hosts)].length, hosts.length, "提供方必须互不相同");
});
