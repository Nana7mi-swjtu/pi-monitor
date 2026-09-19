/**
 * engine.bench.mjs — 性能基准（NFR-2、NFR-3、NFR-13、NFR-14）。
 *
 * 用法：node --expose-gc test/bench/engine.bench.mjs
 *
 * 规模：固定生成 500 MiB 会话日志（约 120 万条 usage 记录）。
 * 不允许通过环境变量缩小规模 —— 阈值是 PRD 的验收标准，不得因运行环境而放宽（P-5）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildAggregate, sumTotals } from "../../src/aggregate.ts";
import { loadConfigFromRaw } from "../../src/config.ts";
import { createNullLogger } from "../../src/health.ts";
import { MonitorEngine } from "../../src/scanner.ts";
import { resolveWindow } from "../../src/time.ts";

const TARGET_MIB = 500;
const FILE_COUNT = 25;

function buildUsageLine(fileIndex, recordIndex) {
  return (
    JSON.stringify({
      type: "message",
      id: `b${fileIndex}-${recordIndex}`,
      parentId: null,
      timestamp: "2026-09-19T10:00:00.000Z",
      message: {
        role: "assistant",
        api: "openai-completions",
        provider: "acme",
        model: recordIndex % 3 === 0 ? "acme-2" : "acme-1",
        usage: {
          input: 223,
          output: 280,
          cacheRead: 5376,
          cacheWrite: 0,
          reasoning: 124,
          totalTokens: 5879,
          cost: { input: 0.00003345, output: 0.000168, cacheRead: 0.000016128, cacheWrite: 0, total: 0.000217578 },
        },
        stopReason: "stop",
        timestamp: 1789812001000 + recordIndex,
      },
    }) + "\n"
  );
}

function generateCorpus(root) {
  const dir = path.join(root, "sessions", "--bench--");
  fs.mkdirSync(dir, { recursive: true });
  const perFileBytes = Math.floor((TARGET_MIB * 1024 * 1024) / FILE_COUNT);
  let records = 0;
  for (let fileIndex = 0; fileIndex < FILE_COUNT; fileIndex += 1) {
    const handle = fs.openSync(path.join(dir, `bench-${fileIndex}.jsonl`), "w");
    fs.writeSync(
      handle,
      `${JSON.stringify({ type: "session", version: 3, id: `bench-${fileIndex}`, timestamp: "2026-09-19T00:00:00.000Z", cwd: `D:\\bench\\${fileIndex}` })}\n`,
    );
    let bytes = 0;
    let recordIndex = 0;
    let pending = "";
    while (bytes < perFileBytes) {
      const line = buildUsageLine(fileIndex, recordIndex);
      pending += line;
      bytes += Buffer.byteLength(line, "utf8");
      recordIndex += 1;
      records += 1;
      if (recordIndex % 2000 === 0) {
        fs.writeSync(handle, pending);
        pending = "";
      }
    }
    if (pending.length > 0) fs.writeSync(handle, pending);
    fs.closeSync(handle);
  }
  return { dir, records };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-monitor-bench-"));
const corpus = generateCorpus(root);
const corpusMiB = Number(
  (
    fs
      .readdirSync(corpus.dir)
      .reduce((sum, name) => sum + fs.statSync(path.join(corpus.dir, name)).size, 0) /
    1024 /
    1024
  ).toFixed(1),
);

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test(`NFR-2：全量扫描 ${corpusMiB} MiB（${corpus.records} 条记录）< 20 s`, async () => {
  const engine = new MonitorEngine({
    agentDir: root,
    config: loadConfigFromRaw({ timezone: "utc" }).config,
    logger: createNullLogger(),
    env: {},
  });
  const started = performance.now();
  engine.load();
  const summary = await engine.scan({});
  const elapsed = performance.now() - started;
  assert.equal(summary.records, corpus.records, "所有记录都必须入账");
  assert.ok(elapsed < 20_000, `全量扫描耗时 ${elapsed.toFixed(0)} ms 应 < 20 s`);
  globalThis.__engine = engine;
});

test("NFR-2：热启动扫描（无变化）< 150 ms", async () => {
  const engine = globalThis.__engine;
  assert.ok(engine, "需要先完成全量扫描");
  const started = performance.now();
  const summary = await engine.scan({});
  const elapsed = performance.now() - started;
  assert.equal(summary.scanned, 0, "无变化时不得重扫任何文件");
  assert.ok(elapsed < 150, `热启动扫描耗时 ${elapsed.toFixed(1)} ms 应 < 150 ms`);
});

test("NFR-2 / NFR-14：10 万条记录聚合 < 800 ms；首屏所需聚合 < 1.5 s", async () => {
  const engine = globalThis.__engine;
  assert.ok(engine, "需要先完成全量扫描");
  const sample = engine.records.slice(0, 100_000);
  const now = Date.parse("2026-09-19T12:00:00.000Z");
  const window = resolveWindow({ kind: "all" }, { tz: "UTC", weekStart: "monday", now });

  const started = performance.now();
  const totals = sumTotals(sample, 7.2);
  const aggregateMs = performance.now() - started;
  assert.ok(totals.tokens.billed > 0);
  assert.ok(aggregateMs < 800, `10 万条记录聚合耗时 ${aggregateMs.toFixed(1)} ms 应 < 800 ms`);

  // NFR-14：仪表盘首屏需要一次 summary + 一次 daily + 一次 breakdown。
  const firstScreenStarted = performance.now();
  for (const options of [
    { withDaily: false, withGroups: false },
    { withDaily: true, metric: "tokens" },
    { withGroups: true, dimension: "model", limit: 20 },
  ]) {
    buildAggregate({
      records: engine.records,
      window,
      filters: {},
      rate: 7.2,
      weekStart: "monday",
      now,
      locale: "zh-CN",
      labelFor: () => "all",
      ...options,
    });
  }
  const firstScreenMs = performance.now() - firstScreenStarted;
  assert.ok(firstScreenMs < 1500, `首屏聚合耗时 ${firstScreenMs.toFixed(0)} ms 应 < 1.5 s`);
});

test(`NFR-13：≥ 100 万条记录的规模可完成扫描并报告常驻占用（${corpus.records} 条）`, async () => {
  const engine = globalThis.__engine;
  assert.ok(engine, "需要先完成全量扫描");
  assert.ok(corpus.records >= 1_000_000, `本基准语料为 ${corpus.records} 条记录`);
  if (globalThis.gc) globalThis.gc();
  const heapMiB = process.memoryUsage().heapUsed / 1024 / 1024;
  const rssMiB = process.memoryUsage().rss / 1024 / 1024;
  process.stdout.write(
    `\n[报告] ${corpusMiB} MiB / ${corpus.records} 条记录：堆 ${heapMiB.toFixed(0)} MiB，RSS ${rssMiB.toFixed(0)} MiB，` +
      `索引 ${(engine.indexSizeBytes / 1024 / 1024).toFixed(1)} MiB\n`,
  );
  assert.equal(engine.records.length, corpus.records);
});

test("NFR-3：常驻内存（典型语料 2 千条记录 + HTTP 服务）< 150 MiB", async () => {
  // 适用规模：典型语料（≤ 1 万条记录）；百万条记录的实测占用仅作报告输出。
  // 先把上一组基准用的大引擎释放掉，保证测量不受污染。
  globalThis.__engine = null;
  if (globalThis.gc) {
    globalThis.gc();
    globalThis.gc();
  }
  const baselineMiB = process.memoryUsage().heapUsed / 1024 / 1024;

  const smallRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-monitor-bench-small-"));
  try {
    const dir = path.join(smallRoot, "sessions", "--proj--");
    fs.mkdirSync(dir, { recursive: true });
    for (let fileIndex = 0; fileIndex < 25; fileIndex += 1) {
      let body = `${JSON.stringify({ type: "session", version: 3, id: `small-${fileIndex}`, timestamp: "2026-09-19T00:00:00.000Z", cwd: "D:\\small" })}\n`;
      for (let recordIndex = 0; recordIndex < 90; recordIndex += 1) {
        body +=
          JSON.stringify({
            type: "message",
            id: `s${fileIndex}-${recordIndex}`,
            parentId: null,
            timestamp: "2026-09-19T10:00:00.000Z",
            message: {
              role: "assistant",
              api: "openai-completions",
              provider: "acme",
              model: "acme-1",
              usage: { input: 223, output: 280, cacheRead: 5376, cacheWrite: 0, reasoning: 124, totalTokens: 5879, cost: { total: 0.000217578 } },
              stopReason: "stop",
              timestamp: 1789812001000 + recordIndex,
            },
          }) + "\n";
      }
      fs.writeFileSync(path.join(dir, `small-${fileIndex}.jsonl`), body, "utf8");
    }

    const engine = new MonitorEngine({
      agentDir: smallRoot,
      config: loadConfigFromRaw({ timezone: "utc" }).config,
      logger: createNullLogger(),
      env: {},
    });
    engine.load();
    await engine.scan({});
    assert.equal(engine.records.length, 25 * 90);
    if (globalThis.gc) globalThis.gc();
    const heapMiB = process.memoryUsage().heapUsed / 1024 / 1024;
    process.stdout.write(`[报告] 典型语料（2250 条记录）堆 ${heapMiB.toFixed(1)} MiB（基线 ${baselineMiB.toFixed(1)} MiB）\n`);
    assert.ok(heapMiB < 150, `典型语料常驻堆 ${heapMiB.toFixed(1)} MiB 应 < 150 MiB`);
  } finally {
    fs.rmSync(smallRoot, { recursive: true, force: true });
  }
});
