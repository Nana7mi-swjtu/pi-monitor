/**
 * ledger.test.ts — 7.3 账本 schema 的读写一致性（AC-14.1）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { internRecord, projectRecord, readLedger, serializeRecord, writeFileAtomic } from "../../src/ledger.ts";
import { materializeRecords } from "../../src/scanner.ts";
import type { UsageRecord } from "../../src/types.ts";
import { cleanup, makeTempAgentDir, parseFixture, fixturePath } from "../helpers.ts";
import fs from "node:fs";
import path from "node:path";

async function sampleRecords(): Promise<UsageRecord[]> {
  const parsed = await parseFixture("normal-basic.jsonl");
  return materializeRecords(parsed, fixturePath("normal-basic.jsonl"), "UTC");
}

test("AC-14.1：手写序列化与 projectRecord 等价（字段集合与取值都一致）", async () => {
  const records = await sampleRecords();
  for (const record of records) {
    const manual = JSON.parse(serializeRecord(record)) as Record<string, unknown>;
    const projected = JSON.parse(JSON.stringify(projectRecord(record))) as Record<string, unknown>;
    assert.deepEqual(manual, projected, "serializeRecord 必须与 7.3 投影后完全一致");
    assert.deepEqual(Object.keys(manual), Object.keys(projected), "字段顺序也必须一致");
  }
});

test("AC-14.1：serializeRecord 丢弃未知字段（封闭集合）", async () => {
  const [base] = await sampleRecords();
  assert.ok(base);
  const polluted = { ...base, secretBody: "会话正文不应进入账本", extraField: 1 } as unknown as UsageRecord;
  const serialized = serializeRecord(polluted);
  assert.equal(serialized.includes("会话正文"), false);
  assert.equal(serialized.includes("extraField"), false);
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  assert.equal("secretBody" in parsed, false);
  assert.equal("extraField" in parsed, false);
  assert.deepEqual(Object.keys(parsed).sort(), Object.keys(projectRecord(base)).sort());
});

test("可空字段与布尔字段的序列化（null / true / false）", async () => {
  const records = await sampleRecords();
  const withNulls = records[1] as UsageRecord;
  const serialized = JSON.parse(serializeRecord(withNulls)) as Record<string, unknown>;
  assert.equal(serialized["toolName"], "read");
  assert.equal(serialized["provider"], null);
  assert.equal(serialized["ephemeral"], false);
  assert.equal(serialized["costUsdEst"], null);

  const ephemeral: UsageRecord = { ...withNulls, ephemeral: true, costUsd: null };
  const roundTripped = JSON.parse(serializeRecord(ephemeral)) as Record<string, unknown>;
  assert.equal(roundTripped["ephemeral"], true);
  assert.equal(roundTripped["costUsd"], null);
});

test("字符串驻留不改变记录取值，且共享同一字符串对象", () => {
  const records = [
    { provider: "acme", model: "acme-1", sessionFile: "C:\\a.jsonl" },
    { provider: "acme", model: "acme-1", sessionFile: "C:\\a.jsonl" },
  ] as unknown as UsageRecord[];
  for (const record of records) internRecord(record);
  assert.equal(records[0]?.provider, "acme");
  assert.equal(records[1]?.provider, "acme");
  assert.equal(records[0]?.sessionFile, records[1]?.sessionFile, "同一值必须共享同一字符串");
});

test("13 章：账本半行损坏 → 截断 + 备份；未知字段在读取时被丢弃", async () => {
  const agentDir = makeTempAgentDir();
  try {
    const ledgerPath = path.join(agentDir, "ledger.jsonl");
    const records = await sampleRecords();
    const good = serializeRecord(records[0] as UsageRecord);
    const withUnknown = `${JSON.stringify({ ...JSON.parse(good), unknownField: "x" })}\n`;
    writeFileAtomic(ledgerPath, `${good}\n${withUnknown}{"v":1,"fp":`);

    const result = readLedger(ledgerPath);
    assert.equal(result.repaired, 1);
    assert.equal(result.records.length, 2);
    for (const record of result.records) {
      assert.equal("unknownField" in (record as unknown as Record<string, unknown>), false);
    }
    const backups = fs.readdirSync(agentDir).filter((name) => name.includes(".bak-"));
    assert.equal(backups.length, 1);
  } finally {
    cleanup(agentDir);
  }
});
