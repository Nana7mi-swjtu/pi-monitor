/**
 * scanner.test.ts — FR-2（增量索引与缓存）、FR-3（去重落账）、FR-4（实时计数器）、
 * FR-12（存储 / 迁移 / 重建）、NFR-4（并发锁）、13 章（自愈）。
 * 需求：AC-2.1~AC-2.4、AC-3.3、AC-4.1~AC-4.3、AC-12.1~AC-12.3、AC-12.5
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadConfigFromRaw } from "../../src/config.ts";
import { createNullLogger } from "../../src/health.ts";
import { acquireLock, LockTimeoutError, readLedger } from "../../src/ledger.ts";
import { MonitorEngine } from "../../src/scanner.ts";
import { assistantEntry, cleanup, makeTempAgentDir, writeSessionFile } from "../helpers.ts";

function makeEngine(agentDir: string, overrides: Record<string, unknown> = {}): MonitorEngine {
  const loaded = loadConfigFromRaw({ timezone: "UTC", ...overrides });
  const engine = new MonitorEngine({
    agentDir,
    config: loaded.config,
    logger: createNullLogger(),
    env: {},
  });
  engine.load();
  return engine;
}

function sessionDir(agentDir: string, project = "--proj--"): string {
  const dir = path.join(agentDir, "sessions", project);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("AC-2.1：追加一条 usage 后二次扫描只新增 1 条", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dir = sessionDir(agentDir);
    const file = writeSessionFile(dir, "a.jsonl", [
      assistantEntry({ id: "a1", iso: "2026-09-19T10:00:00.000Z", input: 10, output: 10, costTotal: 0.01 }),
    ]);

    const engine = makeEngine(agentDir);
    const first = await engine.scan({});
    assert.equal(first.records, 1);
    assert.equal(first.scanned, 1);

    // 追加一条（保留已有内容 + 末尾换行）。
    fs.appendFileSync(
      file,
      `${JSON.stringify(assistantEntry({ id: "a2", iso: "2026-09-19T10:05:00.000Z", input: 20, output: 20, costTotal: 0.02 }))}\n`,
      "utf8",
    );

    const second = await engine.scan({});
    assert.equal(second.records, 2, "总数 = 原数 + 1");
    assert.equal(second.scanned, 1, "只重扫变化的文件");
    assert.equal(engine.meta.revision, 2, "AC-6.8：每次扫描 revision 自增");

    // 第三次扫描：文件未变化 → 不重扫。
    const third = await engine.scan({});
    assert.equal(third.scanned, 0);
    assert.equal(third.records, 2);

    // 账本可被独立读取并通过 7.3 字段校验。
    const ledger = readLedger(engine.paths.ledger);
    assert.equal(ledger.records.length, 2);
    assert.equal(ledger.repaired, 0);
  } finally {
    cleanup(agentDir);
  }
});

test("FR-2.3：不吞掉正在写入的半行（游标不越过未终止行）", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dir = sessionDir(agentDir);
    const file = path.join(dir, "half.jsonl");
    const header = '{"type":"session","version":3,"id":"s","timestamp":"2026-09-19T00:00:00.000Z","cwd":"D:\\\\x"}\n';
    const full = `${JSON.stringify(assistantEntry({ id: "h1", iso: "2026-09-19T10:00:00.000Z", input: 1, output: 1, costTotal: 0.01 }))}\n`;
    const partial = full.slice(0, Math.floor(full.length / 2));
    fs.writeFileSync(file, header + full + partial, "utf8");

    const engine = makeEngine(agentDir);
    await engine.scan({});
    assert.equal(engine.records.length, 1, "半行不得计入");

    // 补全该行后再扫描：必须恰好得到第 2 条，且不产生半行残渣。
    fs.writeFileSync(file, header + full + full.replace('"h1"', '"h2"'), "utf8");
    await engine.scan({});
    assert.equal(engine.records.length, 2, "半行补全后必须被正确计入");
    assert.deepEqual(engine.records.map((record) => record.entryId).sort(), ["h1", "h2"]);
  } finally {
    cleanup(agentDir);
  }
});

test("AC-2.2：重写文件后旧记录不残留", async () => {  const agentDir = makeTempAgentDir();
  try {
    const dir = sessionDir(agentDir);
    const file = path.join(dir, "rewrite.jsonl");
    writeSessionFile(dir, "rewrite.jsonl", [
      assistantEntry({ id: "r1", iso: "2026-09-19T10:00:00.000Z", input: 100, output: 100, costTotal: 0.1 }),
      assistantEntry({ id: "r2", iso: "2026-09-19T10:01:00.000Z", input: 200, output: 200, costTotal: 0.2 }),
    ]);

    const engine = makeEngine(agentDir);
    await engine.scan({});
    assert.equal(engine.records.length, 2);

    // 重写（首行变化 → 前缀哈希不一致 → 该文件记录全部重扫）。
    fs.writeFileSync(
      file,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "sess-rewritten",
          timestamp: "2026-09-19T00:00:00.000Z",
          cwd: "D:\\x",
        }),
        JSON.stringify(assistantEntry({ id: "r3", iso: "2026-09-19T11:00:00.000Z", input: 5, output: 5, costTotal: 0.05 })),
      ].join("\n") + "\n",
      "utf8",
    );

    await engine.scan({});
    assert.equal(engine.records.length, 1, "旧记录必须被清除");
    assert.deepEqual(engine.records.map((record) => record.entryId), ["r3"]);
    assert.equal(engine.records[0]?.sessionId, "sess-rewritten");
  } finally {
    cleanup(agentDir);
  }
});

/*
 * 回归（用户报告：「重新扫描也看不到今天的用量，直到很久以后才出现」）：
 * pi-web 与 pi CLI 各持有一个引擎，另一个进程扫描后会自行追加账本并推进游标；
 * 本进程若只看内存 records + 磁盘游标，会得到「所有文件都没变化」并回放陈旧数据。
 * 修复后：账本磁盘指纹变化 → 重新载入账本，重新扫描即时可见。
 */
test("NFR-4 / FR-2：另一个进程扫过之后，本进程重新扫描必须能跟上（不得回放陈旧内存）", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dir = sessionDir(agentDir);
    const file = writeSessionFile(dir, "shared.jsonl", [
      assistantEntry({ id: "s1", iso: "2026-09-19T10:00:00.000Z", input: 10, output: 10, costTotal: 0.01 }),
    ]);

    const dashboard = makeEngine(agentDir);
    await dashboard.scan({});
    assert.equal(dashboard.records.length, 1);

    // 另一个 pi 进程：追加一条 usage，并自己扫描（写账本 + 写游标）。
    fs.appendFileSync(
      file,
      `${JSON.stringify(assistantEntry({ id: "s2", iso: "2026-09-19T10:05:00.000Z", input: 20, output: 20, costTotal: 0.02 }))}\n`,
      "utf8",
    );
    const other = makeEngine(agentDir);
    await other.scan({});
    assert.equal(other.records.length, 2);

    // 仪表盘进程重新扫描：「所有文件未变化」但账本已变 → 必须重新载入。
    const summary = await dashboard.scan({});
    assert.equal(summary.scanned, 0, "游标已被另一个进程推进，本进程看不到文件变化");
    assert.equal(dashboard.records.length, 2, "账本已被外部更新 → 内存必须跟着更新");
    assert.equal(dashboard.meta.records, 2);

    // 后续扫描不得因为「指纹已对齐」而再次丢记录。
    fs.appendFileSync(
      file,
      `${JSON.stringify(assistantEntry({ id: "s3", iso: "2026-09-19T10:06:00.000Z", input: 30, output: 30, costTotal: 0.03 }))}\n`,
      "utf8",
    );
    const third = await dashboard.scan({});
    assert.equal(third.scanned, 1);
    assert.equal(dashboard.records.length, 3);
  } finally {
    cleanup(agentDir);
  }
});

test("AC-2.3：100 个未变化文件的热启动扫描 < 150 ms", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dir = sessionDir(agentDir);
    for (let index = 0; index < 100; index += 1) {
      writeSessionFile(
        dir,
        `hot-${String(index).padStart(3, "0")}.jsonl`,
        [assistantEntry({ id: `h${index}`, iso: "2026-09-19T10:00:00.000Z", input: 1, output: 1, costTotal: 0.001 })],
        {
          header: {
            type: "session",
            version: 3,
            id: `sess-${index}`,
            timestamp: "2026-09-19T00:00:00.000Z",
            cwd: "D:\\hot",
          },
        },
      );
    }
    const engine = makeEngine(agentDir);
    const cold = await engine.scan({});
    assert.equal(cold.records, 100);

    const started = performance.now();
    const hot = await engine.scan({});
    const elapsed = performance.now() - started;
    assert.equal(hot.scanned, 0, "热启动不得重扫任何文件");
    assert.ok(elapsed < 150, `热启动耗时 ${elapsed.toFixed(1)} ms 应 < 150 ms`);
  } finally {
    cleanup(agentDir);
  }
});

test("FR-3 落账：跨文件重复只计一次，重复条数计入 meta.dedupeSkipped", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dir = sessionDir(agentDir);
    const shared = assistantEntry({ id: "s1", iso: "2026-09-19T10:00:00.000Z", input: 10, output: 10, costTotal: 0.01 });
    writeSessionFile(dir, "parent.jsonl", [shared], {
      header: { type: "session", version: 3, id: "sess-parent", timestamp: "2026-09-19T00:00:00.000Z", cwd: "D:\\p" },
    });
    writeSessionFile(dir, "child.jsonl", [shared], {
      header: {
        type: "session",
        version: 3,
        id: "sess-child",
        timestamp: "2026-09-19T00:00:00.000Z",
        cwd: "D:\\p",
        parentSession: "D:\\p\\parent.jsonl",
      },
    });

    const engine = makeEngine(agentDir);
    await engine.scan({});
    assert.equal(engine.records.length, 1);
    assert.equal(engine.meta.dedupeSkipped, 1);
    assert.equal(engine.dedupeSkips.length, 1, "D-3：跳过明细必须可审计");
    assert.equal(engine.dedupeSkips[0]?.fp, engine.records[0]?.fp);
    // D-2：首见者胜 —— 同 ts 时按文件路径字典序裁决（child.jsonl < parent.jsonl）。
    const skip = engine.dedupeSkips[0];
    assert.ok(skip);
    assert.ok(skip.keptFile.endsWith("child.jsonl"), `kept=${skip.keptFile}`);
    assert.ok(skip.skippedFile.endsWith("parent.jsonl"), `skipped=${skip.skippedFile}`);
  } finally {
    cleanup(agentDir);
  }
});

test("AC-3.3 / D-5：dedupe:off 时总量等于文件求和", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dir = sessionDir(agentDir);
    const shared = assistantEntry({ id: "s1", iso: "2026-09-19T10:00:00.000Z", input: 10, output: 10, costTotal: 0.01 });
    writeSessionFile(dir, "parent.jsonl", [shared]);
    writeSessionFile(dir, "child.jsonl", [shared], {
      header: {
        type: "session",
        version: 3,
        id: "sess-child",
        timestamp: "2026-09-19T00:00:00.000Z",
        cwd: "D:\\p",
        parentSession: "D:\\p\\parent.jsonl",
      },
    });
    const engine = makeEngine(agentDir, { dedupe: "off" });
    await engine.scan({});
    assert.equal(engine.records.length, 2, "关闭去重后两条都保留");
    assert.equal(engine.meta.dedupeSkipped, 0);
  } finally {
    cleanup(agentDir);
  }
});

test("AC-12.1：schemaVersion=0 的 meta 自动迁移且总量不变", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dir = sessionDir(agentDir);
    writeSessionFile(dir, "m.jsonl", [
      assistantEntry({ id: "m1", iso: "2026-09-19T10:00:00.000Z", input: 10, output: 10, costTotal: 0.01 }),
    ]);
    const engine = makeEngine(agentDir);
    await engine.scan({});
    assert.equal(engine.records.length, 1);

    const metaPath = engine.paths.meta;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    meta["schemaVersion"] = 0;
    fs.writeFileSync(metaPath, JSON.stringify(meta), "utf8");

    const reloaded = makeEngine(agentDir);
    assert.equal(reloaded.readOnly, false, "低版本必须可迁移（非只读）");
    assert.equal(reloaded.meta.schemaVersion, 1);
    assert.equal(reloaded.records.length, 1, "迁移必须无损");
  } finally {
    cleanup(agentDir);
  }
});

test("AC-12.2：schemaVersion=999 时只读运行且不写任何索引文件", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dir = sessionDir(agentDir);
    writeSessionFile(dir, "m.jsonl", [
      assistantEntry({ id: "m1", iso: "2026-09-19T10:00:00.000Z", input: 10, output: 10, costTotal: 0.01 }),
    ]);
    const engine = makeEngine(agentDir);
    await engine.scan({});

    const metaPath = engine.paths.meta;
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as Record<string, unknown>;
    meta["schemaVersion"] = 999;
    meta["revision"] = 42;
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    const before = fs.statSync(metaPath).mtimeMs;
    const ledgerBefore = fs.readFileSync(engine.paths.ledger, "utf8");

    const readonly = makeEngine(agentDir);
    assert.equal(readonly.readOnly, true);
    assert.equal(readonly.meta.revision, 42);
    const summary = await readonly.scan({});
    assert.equal(summary.readOnly, true);
    assert.equal(summary.scanned, 0);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fs.statSync(metaPath).mtimeMs, before, "只读模式不得写 meta");
    assert.equal(fs.readFileSync(readonly.paths.ledger, "utf8"), ledgerBefore, "只读模式不得写账本");
  } finally {
    cleanup(agentDir);
  }
});

test("AC-12.3 / FR-12.4：重建前后总量一致（去重与口径回归）", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dir = sessionDir(agentDir);
    const shared = assistantEntry({ id: "s1", iso: "2026-09-19T10:00:00.000Z", input: 10, output: 10, costTotal: 0.01 });
    writeSessionFile(dir, "parent.jsonl", [shared]);
    writeSessionFile(dir, "child.jsonl", [shared], {
      header: {
        type: "session",
        version: 3,
        id: "sess-child",
        timestamp: "2026-09-19T00:00:00.000Z",
        cwd: "D:\\p",
        parentSession: "D:\\p\\parent.jsonl",
      },
    });
    writeSessionFile(dir, "other.jsonl", [
      assistantEntry({ id: "o1", iso: "2026-09-20T10:00:00.000Z", input: 3, output: 4, costTotal: 0.02 }),
    ]);

    const engine = makeEngine(agentDir);
    await engine.scan({});
    const billedBefore = engine.records.reduce((sum, record) => sum + record.billed, 0);
    const countBefore = engine.records.length;

    const rebuilt = await engine.rebuild();
    assert.equal(rebuilt.records, countBefore);
    assert.equal(engine.records.reduce((sum, record) => sum + record.billed, 0), billedBefore);
    assert.equal(engine.meta.dedupeSkipped, 1, "重建后去重口径不变");
  } finally {
    cleanup(agentDir);
  }
});

test("FR-4：临时会话记录落盘并标记 ephemeral（不写重复账本）", async () => {
  const agentDir = makeTempAgentDir();
  try {
    sessionDir(agentDir);
    const engine = makeEngine(agentDir);

    // 实时内存计数器已删除（FR-4.1~4.4）：用量一律经由账本呈现，内存里不得出现记录。
    assert.equal(engine.records.length, 0);

    const written = engine.persistEphemeral([
      {
        v: 1,
        fp: "aaaaaaaaaaaaaaaa",
        ts: 1789812001000,
        tsSource: "message",
        day: "2026-09-19",
        tz: "UTC",
        provider: "acme",
        model: "acme-1",
        api: null,
        kind: "assistant",
        toolName: null,
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        billed: 2,
        costUsd: 0.001,
        costUsdEst: null,
        sessionId: "sess-ephemeral",
        sessionFile: "(ephemeral)",
        entryId: "e1",
        cwd: null,
        project: "(unknown)",
        source: "pi",
        ephemeral: true,
      },
    ]);
    assert.equal(written, 1);
    assert.equal(engine.records.length, 1);
    assert.equal(engine.records[0]?.ephemeral, true);

    // 幂等：同一条再次落盘不新增（去重口径不变）。
    assert.equal(engine.persistEphemeral(engine.records), 0);
    assert.equal(engine.records.length, 1);
  } finally {
    cleanup(agentDir);
  }
});

test("NFR-4：锁串行化 —— 并发占用超时抛 LockTimeoutError，陈旧锁自动过期", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dataDir = path.join(agentDir, "pi-monitor");
    fs.mkdirSync(dataDir, { recursive: true });

    const release = acquireLock(dataDir);
    assert.throws(() => {
      acquireLock(dataDir, 120);
    }, LockTimeoutError);
    release();

    // 释放后可再次获取。
    const release2 = acquireLock(dataDir, 120);
    release2();

    // 陈旧锁（mtime > 10 s）可被抢占。
    const lockPath = path.join(dataDir, ".pi-monitor.lock");
    fs.writeFileSync(lockPath, "stale", "utf8");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    const release3 = acquireLock(dataDir, 500);
    release3();
  } finally {
    cleanup(agentDir);
  }
});

test("13 章：账本半行损坏 → 截断到最后一个完整记录并备份", async () => {
  const agentDir = makeTempAgentDir();
  try {
    sessionDir(agentDir);
    const engine = makeEngine(agentDir);
    const good = JSON.stringify({
      v: 1,
      fp: "1111111111111111",
      ts: 1789812001000,
      tsSource: "message",
      day: "2026-09-19",
      tz: "UTC",
      provider: "acme",
      model: "acme-1",
      api: null,
      kind: "assistant",
      toolName: null,
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      billed: 2,
      costUsd: 0.001,
      costUsdEst: null,
      sessionId: "s",
      sessionFile: "f",
      entryId: "e",
      cwd: null,
      project: "p",
      source: "pi",
      ephemeral: false,
    });
    fs.writeFileSync(engine.paths.ledger, `${good}\n{"v":1,"fp":"half`, "utf8");

    const result = readLedger(engine.paths.ledger);
    assert.equal(result.records.length, 1);
    assert.equal(result.repaired, 1);
    const backups = fs.readdirSync(engine.dataDir).filter((name) => name.includes("ledger.jsonl.bak-"));
    assert.equal(backups.length, 1, "必须备份原文件");
    assert.equal(fs.readFileSync(engine.paths.ledger, "utf8").endsWith("}\n"), true);
  } finally {
    cleanup(agentDir);
  }
});

test("T-6：时区变更后按当前时区重算日键并置 tzChanged", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dir = sessionDir(agentDir);
    // 2026-09-18T16:00:00.000Z → UTC 日 09-18；Asia/Shanghai 日 09-19。
    writeSessionFile(dir, "tz.jsonl", [
      assistantEntry({ id: "t1", iso: "2026-09-18T16:00:00.000Z", input: 1, output: 1, costTotal: 0.001 }),
    ]);

    const utcEngine = makeEngine(agentDir, { timezone: "utc" });
    await utcEngine.scan({});
    assert.equal(utcEngine.records[0]?.day, "2026-09-18");
    assert.equal(utcEngine.meta.tz, "UTC");
    assert.equal(utcEngine.meta.tzChanged, false);

    const shanghaiEngine = makeEngine(agentDir, { timezone: "Asia/Shanghai" });
    await shanghaiEngine.scan({});
    assert.equal(shanghaiEngine.records[0]?.day, "2026-09-19", "T-6：日键按当前时区重算");
    assert.equal(shanghaiEngine.meta.tz, "Asia/Shanghai");
    assert.equal(shanghaiEngine.meta.tzChanged, true, "健康面板需要提示可重建");
    assert.equal(shanghaiEngine.records[0]?.billed, 2, "重算日键不得改变用量");
  } finally {
    cleanup(agentDir);
  }
});
