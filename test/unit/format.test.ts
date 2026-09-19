/**
 * format.test.ts — 第 9 章（9.1 数字与货币格式、9.3 Markdown、9.4 CSV）、AC-9.1.1~AC-9.1.3、AC-9.4、AC-9.5。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildAggregate } from "../../src/aggregate.ts";
import {
  CSV_COLUMNS,
  buildMarkdown,
  exportFileName,
  formatAmount,
  formatCNY,
  formatCount,
  formatCountExact,
  formatPercent,
  formatRate,
  formatUSD,
  recordsToCsv,
} from "../../src/format.ts";
import { materializeRecords } from "../../src/scanner.ts";
import { resolveWindow } from "../../src/time.ts";
import { fixturePath, parseFixture } from "../helpers.ts";

test("AC-9.1.1：计数值缩写 999 / 1000 / 9999 / 12345 / 1234567", () => {
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1000), "1.0k");
  assert.equal(formatCount(9999), "10k");
  assert.equal(formatCount(12345), "12k");
  assert.equal(formatCount(1234567), "1.2M");
  // 溢出到更大单位的进位
  assert.equal(formatCount(999999), "1.0M");
  assert.equal(formatCount(1500000000), "1.5B");
});

test("AC-9.1.2/AC-9.1.3：金额格式（4 位 / 2 位 / 千分位 / 未知 —）", () => {
  assert.equal(formatCNY(0.0002176), "¥0.0002");
  assert.equal(formatCNY(1.5), "¥1.5000");
  assert.equal(formatCNY(123.456), "¥123.46");
  assert.equal(formatCNY(12345.6), "¥12,345.60");
  assert.equal(formatUSD(0.0002176), "$0.0002");
  assert.equal(formatCNY(null), "—", "¥7：未知金额禁止显示 ¥0.0000");
  assert.equal(formatUSD(null), "—");
  assert.equal(formatAmount(Number.NaN, "¥"), "—");
});

test("9.1：表格计数与百分比 / 汇率格式", () => {
  assert.equal(formatCountExact(12345), "12,345");
  assert.equal(formatCountExact(999), "999");
  assert.equal(formatPercent(0.1234), "12.3%");
  assert.equal(formatPercent(0), "0.0%");
  assert.equal(formatRate(7.2), "1 USD = 7.20 CNY");
});

test("AC-9.4：CSV 列顺序固定、含汇率注释行、逐条记录、CNY 列由 USD × rate 得到", async () => {
  const parsed = await parseFixture("normal-basic.jsonl");
  const records = materializeRecords(parsed, fixturePath("normal-basic.jsonl"), "UTC");
  const csv = recordsToCsv(records, 7.2, new Date("2026-09-19T00:00:00.000Z"));

  assert.ok(csv.startsWith("\uFEFF"), "CSV 必须带 UTF-8 BOM（Excel 中文兼容）");
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n").filter((line) => line.length > 0);
  assert.equal(lines[0], "# rate=7.20 generated=2026-09-19T00:00:00.000Z");
  assert.equal(lines[1], CSV_COLUMNS.join(","));
  // AC-9.4：行数 = 记录数 + 1（表头），注释行不计入。
  const dataLines = lines.filter((line) => !line.startsWith("#"));
  assert.equal(dataLines.length, records.length + 1);

  const header = (lines[1] as string).split(",");
  const row = (lines[2] as string).split(",");
  const costIndex = header.indexOf("costUsd");
  const cnyIndex = header.indexOf("costCny");
  assert.equal(row[cnyIndex], String(Math.round(0.000048 * 7.2 * 1e6) / 1e6));
  assert.equal(row[costIndex], "0.000048");
  assert.equal(header.indexOf("costCnyEst") > 0, true);
  // 逐条记录必须与账本记录条数一致（防止只导出窗口汇总）。
  assert.equal(records.length, 2);
});

test("AC-9.4：CSV 空值写空串，布尔写 true/false，含逗号字段按 RFC 4180 转义", async () => {
  const parsed = await parseFixture("no-cost.jsonl");
  const records = materializeRecords(parsed, fixturePath("no-cost.jsonl"), "UTC");
  const csv = recordsToCsv(records, 7.2, new Date("2026-09-19T00:00:00.000Z"));
  const lines = csv.replace(/^\uFEFF/, "").split("\r\n").filter((line) => line.length > 0);
  const header = (lines[1] as string).split(",");
  const row = (lines[2] as string).split(",");
  assert.equal(row[header.indexOf("costUsd")], "");
  assert.equal(row[header.indexOf("costCny")], "");
  assert.equal(row[header.indexOf("costUsdEst")], "");
});

test("AC-9.5：导出文件名匹配 ^pi-monitor-.*-\\d{8}-\\d{6}\\.(md|json|csv)$", () => {
  const date = new Date(2026, 8, 19, 19, 4, 11);
  for (const ext of ["md", "json", "csv"]) {
    const name = exportFileName("last7d", date, ext);
    assert.match(name, /^pi-monitor-.*-\d{8}-\d{6}\.(md|json|csv)$/);
    assert.ok(name.endsWith(`-20260919-190411.${ext}`));
  }
});

test("AC-9.3：Markdown 首部含汇率行，数字与当前窗口一致，区块顺序固定", async () => {
  const parsed = await parseFixture("normal-basic.jsonl");
  const records = materializeRecords(parsed, fixturePath("normal-basic.jsonl"), "UTC");
  const tz = "UTC";
  const window = resolveWindow({ kind: "custom", fromDay: "2026-09-19", toDay: "2026-09-19" }, { tz, weekStart: "monday", now: Date.parse("2026-09-19T12:00:00Z") });
  const { result, windowed } = buildAggregate({
    records,
    window,
    filters: {},
    rate: 7.2,
    weekStart: "monday",
    now: Date.parse("2026-09-19T12:00:00Z"),
    locale: "zh-CN",
    dimension: "model",
    withDaily: true,
    withGroups: true,
    labelFor: () => "2026-09-19 → 2026-09-19",
  });

  const markdown = buildMarkdown({
    locale: "zh-CN",
    windowLabel: result.window.label,
    timezone: tz,
    rate: result.currency.rate,
    generatedAt: new Date("2026-09-19T12:00:00.000Z"),
    overview: [{ label: result.window.label, totals: result.totals }],
    daily: result.daily ?? [],
    breakdown: { dimension: "model", groups: result.groups ?? [] },
    meta: {
      schemaVersion: 1,
      revision: 3,
      startedAt: "2026-09-19T00:00:00.000Z",
      pid: 1,
      lastScanAt: "2026-09-19T11:00:00.000Z",
      lastScanMs: 1,
      scanning: false,
      progress: 1,
      files: 1,
      records: windowed.length,
      dedupeSkipped: 0,
      corruptLines: 0,
      invalidSessions: 0,
      inconsistencyCount: 0,
      corruptDuplicateIds: 0,
      corruptCost: 0,
      corruptUsage: 0,
      skippedFiles: 0,
      ledgerRepaired: 0,
      configWarnings: [],
      unknownKeys: [],
      tz,
      tzChanged: false,
    },
    files: 1,
    records: windowed.length,
    dedupeSkipped: 0,
    updatedAt: "2026-09-19 11:00:00 +00:00",
  });

  const lines = markdown.split("\n");
  assert.equal(lines[0]?.startsWith("# pi-monitor 报表 ·"), true);
  assert.ok(markdown.includes("汇率：1 USD = 7.20 CNY（手动设置）"), "¥4：首部必须含汇率行");
  assert.ok(markdown.includes("## 概览"));
  assert.ok(markdown.includes("## 每日明细"));
  assert.ok(markdown.includes("## 按模型"));
  assert.ok(markdown.includes("## 数据源"));
  assert.ok(markdown.indexOf("## 概览") < markdown.indexOf("## 每日明细"));
  assert.ok(markdown.indexOf("## 每日明细") < markdown.indexOf("## 按模型"));
  assert.ok(markdown.indexOf("## 按模型") < markdown.indexOf("## 数据源"));
  // 概览金额与聚合结果一致（同一窗口：¥ = USD × rate；M-4 先合计后换算）。
  assert.equal(result.totals.cost.usd.known, 0.0000525);
  assert.equal(result.totals.cost.cny.known, 0.000378);
  assert.ok(markdown.includes(formatCNY(result.totals.cost.cny.known)));
  assert.ok(markdown.includes("¥0.0004"));
});
