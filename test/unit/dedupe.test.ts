/**
 * dedupe.test.ts — 4.4（D-1~D-6）、FR-3、AC-3.1、AC-3.3、AC-3.2（明细可审计）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { dedupeRecords, fingerprintOf } from "../../src/dedupe.ts";
import { materializeRecords, parseSessionFile } from "../../src/scanner.ts";
import { emptyPricingTable } from "../../src/pricing.ts";
import type { UsageRecord } from "../../src/types.ts";
import { fixturePath, parseFixture } from "../helpers.ts";

interface DedupeInputShape {
  fp: string;
  ts: number;
  entryId: string;
  sessionFile: string;
}

test("D-1：指纹为 sha1 前 16 位十六进制，只覆盖用量字段（D-4）", () => {
  const base = {
    entryId: "e1",
    ts: 1789812001000,
    provider: "acme",
    model: "acme-1",
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
  };
  const fp = fingerprintOf(base);
  assert.match(fp, /^[0-9a-f]{16}$/);
  assert.equal(fp, fingerprintOf({ ...base }), "同输入必须同指纹");
  assert.notEqual(fp, fingerprintOf({ ...base, input: 2 }));
  assert.notEqual(fp, fingerprintOf({ ...base, output: 3 }));
  assert.notEqual(fp, fingerprintOf({ ...base, cacheRead: 4 }));
  assert.notEqual(fp, fingerprintOf({ ...base, cacheWrite: 5 }));
  assert.notEqual(fp, fingerprintOf({ ...base, ts: base.ts + 1 }));
  assert.notEqual(fp, fingerprintOf({ ...base, entryId: "e2" }));
  assert.notEqual(fp, fingerprintOf({ ...base, provider: "other" }));
  assert.notEqual(fp, fingerprintOf({ ...base, model: "other" }));
  // D-4：正文变化不影响指纹。
  const withBody = { ...base, body: "totally different text" } as typeof base;
  assert.equal(fingerprintOf(withBody), fp);
});

test("AC-3.1：父会话 + forkFrom 原样复制 → 总量等于父会话总量", async () => {
  const parentParsed = await parseFixture("fork-source.jsonl");
  const cloneParsed = await parseFixture("fork-clone-copy.jsonl");
  const parent = materializeRecords(parentParsed, fixturePath("fork-source.jsonl"), "UTC");
  const clone = materializeRecords(cloneParsed, fixturePath("fork-clone-copy.jsonl"), "UTC");

  assert.equal(parent.length, 2);
  assert.equal(clone.length, 3);

  const result = dedupeRecords<UsageRecord>([...parent, ...clone], "fingerprint");
  const parentBilled = parent.reduce((sum, record) => sum + record.billed, 0);
  const dedupedBilled = result.records.reduce((sum, record) => sum + record.billed, 0);

  assert.equal(dedupedBilled, parentBilled + 10, "父会话总量 + 克隆新增的 1 条（billed 10）");
  assert.equal(result.skipped.length, 2, "AC-3.1：dedupeSkipped == 复制的 usage 条数");
  assert.equal(new Set(result.records.map((record) => record.fp)).size, result.records.length, "D-2：fp 唯一");
});

test("D-2：首见者胜（按 ts 升序，再按文件路径字典序），且不被静默丢弃（D-3）", () => {
  const records: DedupeInputShape[] = [
    { fp: "aaaa", ts: 200, entryId: "b", sessionFile: "C:\\z.jsonl" },
    { fp: "aaaa", ts: 100, entryId: "a", sessionFile: "C:\\a.jsonl" },
    { fp: "bbbb", ts: 300, entryId: "c", sessionFile: "C:\\a.jsonl" },
  ];
  const result = dedupeRecords(records, "fingerprint");
  assert.deepEqual(result.records.map((record) => record.entryId), ["a", "c"]);
  assert.equal(result.skipped.length, 1);
  assert.deepEqual(result.skipped[0], {
    fp: "aaaa",
    entryId: "b",
    ts: 200,
    keptFile: "C:\\a.jsonl",
    skippedFile: "C:\\z.jsonl",
  });
});

test("AC-3.3 / D-5：dedupe:off 时总量等于文件求和", async () => {
  const parentParsed = await parseFixture("fork-source.jsonl");
  const cloneParsed = await parseFixture("fork-clone-copy.jsonl");
  const parent = materializeRecords(parentParsed, fixturePath("fork-source.jsonl"), "UTC");
  const clone = materializeRecords(cloneParsed, fixturePath("fork-clone-copy.jsonl"), "UTC");
  const combined = [...parent, ...clone];
  const result = dedupeRecords(combined, "off");
  assert.equal(result.records.length, combined.length);
  assert.equal(result.skipped.length, 0);
});

test("D-6：同文件重复 entry id 在解析阶段即被剔除（保留首条）", async () => {
  const parsed = await parseSessionFile(fixturePath("duplicate-entry-id.jsonl"), emptyPricingTable());
  assert.equal(parsed.stats.corruptDuplicateIds, 1);
  assert.equal(parsed.records.length, 1);
});
