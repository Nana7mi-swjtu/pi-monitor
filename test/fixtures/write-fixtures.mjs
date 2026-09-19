/**
 * write-fixtures.mjs — 会话 fixture 生成器（16.2 必须存在的 fixture 会话）。
 *
 * 说明：fixture 是**输入数据**，由本脚本一次性写入 `test/fixtures/sessions/`。
 * 生成物已提交到仓库；本脚本仅用于保证 BOM / CRLF / 无尾换行 / 空文件等字节级细节可复现。
 * 期望输出（`test/fixtures/expected-records.json`）是**人工校对**的，不由本脚本生成（P-6）。
 *
 * 用法：node test/fixtures/write-fixtures.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "sessions", "--D--fixtures--");
fs.mkdirSync(dir, { recursive: true });

/** ISO → epoch ms（避免手写魔数出错；fixture 内 message.timestamp 恒等于 ISO 字符串）。 */
const ms = (iso) => Date.parse(iso);
const line = (value) => `${typeof value === "string" ? value : JSON.stringify(value)}\n`;

const files = {};

/** 通用的 assistant usage 记录构造器（所有 fixture 共用，保证字段齐全）。 */
function assistantMessage(options) {
  const {
    id,
    iso,
    input,
    output,
    cacheRead = 0,
    cacheWrite = 0,
    reasoning = 0,
    totalTokens,
    costTotal,
    provider = "acme",
    model = "acme-1",
    api = "openai-completions",
    parentId = null,
  } = options;
  const usage = {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    totalTokens: totalTokens ?? input + output + cacheRead + cacheWrite,
  };
  if (costTotal !== undefined) {
    usage.cost = {
      input: costTotal,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: costTotal,
    };
  }
  return {
    type: "message",
    id,
    parentId,
    timestamp: iso,
    message: {
      role: "assistant",
      api,
      provider,
      model,
      usage,
      stopReason: "stop",
      timestamp: ms(iso),
    },
  };
}

const header = (id, iso, cwd) =>
  JSON.stringify({ type: "session", version: 3, id, timestamp: iso, cwd });

// 1) normal-basic.jsonl —— assistant + toolResult usage（4.3 主来源）
files["normal-basic.jsonl"] =
  line(header("sess-normal", "2026-09-19T10:00:00.000Z", "D:\\fixtures\\proj-normal")) +
  line({
    type: "message",
    id: "n0000001",
    parentId: null,
    timestamp: "2026-09-19T10:00:01.000Z",
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "acme",
      model: "acme-1",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 1000,
        cacheWrite: 0,
        reasoning: 20,
        totalTokens: 1150,
        cost: { input: 0.000015, output: 0.00003, cacheRead: 0.000003, cacheWrite: 0, total: 0.000048 },
      },
      stopReason: "toolUse",
      timestamp: ms("2026-09-19T10:00:01.000Z"),
    },
  }) +
  line({
    type: "message",
    id: "n0000002",
    parentId: "n0000001",
    timestamp: "2026-09-19T10:00:02.000Z",
    message: {
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 15,
        cost: { input: 0.0000015, output: 0.000003, cacheRead: 0, cacheWrite: 0, total: 0.0000045 },
      },
      timestamp: ms("2026-09-19T10:00:02.000Z"),
    },
  });

// 2) cache-heavy.jsonl —— 大 cacheRead / cacheWrite
files["cache-heavy.jsonl"] =
  line(header("sess-cache", "2026-09-19T11:00:00.000Z", "D:\\fixtures\\proj-cache")) +
  line(
    assistantMessage({
      id: "c0000001",
      iso: "2026-09-19T11:00:00.000Z",
      input: 10,
      output: 10,
      cacheRead: 500000,
      cacheWrite: 200000,
      reasoning: 5,
      totalTokens: 700020,
      costTotal: 0.02,
    }),
  );

// 3) no-cost.jsonl —— 验证 $3 / ¥7（未知成本 → 两个字段均为 null）
files["no-cost.jsonl"] =
  line(header("sess-nocost", "2026-09-19T12:00:00.000Z", "D:\\fixtures\\proj-nocost")) +
  line(
    assistantMessage({
      id: "z0000001",
      iso: "2026-09-19T12:00:00.000Z",
      input: 1000,
      output: 1000,
      model: "acme-unpriced",
    }),
  );

// 4) compaction-usage.jsonl —— 4.3 防坑条款：retainedTail[].usage 禁止计数
files["compaction-usage.jsonl"] =
  line(header("sess-compaction", "2026-09-19T13:00:00.000Z", "D:\\fixtures\\proj-compaction")) +
  line(
    assistantMessage({
      id: "p0000001",
      iso: "2026-09-19T13:00:01.000Z",
      input: 100,
      output: 100,
      costTotal: 0.000075,
    }),
  ) +
  line({
    type: "compaction",
    id: "p0000002",
    parentId: "p0000001",
    timestamp: "2026-09-19T13:00:02.000Z",
    summary: "compact",
    tokensBefore: 200,
    usage: {
      input: 200,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 300,
      cost: { input: 0.00003, output: 0.00006, cacheRead: 0, cacheWrite: 0, total: 0.00009 },
    },
    retainedTail: [
      {
        role: "assistant",
        content: [{ type: "text", text: "kept" }],
        provider: "acme",
        model: "acme-1",
        usage: {
          input: 9999,
          output: 9999,
          cacheRead: 9999,
          cacheWrite: 9999,
          reasoning: 0,
          totalTokens: 39996,
          cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, total: 4 },
        },
        stopReason: "stop",
        timestamp: ms("2026-09-19T13:00:03.000Z"),
      },
    ],
  });

// 5) branch-summary-usage.jsonl
files["branch-summary-usage.jsonl"] =
  line(header("sess-branch", "2026-09-19T14:00:00.000Z", "D:\\fixtures\\proj-branch")) +
  line({
    type: "branch_summary",
    id: "b0000001",
    parentId: null,
    timestamp: "2026-09-19T14:00:01.000Z",
    fromId: "x",
    summary: "branch",
    usage: {
      input: 300,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      totalTokens: 500,
      cost: { input: 0.000045, output: 0.00012, cacheRead: 0, cacheWrite: 0, total: 0.000165 },
    },
  });

// 6) fork-source.jsonl + fork-clone-copy.jsonl —— D-1~D-3（forkFrom 原样复制）
const forkEntry1 = assistantMessage({
  id: "f0000001",
  iso: "2026-09-19T15:00:01.000Z",
  input: 111,
  output: 222,
  costTotal: 0.00014985,
});
const forkEntry2 = assistantMessage({
  id: "f0000002",
  iso: "2026-09-19T15:00:02.000Z",
  input: 7,
  output: 3,
  costTotal: 0.00000285,
  parentId: "f0000001",
});
files["fork-source.jsonl"] =
  line(header("sess-fork-source", "2026-09-19T15:00:00.000Z", "D:\\fixtures\\proj-fork")) +
  line(forkEntry1) +
  line(forkEntry2);

files["fork-clone-copy.jsonl"] =
  line(
    JSON.stringify({
      type: "session",
      version: 3,
      id: "sess-fork-clone",
      timestamp: "2026-09-19T15:05:00.000Z",
      cwd: "D:\\fixtures\\proj-fork",
      parentSession: "D:\\fixtures\\sessions\\--D--fixtures--\\fork-source.jsonl",
    }),
  ) +
  line(forkEntry1) +
  line(forkEntry2) +
  line(
    assistantMessage({
      id: "f0000003",
      iso: "2026-09-19T15:05:03.000Z",
      input: 5,
      output: 5,
      costTotal: 0.00000375,
      parentId: "f0000002",
    }),
  );

// 7) corrupt-lines.jsonl（3 条损坏行 + 1 条有效记录）
files["corrupt-lines.jsonl"] =
  line(header("sess-corrupt", "2026-09-19T16:00:00.000Z", "D:\\fixtures\\proj-corrupt")) +
  line("not json at all") +
  line("[1,2,3]") +
  line('{"nope":true}') +
  line(assistantMessage({ id: "k0000001", iso: "2026-09-19T16:00:01.000Z", input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costTotal: 1 }));

// 8) bom.jsonl（UTF-8 BOM）
files["bom.jsonl"] =
  "\uFEFF" +
  line(header("sess-bom", "2026-09-19T16:30:00.000Z", "D:\\fixtures\\proj-bom")) +
  line(assistantMessage({ id: "m0000001", iso: "2026-09-19T16:30:01.000Z", input: 11, output: 22, cacheRead: 33, cacheWrite: 44, costTotal: 1.1 }));

// 9) crlf.jsonl（CRLF 行尾，由下面的转换步骤生成）
files["crlf.jsonl"] =
  line(header("sess-crlf", "2026-09-19T17:00:00.000Z", "D:\\fixtures\\proj-crlf")) +
  line(assistantMessage({ id: "r0000001", iso: "2026-09-19T17:00:01.000Z", input: 12, output: 34, cacheRead: 56, cacheWrite: 78, costTotal: 1.8 }));

// 10) no-trailing-newline.jsonl（末行无换行）
files["no-trailing-newline.jsonl"] = (
  line(header("sess-notrail", "2026-09-19T17:30:00.000Z", "D:\\fixtures\\proj-notrail")) +
  line(assistantMessage({ id: "t0000001", iso: "2026-09-19T17:30:01.000Z", input: 13, output: 35, cacheRead: 57, cacheWrite: 79, costTotal: 1.84 }))
).replace(/\n$/, "");

// 11) unknown-entry-types.jsonl（NFR-10 / AC-1.4）
files["unknown-entry-types.jsonl"] =
  line(header("sess-unknown", "2026-09-19T18:00:00.000Z", "D:\\fixtures\\proj-unknown")) +
  line('{"type":"future_thing","id":"u0000000","parentId":null,"timestamp":"2026-09-19T18:00:00.500Z","payload":{"x":1}}') +
  line({
    type: "model_change",
    id: "u0000001",
    parentId: null,
    timestamp: "2026-09-19T18:00:00.600Z",
    provider: "acme",
    modelId: "acme-1",
  }) +
  line(assistantMessage({ id: "u0000002", iso: "2026-09-19T18:00:01.000Z", input: 9, output: 8, cacheRead: 7, cacheWrite: 6, costTotal: 0.3, parentId: "u0000001" }));

// 12) tz-boundary.jsonl（UTC 与 Asia/Shanghai 两套断言）
files["tz-boundary.jsonl"] =
  line(header("sess-tz", "2026-09-18T15:59:00.000Z", "D:\\fixtures\\proj-tz")) +
  line(assistantMessage({ id: "w0000001", iso: "2026-09-18T15:59:59.999Z", input: 1, output: 1, costTotal: 0.00000075 })) +
  line(assistantMessage({ id: "w0000002", iso: "2026-09-18T16:00:00.000Z", input: 2, output: 2, costTotal: 0.0000015, parentId: "w0000001" }));

// 13) subagent-piweb.jsonl（4.7 source 判定优先级 1）
files["subagent-piweb.jsonl"] =
  line(header("sess-subagent", "2026-09-19T19:00:00.000Z", "D:\\fixtures\\proj-subagent")) +
  line('{"type":"custom","id":"g0000000","parentId":null,"timestamp":"2026-09-19T19:00:00.100Z","customType":"pi-web:subagent","data":{"ignored":true}}') +
  line(assistantMessage({ id: "g0000001", iso: "2026-09-19T19:00:01.000Z", input: 4, output: 4, costTotal: 0.000003, parentId: "g0000000" }));

// 14) piweb-custom.jsonl（4.7 优先级 2：pi-web 前缀但不是 subagent）
files["piweb-custom.jsonl"] =
  line(header("sess-piweb", "2026-09-19T19:30:00.000Z", "D:\\fixtures\\proj-piweb")) +
  line('{"type":"custom","id":"h0000000","parentId":null,"timestamp":"2026-09-19T19:30:00.100Z","customType":"pi-web:tool-selection","data":{"version":1,"tools":["read"]}}') +
  line(assistantMessage({ id: "h0000001", iso: "2026-09-19T19:30:01.000Z", input: 6, output: 6, costTotal: 0.0000045, parentId: "h0000000" }));

// 15) legacy-v1.jsonl / legacy-v2.jsonl（兼容性矩阵：v1/v2/v3）
for (const [name, version, id, iso] of [
  ["legacy-v1.jsonl", 1, "sess-legacy-v1", "2026-09-20T00:00:01.000Z"],
  ["legacy-v2.jsonl", 2, "sess-legacy-v2", "2026-09-20T01:00:01.000Z"],
]) {
  files[name] =
    line(JSON.stringify({ type: "session", version, id, timestamp: iso, cwd: "D:\\fixtures\\proj-legacy" })) +
    line(assistantMessage({ id: `l${version}000001`, iso, input: 20, output: 30, cacheRead: 40, cacheWrite: 50, costTotal: 1.4 }));
}

// 16) empty.jsonl（0 字节）与 session-only.jsonl（仅文件头）
files["empty.jsonl"] = "";
files["session-only.jsonl"] = line(header("sess-session-only", "2026-09-19T20:00:00.000Z", "D:\\fixtures\\proj-session-only"));

// 17) huge-usage.jsonl（大数与溢出边界；保持 < Number.MAX_SAFE_INTEGER）
files["huge-usage.jsonl"] =
  line(header("sess-huge", "2026-09-19T21:00:00.000Z", "D:\\fixtures\\proj-huge")) +
  line(assistantMessage({ id: "q0000001", iso: "2026-09-19T21:00:01.000Z", input: 1000000000000000, output: 1000000000000000, costTotal: 0.75 }));

// 18) negative-cost.jsonl（$5：负成本按 null 处理 + 计数）
files["negative-cost.jsonl"] =
  line(header("sess-negative", "2026-09-19T22:00:00.000Z", "D:\\fixtures\\proj-negative")) +
  line(assistantMessage({ id: "v0000001", iso: "2026-09-19T22:00:01.000Z", input: 100, output: 100, costTotal: -1 }));

// 19) mixed-currency.jsonl（M-3 / M-4 与 `—` 展示）
files["mixed-currency.jsonl"] =
  line(header("sess-mixed", "2026-09-19T23:00:00.000Z", "D:\\fixtures\\proj-mixed")) +
  line(assistantMessage({ id: "x0000001", iso: "2026-09-19T23:00:01.000Z", input: 100, output: 0, costTotal: 0.000015 })) +
  line(assistantMessage({ id: "x0000002", iso: "2026-09-19T23:00:02.000Z", input: 100, output: 0, model: "acme-unpriced", parentId: "x0000001" }));

// 20) inconsistent-total.jsonl（C-3 一致性校验）
files["inconsistent-total.jsonl"] =
  line(header("sess-inconsistent", "2026-09-19T23:30:00.000Z", "D:\\fixtures\\proj-inconsistent")) +
  line(assistantMessage({ id: "y0000001", iso: "2026-09-19T23:30:01.000Z", input: 100, output: 100, totalTokens: 999, costTotal: 0.000075 }));

// 21) duplicate-entry-id.jsonl（D-6）
files["duplicate-entry-id.jsonl"] =
  line(header("sess-dup", "2026-09-19T23:40:00.000Z", "D:\\fixtures\\proj-dup")) +
  line(assistantMessage({ id: "d0000001", iso: "2026-09-19T23:40:01.000Z", input: 1, output: 1, costTotal: 0.01 })) +
  line(assistantMessage({ id: "d0000001", iso: "2026-09-19T23:40:02.000Z", input: 2, output: 2, costTotal: 0.02, parentId: "d0000001" }));

// 22) corrupt-usage.jsonl（13 章：usage 类型异常 → 丢弃该条）
files["corrupt-usage.jsonl"] =
  line(header("sess-badusage", "2026-09-19T23:50:00.000Z", "D:\\fixtures\\proj-badusage")) +
  line('{"type":"message","id":"e0000001","parentId":null,"timestamp":"2026-09-19T23:50:01.000Z","message":{"role":"assistant","provider":"acme","model":"acme-1","usage":"not-an-object","stopReason":"stop","timestamp":' + ms("2026-09-19T23:50:01.000Z") + "}}") +
  line('{"type":"message","id":"e0000002","parentId":"e0000001","timestamp":"2026-09-19T23:50:02.000Z","message":{"role":"assistant","provider":"acme","model":"acme-1","usage":{"input":"abc","output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":5,"cost":{"total":0.001}},"stopReason":"stop","timestamp":' + ms("2026-09-19T23:50:02.000Z") + "}}");

// 23) entry-ts-fallback.jsonl（Q-5：message.timestamp 缺失 → tsSource "entry"）
files["entry-ts-fallback.jsonl"] =
  line(header("sess-entryts", "2026-09-19T09:00:00.000Z", "D:\\fixtures\\proj-entryts")) +
  line({
    type: "message",
    id: "j0000001",
    parentId: null,
    timestamp: "2026-09-19T09:00:01.000Z",
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: "acme",
      model: "acme-1",
      usage: {
        input: 5,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 10,
        cost: { input: 0.00000075, output: 0.0000015, cacheRead: 0, cacheWrite: 0, total: 0.00000375 },
      },
      stopReason: "stop",
    },
  });

// 写入：默认 LF；对 crlf.jsonl 做 CRLF 转换。
for (const [name, content] of Object.entries(files)) {
  const target = path.join(dir, name);
  const body = name === "crlf.jsonl" ? content.replace(/\n/g, "\r\n") : content;
  fs.writeFileSync(target, body, "utf8");
}

process.stdout.write(`wrote ${Object.keys(files).length} fixture files to ${dir}\n`);
