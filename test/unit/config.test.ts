/**
 * config.test.ts — FR-11（AC-11.1~AC-11.5）、第 12 章、¥3。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_RATE,
  WRITABLE_CONFIG_PATHS,
  defaultConfig,
  isRate,
  loadConfig,
  loadConfigFromRaw,
  normalizeRate,
  updateConfigFile,
} from "../../src/config.ts";
import { cleanup, makeTempAgentDir } from "../helpers.ts";

test("AC-11.1：无配置文件时默认值全部生效，且不自动创建文件", () => {
  const dir = makeTempAgentDir();
  try {
    const configPath = path.join(dir, "pi-monitor", "config.json");
    const loaded = loadConfig(configPath);
    assert.equal(loaded.exists, false);
    assert.deepEqual(loaded.config, defaultConfig());
    assert.equal(loaded.warnings.length, 0);
    assert.equal(fs.existsSync(configPath), false, "FR-11.2：不得自动创建配置文件");
  } finally {
    cleanup(dir);
  }
});

test("FR-11.4 / AC-11.3：非法值回退默认并计入 configWarnings", () => {
  const loaded = loadConfigFromRaw({ currency: { rate: 12345 } });
  assert.equal(loaded.config.currency.rate, DEFAULT_RATE);
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0] as string, /currency\.rate/);

  const wrongType = loadConfigFromRaw({ tableLimit: "20", dedupe: "nope", budget: { warnAt: [0, 2] } });
  assert.equal(wrongType.config.tableLimit, 20, "非法类型回退默认值");
  assert.equal(wrongType.config.dedupe, "fingerprint");
  assert.deepEqual(wrongType.config.budget.warnAt, [0.5, 0.8, 1.0], "越界阈值被过滤后回退默认");
  assert.ok(wrongType.warnings.length >= 3);
});

test("FR-11.4 / AC-11.4：未知键保留（不删除）并记录 unknownKeys", () => {
  const dir = makeTempAgentDir();
  try {
    const configPath = path.join(dir, "pi-monitor", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ currency: { rate: 7.5 }, myCustomKey: { nested: true }, dashboard: { futureFlag: 1 } }),
      "utf8",
    );
    const loaded = loadConfig(configPath);
    assert.equal(loaded.config.currency.rate, 7.5);
    assert.deepEqual(loaded.unknownKeys.sort(), ["dashboard.futureFlag", "myCustomKey"]);

    // AC-11.4：通过仪表盘保存不会删除未知键。
    const result = updateConfigFile(configPath, { currency: { rate: 8.25 } }, loaded);
    assert.equal(result.ok, true);
    const after = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(after["myCustomKey"], { nested: true });
    assert.deepEqual(after["dashboard"], { futureFlag: 1 });
    assert.equal((after["currency"] as Record<string, unknown>)["rate"], 8.25);
  } finally {
    cleanup(dir);
  }
});

test("AC-11.5：写入非白名单键返回 rejected（HTTP 层映射为 403），且不落盘", () => {
  const dir = makeTempAgentDir();
  try {
    const configPath = path.join(dir, "pi-monitor", "config.json");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ currency: { rate: 7.2 } }), "utf8");
    const loaded = loadConfig(configPath);
    const before = fs.readFileSync(configPath, "utf8");

    const rejected = updateConfigFile(configPath, { timezone: "UTC" }, loaded);
    assert.equal(rejected.ok, false);
    assert.deepEqual(rejected.rejected, ["timezone"]);
    assert.equal(fs.readFileSync(configPath, "utf8"), before, "被拒绝的写入不得修改文件");

    // 白名单键写入成功且原子。
    const allowed = updateConfigFile(configPath, { currency: { rate: 6.9 }, budget: { enabled: true } }, loaded);
    assert.equal(allowed.ok, true);
    assert.equal(fs.readFileSync(configPath, "utf8").includes('"rate": 6.9'), true);
  } finally {
    cleanup(dir);
  }
});

test("FR-11.6：白名单与 PRD 12 章一致", () => {
  assert.deepEqual(
    [...WRITABLE_CONFIG_PATHS].sort(),
    [
      "budget.dailyCNY",
      "budget.enabled",
      "budget.includeEstimated",
      "budget.injectMessage",
      "budget.monthlyCNY",
      "budget.warnAt",
      "currency.rate",
      "dashboard.allowLan",
      "dashboard.theme",
      "locale",
    ],
  );
});

test("¥3：汇率范围 0.01..100.00，保留 2 位小数，代码中不存在硬编码换算常数（P-13）", () => {  assert.equal(isRate(0.01), true);
  assert.equal(isRate(100), true);
  assert.equal(isRate(0.001), false);
  assert.equal(isRate(100.01), false);
  assert.equal(isRate(Number.NaN), false);
  assert.equal(normalizeRate(7.2345), 7.23);
  assert.equal(normalizeRate(7.2), 7.2);
  const loaded = loadConfigFromRaw({ currency: { rate: 7.239 } });
  assert.equal(loaded.config.currency.rate, 7.24);
});

test("第 12 章：budget.dailyCNY / monthlyCNY 允许 null 或非负数值（FR-11.6 可写字段）", () => {
  const configured = loadConfigFromRaw({ budget: { dailyCNY: 10, monthlyCNY: 300, enabled: true } });
  assert.equal(configured.warnings.length, 0, "合法配置不得产生告警");
  assert.equal(configured.config.budget.dailyCNY, 10);
  assert.equal(configured.config.budget.monthlyCNY, 300);
  assert.equal(configured.config.budget.enabled, true);

  const cleared = loadConfigFromRaw({ budget: { dailyCNY: null, monthlyCNY: null } });
  assert.equal(cleared.config.budget.dailyCNY, null);
  assert.equal(cleared.config.budget.monthlyCNY, null);

  const negative = loadConfigFromRaw({ budget: { dailyCNY: -1 } });
  assert.equal(negative.config.budget.dailyCNY, null);
  assert.equal(negative.warnings.length, 1);
});

test("第 12 章：默认配置与文档一致", () => {
  const config = defaultConfig();
  assert.equal(config.locale, "auto");
  assert.equal(config.timezone, "local");
  assert.equal(config.weekStart, "monday");
  assert.equal(config.dedupe, "fingerprint");
  assert.equal(config.ephemeralCapture, true);
  assert.equal(config.defaultWindow, "last7d");
  assert.equal(config.tableLimit, 20);
  assert.equal(config.tool.enabled, true);
  assert.equal(config.currency.code, "CNY");
  assert.equal(config.currency.rate, 7.2);
  assert.equal(config.dashboard.port, 30142);
  assert.equal(config.dashboard.portRange, 18);
  assert.equal(config.dashboard.allowLan, false);
  assert.equal(config.dashboard.stopOnExit, true);
  assert.equal(config.dashboard.linkMessage, true);
  assert.equal(config.dashboard.theme, "auto");
  assert.equal(config.budget.enabled, false);
  assert.deepEqual(config.budget.warnAt, [0.5, 0.8, 1.0]);
  assert.equal(config.budget.includeEstimated, false);
  assert.equal(config.budget.injectMessage, false);
  assert.equal(config.logging.level, "error");
  assert.equal(config.logging.maxFiles, 7);
  assert.equal(config.logging.maxBytes, 5_242_880);
});

test("FR-11.5：写入使用临时文件 + rename（不留下 .tmp 残留）", () => {
  const dir = makeTempAgentDir();
  try {
    const configPath = path.join(dir, "pi-monitor", "config.json");
    const loaded = loadConfig(configPath);
    updateConfigFile(configPath, { locale: "zh-CN" }, loaded);
    const leftovers = fs.readdirSync(path.dirname(configPath)).filter((name) => name.includes(".tmp-"));
    assert.deepEqual(leftovers, []);
  } finally {
    cleanup(dir);
  }
});
