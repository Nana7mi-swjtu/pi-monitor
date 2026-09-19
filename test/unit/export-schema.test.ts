/**
 * export-schema.test.ts — AC-9.2：导出 JSON 通过 `test/fixtures/export-schema.json` 校验。
 *
 * 校验器只实现 schema 用到的 JSON Schema 子集（type / required / properties / items /
 * enum / const / $ref / definitions / minimum / maximum / pattern / minItems /
 * additionalProperties），避免引入运行时依赖（NFR-1）。
 */

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { buildAggregate } from "../../src/aggregate.ts";
import { materializeRecords, MonitorEngine } from "../../src/scanner.ts";
import { loadConfigFromRaw } from "../../src/config.ts";
import { createNullLogger } from "../../src/health.ts";
import { resolveWindow } from "../../src/time.ts";
import { cleanup, fixturesRoot, makeTempAgentDir, parseFixture, fixturePath, readJson } from "../helpers.ts";

type Schema = Record<string, any>;

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function typeMatches(value: unknown, expected: string | string[]): boolean {
  const options = Array.isArray(expected) ? expected : [expected];
  const actual = typeOf(value);
  if (options.includes(actual)) return true;
  if (options.includes("integer") && actual === "number" && Number.isInteger(value)) return true;
  return false;
}

function validate(value: unknown, schema: Schema, root: Schema, pointer = "$"): string | null {
  if (schema["$ref"] !== undefined) {
    const ref = String(schema["$ref"]);
    const target = ref
      .replace(/^#\//, "")
      .split("/")
      .reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], root);
    return validate(value, target as Schema, root, pointer);
  }

  if (schema["const"] !== undefined && value !== schema["const"]) {
    return `${pointer}: 期望常量 ${JSON.stringify(schema["const"])}，实际 ${JSON.stringify(value)}`;
  }
  if (schema["enum"] !== undefined && !(schema["enum"] as unknown[]).includes(value)) {
    return `${pointer}: ${JSON.stringify(value)} 不在枚举 ${JSON.stringify(schema["enum"])} 中`;
  }
  if (schema["type"] !== undefined && !typeMatches(value, schema["type"])) {
    return `${pointer}: 期望类型 ${JSON.stringify(schema["type"])}，实际 ${typeOf(value)}`;
  }
  if (typeof value === "number") {
    if (schema["minimum"] !== undefined && value < schema["minimum"]) return `${pointer}: ${value} < minimum`;
    if (schema["maximum"] !== undefined && value > schema["maximum"]) return `${pointer}: ${value} > maximum`;
  }
  if (typeof value === "string" && schema["pattern"] !== undefined && !new RegExp(schema["pattern"]).test(value)) {
    return `${pointer}: "${value}" 不匹配 ${schema["pattern"]}`;
  }
  if (Array.isArray(value)) {
    if (schema["minItems"] !== undefined && value.length < schema["minItems"]) return `${pointer}: items 太少`;
    if (schema["items"] !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validate(value[index], schema["items"] as Schema, root, `${pointer}[${index}]`);
        if (error !== null) return error;
      }
    }
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    for (const key of (schema["required"] as string[] | undefined) ?? []) {
      if (!(key in record)) return `${pointer}: 缺少必需字段 ${key}`;
    }
    const properties = (schema["properties"] as Record<string, Schema> | undefined) ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in record)) continue;
      const error = validate(record[key], child, root, `${pointer}.${key}`);
      if (error !== null) return error;
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) return `${pointer}: 出现未声明字段 ${key}`;
      }
    }
  }
  return null;
}

test("AC-9.2：导出 JSON 通过 export-schema.json 校验", async () => {
  const schema = readJson<Schema>(path.join(fixturesRoot, "export-schema.json"));
  const agentDir = makeTempAgentDir();
  try {
    const { MonitorEngine: Engine } = { MonitorEngine };
    const engine = new Engine({
      agentDir,
      config: loadConfigFromRaw({ timezone: "utc" }).config,
      logger: createNullLogger(),
      env: {},
    });
    engine.load();

    const names = [
      "normal-basic.jsonl",
      "cache-heavy.jsonl",
      "no-cost.jsonl",
      "mixed-currency.jsonl",
      "negative-cost.jsonl",
      "compaction-usage.jsonl",
      "subagent-piweb.jsonl",
    ];
    const records = [];
    for (const name of names) {
      const parsed = await parseFixture(name);
      records.push(...materializeRecords(parsed, fixturePath(name), "utc".toUpperCase()));
    }

    const now = Date.parse("2026-09-20T00:00:00.000Z");
    const window = resolveWindow({ kind: "all" }, { tz: "UTC", weekStart: "monday", now });
    const { result } = buildAggregate({
      records,
      window,
      filters: {},
      rate: 7.2,
      weekStart: "monday",
      now,
      locale: "zh-CN",
      dimension: "model",
      withDaily: true,
      withGroups: true,
      metric: "tokens",
      limit: 50,
      health: engine.meta,
      labelFor: () => "全部",
    });

    // 必须先用 JSON 往返，确认序列化后仍然合法（导出走的是这条路径）。
    const roundTripped = JSON.parse(JSON.stringify(result)) as unknown;
    const error = validate(roundTripped, schema, schema);
    assert.equal(error, null, `导出 JSON 不符合 schema：${error}`);
    assert.ok((roundTripped as { groups: unknown[] }).groups.length > 0);
    assert.ok((roundTripped as { daily: unknown[] }).daily.length > 0);
    assert.equal((roundTripped as { currency: { code: string } }).currency.code, "CNY");

    // ¥8：自动获取汇率时 `rateSource: "auto"` 也必须通过 schema（导出的 JSON 与页面同一聚合器）。
    const autoResult = JSON.parse(
      JSON.stringify({ ...result, currency: { ...result.currency, rateSource: "auto" } }),
    ) as unknown;
    assert.equal(validate(autoResult, schema, schema), null, "自动汇率下导出 JSON 仍需符合 schema");
    // 未声明的字段（如自动汇率的时间戳只存在于配置，不属于 7.5）必须被拦住。
    const extra = JSON.parse(
      JSON.stringify({ ...result, currency: { ...result.currency, rateFetchedAt: "2026-09-19T00:00:00.000Z" } }),
    ) as unknown;
    assert.notEqual(validate(extra, schema, schema), null, "7.5 之外的 currency 字段必须不被接受");
  } finally {
    cleanup(agentDir);
  }
});

test("导出 JSON 的空窗口也满足 schema（零值对象）", () => {
  const schema = readJson<Schema>(path.join(fixturesRoot, "export-schema.json"));
  const now = Date.now();
  const { result } = buildAggregate({
    records: [],
    window: resolveWindow({ kind: "today" }, { tz: "UTC", weekStart: "monday", now }),
    filters: {},
    rate: 7.2,
    weekStart: "monday",
    now,
    locale: "en-US",
    dimension: "model",
    withDaily: true,
    withGroups: true,
    labelFor: () => "Today",
  });
  assert.equal(validate(JSON.parse(JSON.stringify(result)), schema, schema), null);
});
