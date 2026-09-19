/**
 * parser.test.ts — FR-1 会话日志发现与解析、4.2 口径、4.3 计数白名单、4.7 source、13 章。
 * 需求：AC-1.1~AC-1.4、C-1~C-3、$5、D-6、NFR-10、Q-5
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { normalizeProject } from "../../src/paths.ts";
import { emptyPricingTable } from "../../src/pricing.ts";
import { parseSessionFile, materializeRecords } from "../../src/scanner.ts";
import type { ParsedSession } from "../../src/parser.ts";
import { dayKey } from "../../src/time.ts";
import {
  assistantEntry,
  cleanup,
  loadExpected,
  makeTempAgentDir,
  parseFixture,
  fixturePath,
  writeSessionFile,
  type ExpectedFile,
} from "../helpers.ts";

const EXPECTED = loadExpected();

function assertStats(actual: ParsedSession, expected: ExpectedFile, label: string): void {
  const stats = actual.stats as unknown as Record<string, number>;
  for (const key of Object.keys(expected.stats) as (keyof ExpectedFile["stats"])[]) {
    assert.equal(stats[key], expected.stats[key], `${label} stats.${key}`);
  }
}

test("AC-1.1 全量解析与 expected-records.json 逐字段一致", async () => {
  for (const [name, expected] of Object.entries(EXPECTED.files)) {
    const parsed = await parseFixture(name);
    assert.equal(parsed.sessionId, expected.sessionId, `${name} sessionId`);
    assert.equal(parsed.cwd, expected.cwd, `${name} cwd`);
    assert.equal(parsed.source, expected.source, `${name} source`);
    assertStats(parsed, expected, name);
    assert.equal(parsed.records.length, expected.records.length, `${name} 记录条数`);
    assert.equal(parsed.valid, expected.stats.invalidSessions === 0, `${name} valid`);

    expected.records.forEach((want, index) => {
      const got = parsed.records[index];
      assert.ok(got, `${name}#${index} 缺少记录`);
      const label = `${name}#${index}`;
      assert.equal(new Date(got.ts).toISOString(), want.ts, `${label} ts`);
      assert.equal(got.tsSource, want.tsSource, `${label} tsSource`);
      assert.equal(got.entryId, want.entryId, `${label} entryId`);
      assert.equal(got.kind, want.kind, `${label} kind`);
      assert.equal(got.toolName, want.toolName, `${label} toolName`);
      assert.equal(got.provider, want.provider, `${label} provider`);
      assert.equal(got.model, want.model, `${label} model`);
      assert.equal(got.api, want.api, `${label} api`);
      assert.equal(got.input, want.input, `${label} input`);
      assert.equal(got.output, want.output, `${label} output`);
      assert.equal(got.cacheRead, want.cacheRead, `${label} cacheRead`);
      assert.equal(got.cacheWrite, want.cacheWrite, `${label} cacheWrite`);
      assert.equal(got.reasoning, want.reasoning, `${label} reasoning`);
      assert.equal(got.billed, want.billed, `${label} billed`);
      assert.equal(got.costUsd, want.costUsd, `${label} costUsd`);
      assert.equal(got.costUsdEst, want.costUsdEst, `${label} costUsdEst`);
      // T-2：期望日键由 ISO 时间戳与期望时区独立推导，不由被测实现生成。
      assert.equal(dayKey(got.ts, EXPECTED.tz), want.day, `${label} day`);
    });

    if (expected.cwd !== null && parsed.records.length > 0) {
      const records = materializeRecords(parsed, fixturePath(name), EXPECTED.tz);
      assert.equal(records.length, parsed.records.length);
      assert.equal(records[0]?.project, normalizeProject(expected.cwd, fixturePath(name)), `${name} project`);
    }
  }
});

test("AC-1.2 注入 3 条损坏行不改变有效记录，且 corruptLines == 3", async () => {
  const corrupted = await parseFixture("corrupt-lines.jsonl");
  assert.equal(corrupted.stats.corruptLines, 3);

  const agentDir = makeTempAgentDir();
  try {
    const dir = path.join(agentDir, "sessions", "--x--");
    fs.mkdirSync(dir, { recursive: true });
    const clean = writeSessionFile(dir, "clean.jsonl", [
      assistantEntry({ id: "k0000001", iso: "2026-09-19T16:00:01.000Z", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costTotal: 1 }),
    ]);
    const cleanParsed = await parseSessionFile(clean, emptyPricingTable());
    assert.equal(cleanParsed.stats.corruptLines, 0);
    assert.deepEqual(
      corrupted.records.map((record) => record.fp),
      cleanParsed.records.map((record) => record.fp),
    );
  } finally {
    cleanup(agentDir);
  }
});

test("AC-1.3 BOM / CRLF / 末行无换行三种文件均可解析", async () => {
  for (const name of ["bom.jsonl", "crlf.jsonl", "no-trailing-newline.jsonl"]) {
    const parsed = await parseFixture(name);
    assert.equal(parsed.stats.corruptLines, 0, `${name} 不应有损坏行`);
    assert.equal(parsed.stats.invalidSessions, 0, `${name} 不应是无效会话`);
    assert.equal(parsed.records.length, 1, `${name} 记录条数`);
  }
  // CRLF 文件确实包含 \r\n（防止 fixture 被编辑器改写为 LF）。
  const crlf = fs.readFileSync(fixturePath("crlf.jsonl"), "utf8");
  assert.ok(crlf.includes("\r\n"), "crlf.jsonl 必须包含 CRLF");
  const notrail = fs.readFileSync(fixturePath("no-trailing-newline.jsonl"), "utf8");
  assert.ok(!notrail.endsWith("\n"), "no-trailing-newline.jsonl 末行不得有换行");
  const bom = fs.readFileSync(fixturePath("bom.jsonl"), "utf8");
  assert.equal(bom.charCodeAt(0), 0xfeff, "bom.jsonl 必须带 BOM");
});

test("AC-1.4 未知 entry 类型不影响结果，且不报错（NFR-10）", async () => {
  const parsed = await parseFixture("unknown-entry-types.jsonl");
  assert.equal(parsed.stats.corruptLines, 0);
  assert.equal(parsed.stats.corruptUsage, 0);
  assert.equal(parsed.stats.unknownEntryTypes, 1);
  assert.equal(parsed.records.length, 1);
});

test("4.3 防坑条款：compaction.retainedTail[].usage 禁止计数", async () => {
  const parsed = await parseFixture("compaction-usage.jsonl");
  assert.equal(parsed.records.length, 2, "只应计入 assistant + compaction 自身 usage");
  assert.deepEqual(
    parsed.records.map((record) => record.kind),
    ["assistant", "compaction"],
  );
  const totalBilled = parsed.records.reduce((sum, record) => sum + record.billed, 0);
  assert.equal(totalBilled, 500, "retainedTail 的 39996 token 绝不能进入合计");
});

test("4.2 C-1/C-2/C-3：billed = 四分量之和，reasoning 不重复累加", async () => {
  const parsed = await parseFixture("normal-basic.jsonl");
  const [first] = parsed.records;
  assert.ok(first);
  assert.equal(first.billed, first.input + first.output + first.cacheRead + first.cacheWrite);
  assert.equal(first.billed, 1150);
  assert.equal(first.reasoning, 20, "reasoning 只作为信息字段保留");
});

test("C-3：totalTokens 不符时以四分量之和为准并计入 inconsistencyCount", async () => {
  const parsed = await parseFixture("inconsistent-total.jsonl");
  assert.equal(parsed.stats.inconsistencyCount, 1);
  assert.equal(parsed.records[0]?.billed, 200, "totalTokens=999 必须被忽略");
});

test("$5：负成本按 null 处理并计入 corruptCost", async () => {
  const parsed = await parseFixture("negative-cost.jsonl");
  assert.equal(parsed.stats.corruptCost, 1);
  assert.equal(parsed.records[0]?.costUsd, null);
});

test("13 章：usage 类型异常（字符串 / 非数字分量）丢弃该条并计入 corruptUsage", async () => {
  const parsed = await parseFixture("corrupt-usage.jsonl");
  assert.equal(parsed.stats.corruptUsage, 2);
  assert.equal(parsed.records.length, 0);
});

test("D-6：同一文件内重复 entry id 保留首条并计入 corruptDuplicateIds", async () => {
  const parsed = await parseFixture("duplicate-entry-id.jsonl");
  assert.equal(parsed.stats.corruptDuplicateIds, 1);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0]?.billed, 2, "保留首条（input+output = 2）");
});

test("Q-5：message.timestamp 缺失时回退行级时间并标记 tsSource entry", async () => {
  const parsed = await parseFixture("entry-ts-fallback.jsonl");
  assert.equal(parsed.records[0]?.tsSource, "entry");
  assert.equal(new Date(parsed.records[0].ts).toISOString(), "2026-09-19T09:00:01.000Z");
});

test("4.7：source 判定优先级（subagent > pi-web > pi-fork > pi）", async () => {
  assert.equal((await parseFixture("subagent-piweb.jsonl")).source, "pi-web:subagent");
  assert.equal((await parseFixture("piweb-custom.jsonl")).source, "pi-web");
  assert.equal((await parseFixture("fork-clone-copy.jsonl")).source, "pi-fork");
  assert.equal((await parseFixture("normal-basic.jsonl")).source, "pi");
});

test("FR-1.5：空文件 / 首行非 session 计为 invalidSessions", async () => {
  const empty = await parseFixture("empty.jsonl");
  assert.equal(empty.stats.invalidSessions, 1);
  assert.equal(empty.valid, false);
  assert.equal(empty.records.length, 0);

  const agentDir = makeTempAgentDir();
  try {
    const dir = path.join(agentDir, "sessions", "--y--");
    fs.mkdirSync(dir, { recursive: true });
    const bogus = path.join(dir, "bogus.jsonl");
    fs.writeFileSync(bogus, '{"type":"message","id":"a","message":{"role":"user","content":"hi"}}\n', "utf8");
    const parsed = await parseSessionFile(bogus, emptyPricingTable());
    assert.equal(parsed.stats.invalidSessions, 1);
    assert.equal(parsed.valid, false);
  } finally {
    cleanup(agentDir);
  }
});

test("FR-1.3：单行 > 4 MiB 视为损坏行", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const dir = path.join(agentDir, "sessions", "--z--");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "huge-line.jsonl");
    const header = '{"type":"session","version":3,"id":"s","timestamp":"2026-09-19T00:00:00.000Z","cwd":"D:\\\\x"}\n';
    fs.writeFileSync(file, `${header}{"type":"message","id":"a","pad":"${"x".repeat(4 * 1024 * 1024)}"}\n`, "utf8");
    const parsed = await parseSessionFile(file, emptyPricingTable());
    assert.equal(parsed.stats.corruptLines, 1);
    assert.equal(parsed.records.length, 0);
  } finally {
    cleanup(agentDir);
  }
});

test("AC-14.1 反向断言：账本记录字段集合是封闭的（7.3）", async () => {
  const parsed = await parseFixture("normal-basic.jsonl");
  const records = materializeRecords(parsed, fixturePath("normal-basic.jsonl"), "UTC");
  for (const record of records) {
    const keys = Object.keys(record).sort();
    assert.deepEqual(keys, [...EXPECTED_LEDGER_FIELDS].sort(), "账本字段必须与 7.3 完全一致");
  }
});

/** 7.3 的封闭字段集合（从 PRD 抄录，防止实现悄悄新增字段）。 */
const EXPECTED_LEDGER_FIELDS = [
  "v",
  "fp",
  "ts",
  "tsSource",
  "day",
  "tz",
  "provider",
  "model",
  "api",
  "kind",
  "toolName",
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "reasoning",
  "billed",
  "costUsd",
  "costUsdEst",
  "sessionId",
  "sessionFile",
  "entryId",
  "cwd",
  "project",
  "source",
  "ephemeral",
];
