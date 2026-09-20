/**
 * server.test.ts — FR-6（AC-6.1/6.2/6.4）、10.2（HTTP API 契约）、10.3（安全响应头）、
 * FR-11（AC-11.2/AC-11.5）、FR-12（AC-12.4/AC-12.5）、FR-14（AC-14.4）、AC-8.6。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";

import { WRITABLE_CONFIG_PATHS, loadConfigFromRaw } from "../../src/config.ts";
import { buildConfigResponse, refreshAutoRate, type MonitorContext } from "../../src/dashboard/api.ts";
import { DashboardServer } from "../../src/dashboard/server.ts";
import { createNullLogger } from "../../src/health.ts";
import { MonitorEngine } from "../../src/scanner.ts";
import { assistantEntry, cleanup, makeTempAgentDir, writeSessionFile } from "../helpers.ts";

/**
 * 时间基准：AC-8.7（最近一年网格）与 FR-10.6（当日预算）断言的是「今天」，
 * 因此会话数据必须写在当前 UTC 日（harness 的 timezone 固定为 utc）。
 * 之前这里写死 `2026-09-19`：机器日期一旦跨过该日，窗口 `today` 就变空，
 * 这些断言会持续失败（并非被测逻辑回归）。
 */
const RUN_AT = Date.now();
const DAY_MS = 86_400_000;
const TODAY = new Date(RUN_AT).toISOString().slice(0, 10);
const YEAR = Number(TODAY.slice(0, 4));
const EMPTY_YEAR = YEAR - 10;

/** 当前 UTC 日内的一个时间戳（不早于当日 00:00:01Z，保证不落到前一天）。 */
function todayAt(msBefore: number): string {
  return new Date(Math.max(RUN_AT - msBefore, Date.parse(`${TODAY}T00:00:01Z`))).toISOString();
}

function addDays(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** 周一为周起始时，`day` 所在周的周一 / 周日。 */
const mondayOf = (day: string): string => addDays(day, -((weekdayOf(day) + 6) % 7));
const sundayOf = (day: string): string => addDays(day, (7 - weekdayOf(day)) % 7);

const GRID_END_DAY = sundayOf(TODAY);
const GRID_START_DAY = addDays(GRID_END_DAY, -(53 * 7 - 1));
const YEAR_FROM_DAY = `${YEAR}-01-01`;
const YEAR_TO_DAY = `${YEAR}-12-31`;
const YEAR_START_DAY = mondayOf(YEAR_FROM_DAY);
const YEAR_WEEKS = Math.floor((Date.parse(`${sundayOf(YEAR_TO_DAY)}T00:00:00Z`) - Date.parse(`${YEAR_START_DAY}T00:00:00Z`)) / DAY_MS / 7) + 1;

interface Harness {
  agentDir: string;
  engine: MonitorEngine;
  context: MonitorContext;
  server: DashboardServer;
  token: string;
  base: string;
  stop: () => Promise<void>;
}

async function startHarness(options: { port?: number; portRange?: number } = {}): Promise<Harness> {
  const agentDir = makeTempAgentDir();
  const dir = path.join(agentDir, "sessions", "--proj--");
  fs.mkdirSync(dir, { recursive: true });
  writeSessionFile(dir, "a.jsonl", [
    assistantEntry({ id: "a1", iso: todayAt(0), input: 100, output: 50, cacheRead: 1000, costTotal: 0.000048 }),
    assistantEntry({ id: "a2", iso: todayAt(5 * 60_000), input: 10, output: 10, costTotal: 0.00002 }),
  ]);

  const loaded = loadConfigFromRaw({ timezone: "utc", locale: "zh-CN" });
  const engine = new MonitorEngine({ agentDir, config: loaded.config, logger: createNullLogger(), env: {} });
  engine.load();
  await engine.scan({});

  const context: MonitorContext = {
    engine,
    loaded,
    configPath: path.join(agentDir, "pi-monitor", "config.json"),
    logPath: null,
    locale: "zh-CN",
    readOnly: false,
    lockTimeout: false,
    sessionId: null,
  };

  const server = new DashboardServer({
    port: options.port ?? 0,
    portRange: options.portRange ?? 0,
    allowLan: false,
    locale: "zh-CN",
    context: () => context,
  });
  const info = await server.start();
  return {
    agentDir,
    engine,
    context,
    server,
    token: info.token,
    base: `http://127.0.0.1:${info.port}`,
    stop: async () => {
      await server.stop();
      cleanup(agentDir);
    },
  };
}

function authed(harness: Harness, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { "X-Pi-Monitor-Token": harness.token, ...(init.headers ?? {}) },
  };
}

test("AC-6.1：GET /api/health 返回 200 且 status=ok", async () => {
  const harness = await startHarness();
  try {
    const res = await fetch(`${harness.base}/api/health`, authed(harness));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body["status"], "ok");
    assert.equal(body["revision"], harness.engine.meta.revision);
    assert.equal(body["records"], 2);
    assert.equal(body["scanning"], false);
    assert.equal(body["pid"], process.pid);
    assert.equal(typeof body["startedAt"], "string");
  } finally {
    await harness.stop();
  }
});

test("AC-14.4 / 10.3：无 token 或错误 token 访问 / 与任意 /api/* 均返回 401；安全响应头齐全", async () => {
  const harness = await startHarness();
  try {
    for (const target of ["/", "/api/health", "/api/summary", "/api/config", "/api/records"]) {
      const anonymous = await fetch(`${harness.base}${target}`);
      assert.equal(anonymous.status, 401, `${target} 无 token`);
      const wrong = await fetch(`${harness.base}${target}?t=${"0".repeat(32)}`);
      assert.equal(wrong.status, 401, `${target} 错误 token`);
    }

    const page = await fetch(`${harness.base}/?t=${harness.token}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    const csp = page.headers.get("content-security-policy") ?? "";
    assert.ok(csp.includes("default-src 'none'"));
    assert.ok(csp.includes("connect-src 'self'"));
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.equal(page.headers.get("referrer-policy"), "no-referrer");
    const html = await page.text();
    assert.ok(html.includes("pi-monitor"));
    assert.equal(/https?:\/\/(?!127\.0\.0\.1|localhost|::1)/.test(html), false, "NFR-7：页面不得含外部目标");
  } finally {
    await harness.stop();
  }
});

test("AC-14.3：健康面板不暴露完整 token（只有前 4 位掩码）", async () => {
  const harness = await startHarness();
  try {
    const mask = harness.server.tokenMask;
    assert.equal(mask.slice(0, 4), harness.token.slice(0, 4));
    assert.equal(mask.includes(harness.token), false);
    const res = await fetch(`${harness.base}/api/health`, authed(harness));
    const text = await res.text();
    assert.equal(text.includes(harness.token), false);
  } finally {
    await harness.stop();
  }
});

test("10.2：全部数据端点可用且结构符合 7.5", async () => {
  const harness = await startHarness();
  try {
    const summary = (await (await fetch(`${harness.base}/api/summary?window=all`, authed(harness))).json()) as Record<string, any>;
    assert.equal(summary["schemaVersion"], 1);
    assert.equal(summary["currency"]["code"], "CNY");
    assert.equal(summary["currency"]["symbol"], "¥");
    assert.equal(summary["currency"]["rateSource"], "manual");
    assert.equal(summary["totals"]["tokens"]["billed"], 1170, "1150 + 20");
    assert.equal(summary["window"]["tz"], "UTC");
    assert.equal(summary["totals"]["cost"]["cny"]["known"], 0.00049, "M-2：0.000068 × 7.2 = 0.0004896 → 0.00049");
    assert.equal("live" in summary, false, "FR-4 已删除：summary 不得再带 live");
    assert.ok(summary["health"], "summary 必须带 health");
    assert.ok(summary["comparison"], "8.3 环比");

    const daily = (await (await fetch(`${harness.base}/api/daily?window=all&metric=tokens`, authed(harness))).json()) as Record<string, any>;
    assert.equal(daily["daily"].length, 1);
    assert.equal(daily["daily"][0]["day"], TODAY);
    assert.ok(Array.isArray(daily["buckets"]["legend"]));
    assert.equal(daily["buckets"]["metric"], "tokens");

    // 8.4 / AC-8.7 / AC-8.8：网格区间由服务端给出，且恒按周对齐。
    const grid = daily["grid"] as Record<string, any>;
    assert.equal(grid["mode"], "recent");
    assert.equal(grid["year"], null);
    assert.equal(grid["weeks"], 53);
    assert.equal(grid["weekStart"], "monday");
    assert.equal(grid["endDay"], GRID_END_DAY, "末列必须是数据末日所在周的周日");
    assert.equal(grid["startDay"], GRID_START_DAY, "首列必须是 53 周前的周一");
    const gridDays = (Date.parse(grid["endDay"] + "T00:00:00Z") - Date.parse(grid["startDay"] + "T00:00:00Z")) / 86400000 + 1;
    assert.equal(gridDays, grid["weeks"] * 7, "网格天数必须等于 周数 × 7");
    // 回归（用户报告：“最近一年”只显示 1 个格子）：recent 模式的统计范围必须就是整个网格，
    // 否则除锚点日以外的 370 个格子会被当成补齐格而不着色。
    assert.equal(grid["fromDay"], grid["startDay"], "recent：统计范围首日 = 网格首日");
    assert.equal(grid["toDay"], grid["endDay"], "recent：统计范围末日 = 网格末日");
    assert.ok(daily["daily"].length > 0);
    for (const row of daily["daily"] as Array<Record<string, unknown>>) {
      assert.ok(
        (row["day"] as string) >= grid["startDay"] && (row["day"] as string) <= grid["endDay"],
        `有数据的日 ${row["day"]} 必须落在网格内`,
      );
    }
    for (const boundary of [grid["startDay"], grid["endDay"]]) {
      const weekday = new Date(boundary + "T00:00:00Z").getUTCDay();
      assert.ok(weekday === 1 || weekday === 0, "边界必须落在周一/周日");
    }

    // AC-8.8：year 参数按自然年取范围并重新分桶；补齐格由 fromDay/toDay 标出。
    const yearDaily = (await (await fetch(`${harness.base}/api/daily?year=${YEAR}&metric=tokens`, authed(harness))).json()) as Record<string, any>;
    assert.equal(yearDaily["grid"]["mode"], "year");
    assert.equal(yearDaily["grid"]["year"], YEAR);
    assert.equal(yearDaily["grid"]["fromDay"], YEAR_FROM_DAY);
    assert.equal(yearDaily["grid"]["toDay"], YEAR_TO_DAY);
    assert.equal(yearDaily["grid"]["startDay"], YEAR_START_DAY, `${YEAR_FROM_DAY} 所在周的周一`);
    assert.equal(yearDaily["grid"]["weeks"], YEAR_WEEKS);
    assert.equal(yearDaily["daily"].length, 1);
    assert.equal(yearDaily["daily"][0]["day"], TODAY, "会话数据落在当前自然年");

    const emptyYear = (await (await fetch(`${harness.base}/api/daily?year=${EMPTY_YEAR}&metric=tokens`, authed(harness))).json()) as Record<string, any>;
    assert.equal(emptyYear["grid"]["year"], EMPTY_YEAR);
    assert.equal(emptyYear["daily"].length, 0, "无数据的年份必须为空而非报错");

    // 10.2：非法 year 等同未提供，回退到 window 解析。
    for (const bad of ["abcd", "12026", "1900", "99999", ""]) {
      const fallback = (await (await fetch(`${harness.base}/api/daily?year=${bad}&window=all&metric=tokens`, authed(harness))).json()) as Record<string, any>;
      assert.equal(fallback["grid"]["mode"], "recent", `year=${JSON.stringify(bad)} 应回退`);
      assert.equal(fallback["grid"]["year"], null);
    }

    const breakdown = (await (await fetch(`${harness.base}/api/breakdown?window=all&dim=kind&limit=20`, authed(harness))).json()) as Record<string, any>;
    const shareSum = breakdown["groups"].reduce((sum: number, group: Record<string, number>) => sum + group["share"], 0);
    assert.ok(Math.abs(shareSum - 1) < 1e-9, "AC-8.3：占比之和为 100%");

    const records = (await (await fetch(`${harness.base}/api/records?window=all&limit=100`, authed(harness))).json()) as Record<string, any>;
    assert.equal(records["total"], 2);
    assert.equal(records["records"].length, 2);
    assert.equal(records["nextCursor"], null);

    const pages = (await (await fetch(`${harness.base}/api/records?window=all&limit=1`, authed(harness))).json()) as Record<string, any>;
    assert.equal(pages["records"].length, 1);
    assert.equal(pages["nextCursor"], "1");

    const exported = (await (await fetch(`${harness.base}/api/export?window=all&format=json`, authed(harness))).json()) as Record<string, any>;
    assert.ok(exported["groups"].length > 0);
    assert.ok(exported["daily"].length > 0);

    const dedupe = (await (await fetch(`${harness.base}/api/dedupe`, authed(harness))).json()) as Record<string, any>;
    assert.equal(dedupe["total"], 0);
    assert.deepEqual(dedupe["items"], []);

    const config = (await (await fetch(`${harness.base}/api/config`, authed(harness))).json()) as Record<string, any>;
    assert.equal(config["locale"], "zh-CN");
    assert.equal(config["currency"]["rate"], 7.2);
    assert.equal(config["timezone"], "UTC");
    assert.equal(config["readOnly"], false);
  } finally {
    await harness.stop();
  }
});

test("AC-8.6：ETag / If-None-Match 命中返回 304", async () => {
  const harness = await startHarness();
  try {
    const first = await fetch(`${harness.base}/api/summary?window=all`, authed(harness));
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.ok(etag, "数据端点必须带 ETag");
    await first.json();

    const second = await fetch(`${harness.base}/api/summary?window=all`, authed(harness, { headers: { "If-None-Match": etag } }));
    assert.equal(second.status, 304);
    assert.equal((await second.text()).length, 0);

    // 不同查询参数不应命中同一 ETag。
    const other = await fetch(`${harness.base}/api/summary?window=today`, authed(harness, { headers: { "If-None-Match": etag } }));
    assert.equal(other.status, 200);
  } finally {
    await harness.stop();
  }
});

test("AC-11.2 / ¥5：仪表盘修改汇率后金额立即变化，账本 revision 不变", async () => {
  const harness = await startHarness();
  try {
    const before = (await (await fetch(`${harness.base}/api/summary?window=all`, authed(harness))).json()) as Record<string, any>;
    const revisionBefore = harness.engine.meta.revision;

    const put = await fetch(
      `${harness.base}/api/config`,
      authed(harness, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: { rate: 5 } }),
      }),
    );
    assert.equal(put.status, 200);
    assert.equal((await put.json() as Record<string, unknown>)["ok"], true);

    const after = (await (await fetch(`${harness.base}/api/summary?window=all`, authed(harness))).json()) as Record<string, any>;
    assert.equal(after["currency"]["rate"], 5);
    assert.equal(after["totals"]["cost"]["usd"]["known"], before["totals"]["cost"]["usd"]["known"], "美元值不变");
    assert.equal(after["totals"]["cost"]["cny"]["known"], 0.00034, "0.000068 × 5");
    assert.equal(harness.engine.meta.revision, revisionBefore, "¥5：汇率变更不改变账本 revision");
    assert.equal(fs.existsSync(harness.context.configPath), true, "FR-11.5：写入必须落盘");
  } finally {
    await harness.stop();
  }
});

test("AC-11.5：PUT 非白名单键返回 403 且不写盘", async () => {
  const harness = await startHarness();
  try {
    const res = await fetch(
      `${harness.base}/api/config`,
      authed(harness, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: "UTC" }),
      }),
    );
    assert.equal(res.status, 403);
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(body["rejected"], ["timezone"]);
    assert.equal(fs.existsSync(harness.context.configPath), false, "被拒绝的写入不得创建配置文件");
  } finally {
    await harness.stop();
  }
});

test("AC-12.4：POST /api/rebuild 缺少 confirm 返回 400 且不修改任何文件", async () => {
  const harness = await startHarness();
  try {
    const before = fs.readFileSync(harness.engine.paths.ledger, "utf8");
    const revisionBefore = harness.engine.meta.revision;

    const missing = await fetch(`${harness.base}/api/rebuild`, authed(harness, { method: "POST", body: "{}" }));
    assert.equal(missing.status, 400);

    const wrong = await fetch(
      `${harness.base}/api/rebuild`,
      authed(harness, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "nope" }) }),
    );
    assert.equal(wrong.status, 400);

    assert.equal(fs.readFileSync(harness.engine.paths.ledger, "utf8"), before);
    assert.equal(harness.engine.meta.revision, revisionBefore);

    // AC-12.5：带 confirm 时重建成功，revision 自增且数据刷新。
    const ok = await fetch(
      `${harness.base}/api/rebuild`,
      authed(harness, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirm: "REBUILD" }) }),
    );
    assert.equal(ok.status, 200);
    const body = (await ok.json()) as Record<string, unknown>;
    assert.equal(body["records"], 2);
    assert.ok((body["revision"] as number) > revisionBefore);
  } finally {
    await harness.stop();
  }
});

test("10.2：POST /api/rescan 返回 revision / scanned / durationMs", async () => {
  const harness = await startHarness();
  try {
    const res = await fetch(`${harness.base}/api/rescan`, authed(harness, { method: "POST" }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(typeof body["revision"], "number");
    assert.equal(typeof body["scanned"], "number");
    assert.equal(typeof body["durationMs"], "number");
    assert.equal(body["scanned"], 0, "无变化时不得重扫");
  } finally {
    await harness.stop();
  }
});

test("FR-6.2 / AC-6.2：二次 start 复用同一进程、端口与 token（幂等）", async () => {
  const harness = await startHarness();
  try {
    const first = harness.server.info;
    const second = await harness.server.start();
    assert.equal(second.port, first?.port);
    assert.equal(second.startedAt, first?.startedAt);
    assert.equal(second.token, first?.token);
    assert.equal(second.pid, first?.pid);
  } finally {
    await harness.stop();
  }
});

test("AC-6.4：首选端口被占用时顺延，全被占用时回退系统分配端口", async () => {
  // 先占用一个端口，再让 DashboardServer 以该端口为首选。
  const blocker = http.createServer((_req, res) => res.end("busy"));
  const blockedPort = await new Promise<number>((resolve) => {
    blocker.listen({ host: "127.0.0.1", port: 0 }, () => {
      resolve((blocker.address() as { port: number }).port);
    });
  });

  const harness = await startHarness({ port: blockedPort, portRange: 1 });
  try {
    assert.notEqual(harness.server.info?.port, blockedPort, "必须避开被占用的端口");
    const health = await fetch(`${harness.base}/api/health`, authed(harness));
    assert.equal(health.status, 200);
  } finally {
    await harness.stop();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("10.2：未知路由返回 404，错误方法返回 405", async () => {
  const harness = await startHarness();
  try {
    const notFound = await fetch(`${harness.base}/api/nope`, authed(harness));
    assert.equal(notFound.status, 404);

    const wrongMethod = await fetch(`${harness.base}/api/rescan`, authed(harness));
    assert.equal(wrongMethod.status, 405);

    const outside = await fetch(`${harness.base}/favicon.ico`, authed(harness));
    assert.equal(outside.status, 404);
  } finally {
    await harness.stop();
  }
});

test("FR-6.3 / AC-6.3：URL 必须携带 token（`/?t=<token>`）", async () => {
  const harness = await startHarness();
  try {
    const url = harness.server.info?.url ?? "";
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
    const res = await fetch(url);
    assert.equal(res.status, 200);
  } finally {
    await harness.stop();
  }
});

test("¥8：汇率来源在 /api/config 与 /api/summary 中可见，且只能写 currency.autoRate", async () => {
  const harness = await startHarness();
  try {
    const initial = (await (await fetch(`${harness.base}/api/config`, authed(harness))).json()) as Record<string, any>;
    assert.equal(initial["currency"]["autoRate"], true, "¥8：自动汇率默认开启");
    assert.equal(initial["currency"]["rateSource"], "manual");
    assert.equal(initial["currency"]["rateFetchedAt"], null);
    assert.ok(initial["writableKeys"].includes("currency.autoRate"));
    assert.ok(initial["writableKeys"].includes("dashboard.autoRefresh"));
    assert.equal(initial["writableKeys"].includes("currency.rateSource"), false, "来源与时间是插件维护的只读键");
    // 白名单必须与配置层完全一致（不得两处漂移）。
    assert.deepEqual([...initial["writableKeys"]].sort(), [...WRITABLE_CONFIG_PATHS].sort());

    const allowed = await fetch(
      `${harness.base}/api/config`,
      authed(harness, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: { autoRate: false } }),
      }),
    );
    assert.equal(allowed.status, 200);
    assert.equal(buildConfigResponse(harness.context).currency.autoRate, false);

    const denied = await fetch(
      `${harness.base}/api/config`,
      authed(harness, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: { rateSource: "auto" } }),
      }),
    );
    assert.equal(denied.status, 403);

    // ¥4 / ¥8：手动写入 rate 后，来源必须回到「手动设置」（否则页头会谎报为自动获取）。
    harness.context.rateFetcher = (async () =>
      new Response(JSON.stringify({ rates: { CNY: 6.7 } }), { status: 200 })) as typeof fetch;
    assert.equal((await refreshAutoRate(harness.context, { force: true })).rateSource, "auto");
    assert.equal(buildConfigResponse(harness.context).currency.rate, 6.7);

    const manual = await fetch(
      `${harness.base}/api/config`,
      authed(harness, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: { rate: 7 } }),
      }),
    );
    assert.equal(manual.status, 200);
    const afterManual = buildConfigResponse(harness.context);
    assert.equal(afterManual.currency.rate, 7);
    assert.equal(afterManual.currency.rateSource, "manual");
    assert.equal(afterManual.currency.rateFetchedAt, null);
    const written = JSON.parse(fs.readFileSync(harness.context.configPath, "utf8")) as Record<string, any>;
    assert.equal(written["currency"]["rate"], 7);
    assert.equal(written["currency"]["rateSource"], "manual");
    assert.equal(written["currency"]["autoRate"], false, "同一次 PUT 里的其他键也要保留");
  } finally {
    await harness.stop();
  }
});

test("¥8：POST /api/rate/refresh 取回汇率并立即应用于所有金额（¥5：revision 不变）", async () => {
  const harness = await startHarness();
  try {
    const before = (await (await fetch(`${harness.base}/api/summary?window=all`, authed(harness))).json()) as Record<string, any>;
    const revisionBefore = harness.engine.meta.revision;
    const calls: string[] = [];
    harness.context.rateFetcher = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ rates: { CNY: 6.7012 }, date: "2026-09-19" }), { status: 200 });
    }) as typeof fetch;

    const res = await fetch(`${harness.base}/api/rate/refresh`, authed(harness, { method: "POST" }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body["ok"], true);
    assert.equal(body["applied"], true);
    assert.equal(body["rate"], 6.7, "¥3：保留 2 位小数");
    assert.equal(body["rateSource"], "auto");
    assert.equal(body["provider"], "open.er-api.com");
    assert.equal(calls.length, 1, "只允许请求 1 个提供方");

    const after = (await (await fetch(`${harness.base}/api/summary?window=all`, authed(harness))).json()) as Record<string, any>;
    assert.equal(after["currency"]["rate"], 6.7);
    assert.equal(after["currency"]["rateSource"], "auto");
    assert.equal(after["totals"]["cost"]["usd"]["known"], before["totals"]["cost"]["usd"]["known"], "美元值不变");
    assert.equal(after["totals"]["cost"]["cny"]["known"], 0.000456, "0.000068 × 6.7 = 0.0004556");
    assert.equal(harness.engine.meta.revision, revisionBefore, "¥5：取汇率不得改 revision");

    const config = buildConfigResponse(harness.context);
    assert.equal(config.currency.rateSource, "auto");
    assert.equal(typeof config.currency.rateFetchedAt, "string");
    // 落盘（¥8：重启后仍然生效）。
    const written = JSON.parse(fs.readFileSync(harness.context.configPath, "utf8")) as Record<string, any>;
    assert.equal(written["currency"]["rate"], 6.7);
    assert.equal(written["currency"]["rateSource"], "auto");
  } finally {
    await harness.stop();
  }
});

test("¥8 / NFR-5：取汇率失败时保留旧值、返回 ok:false，不允许 5xx 或抛异常", async () => {
  const harness = await startHarness();
  try {
    harness.context.rateFetcher = (async () => {
      throw new Error("getaddrinfo ENOTFOUND open.er-api.com");
    }) as typeof fetch;

    const res = await fetch(`${harness.base}/api/rate/refresh`, authed(harness, { method: "POST" }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, any>;
    assert.equal(body["ok"], false);
    assert.equal(body["applied"], false);
    assert.equal(body["rate"], 7.2, "失败时必须保留上次的汇率");
    assert.equal(body["rateSource"], "manual");
    assert.match(body["reason"], /ENOTFOUND/);
    assert.equal(body["attempts"].length, 3);
    assert.equal(fs.existsSync(harness.context.configPath), false, "失败不得写配置文件");
  } finally {
    await harness.stop();
  }
});

test("¥8：关闭 autoRate 后 /tokens 不会联网（force 仍可手动更新）；错误方法返回 405", async () => {
  const harness = await startHarness();
  try {
    const put = await fetch(
      `${harness.base}/api/config`,
      authed(harness, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: { autoRate: false } }),
      }),
    );
    assert.equal(put.status, 200);

    let calls = 0;
    harness.context.rateFetcher = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ rates: { CNY: 6.6 } }), { status: 200 });
    }) as typeof fetch;

    // 非强制刷新：开关已关 → 直接返回，不发请求。
    const silent = await refreshAutoRate(harness.context, {});
    assert.equal(silent.applied, false);
    assert.equal(silent.ok, true);
    assert.equal(calls, 0, "关掉自动汇率后不得发起任何出站请求（NFR-7）");

    // 手动「立即更新」是显式动作，仍然允许。
    const forced = await refreshAutoRate(harness.context, { force: true });
    assert.equal(forced.applied, true);
    assert.equal(forced.rate, 6.6);
    assert.equal(calls, 1);

    const wrongMethod = await fetch(`${harness.base}/api/rate/refresh`, authed(harness));
    assert.equal(wrongMethod.status, 405);
  } finally {
    await harness.stop();
  }
});

test("buildConfigResponse：预算进度条只在配置了限额时出现（FR-10.6）", async () => {
  const harness = await startHarness();
  try {
    const before = buildConfigResponse(harness.context);
    assert.equal(before.budgetProgress.daily, null);
    assert.equal(before.budgetProgress.monthly, null);
    assert.equal(before.budget.enabled, false);

    const put = await fetch(
      `${harness.base}/api/config`,
      authed(harness, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ budget: { enabled: true, dailyCNY: 1 } }),
      }),
    );
    assert.equal(put.status, 200);
    const after = buildConfigResponse(harness.context);
    assert.equal(after.budget.enabled, true);
    assert.equal(after.budgetProgress.daily?.limitCNY, 1);
    assert.equal(after.budgetProgress.daily?.spentCNY, 0.00049, "M-2：先合计再换算到 6 位");
    assert.equal(after.budgetProgress.daily?.exceeded, false);
  } finally {
    await harness.stop();
  }
});
