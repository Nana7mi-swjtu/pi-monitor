/**
 * extension.test.ts — 契约测试：命令 / 工具 / 事件 / 通道约束。
 * 需求：FR-4、FR-6（AC-6.2/6.3/6.5/6.6/6.7/6.9）、FR-7（AC-7.1~AC-7.5）、
 *       FR-15（AC-15.1~AC-15.4）、NFR-5
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import extension from "../../extensions/pi-monitor/index.ts";
import { cleanup, makeTempAgentDir, writeSessionFile, assistantEntry, projectRoot } from "../helpers.ts";

const RUNTIME_KEY = "__piMonitorRuntime_v1__";

interface RuntimeHandle {
  engine: {
    scan: (options?: Record<string, unknown>) => Promise<unknown>;
    records: Array<{ billed: number }>;
    meta: { revision: number };
    paths: { ledger: string };
    config: { currency: { rate: number; rateSource: string; autoRate: boolean; rateFetchedAt: string | null } };
  };
  /** ¥8：由接口注入的汇率请求实现（测试用）。 */
  context: { rateFetcher?: typeof fetch };
  server: {
    info: { port: number; pid: number; url: string; token: string; startedAt: string } | null;
    stop: () => Promise<void>;
  } | null;
}

interface MockPi {
  api: ExtensionAPI;
  tools: Map<string, Record<string, any>>;
  commands: Map<string, Record<string, any>>;
  events: Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<unknown>>>;
  messages: Array<{ content: string; customType: string; display: boolean }>;
  execCalls: Array<{ command: string; args: string[] }>;
  execBehaviour: "ok" | "throw" | "nonzero";
}

interface MockUi {
  calls: Array<{ kind: string; message: string; type?: string }>;
}

function makeMockPi(): MockPi {
  const mock: MockPi = {
    api: null as unknown as ExtensionAPI,
    tools: new Map(),
    commands: new Map(),
    events: new Map(),
    messages: [],
    execCalls: [],
    execBehaviour: "ok",
  };
  mock.api = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown>) {
      const list = mock.events.get(event) ?? [];
      list.push(handler);
      mock.events.set(event, list);
    },
    registerTool(definition: Record<string, unknown>) {
      mock.tools.set(String(definition["name"]), definition as Record<string, any>);
    },
    registerCommand(name: string, options: Record<string, unknown>) {
      mock.commands.set(name, options as Record<string, any>);
    },
    sendMessage(message: Record<string, unknown>) {
      mock.messages.push({
        content: String(message["content"]),
        customType: String(message["customType"]),
        display: Boolean(message["display"]),
      });
    },
    async exec(command: string, args: string[]) {
      mock.execCalls.push({ command, args });
      if (mock.execBehaviour === "throw") throw new Error("spawn ENOENT");
      return { code: mock.execBehaviour === "nonzero" ? 4 : 0, stdout: "", stderr: "" };
    },
  } as unknown as ExtensionAPI;
  return mock;
}

function makeMockContext(options: { hasUI: boolean; mode?: string; sessionId?: string; sessionFile?: string | null }): {
  ctx: ExtensionContext;
  ui: MockUi;
} {
  const ui: MockUi = { calls: [] };
  const ctx = {
    hasUI: options.hasUI,
    mode: options.mode ?? "rpc",
    cwd: process.cwd(),
    model: { provider: "acme", id: "acme-1" },
    sessionManager: {
      getSessionId: () => options.sessionId ?? "sess-contract",
      getSessionFile: () => (options.sessionFile === undefined ? null : options.sessionFile),
    },
    ui: {
      notify(message: string, type?: string) {
        ui.calls.push({ kind: "notify", message, type });
      },
    },
  } as unknown as ExtensionContext;
  return { ctx, ui };
}

interface Scenario {
  agentDir: string;
  mock: MockPi;
  runtime: RuntimeHandle;
  dispose: () => void;
}

async function boot(options: { config?: Record<string, unknown>; sessions?: Array<{ name: string; entries: unknown[] }> } = {}): Promise<Scenario> {
  const agentDir = makeTempAgentDir();
  const dataDir = path.join(agentDir, "pi-monitor");
  fs.mkdirSync(dataDir, { recursive: true });
  // 契约测试必须可离线运行：默认关掉自动汇率（¥8），否则每次 /tokens 都会真的联网。
  // 自动汇率本身的取数/降级由 test/unit/rates.test.ts 与 test/integration/server.test.ts 用注入 fetcher 覆盖。
  const config = { currency: { autoRate: false }, ...(options.config ?? {}) };
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config, null, 2), "utf8");
  if (options.sessions !== undefined) {
    const dir = path.join(agentDir, "sessions", "--proj--");
    fs.mkdirSync(dir, { recursive: true });
    for (const session of options.sessions) writeSessionFile(dir, session.name, session.entries);
  }

  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  delete (globalThis as unknown as Record<string, unknown>)[RUNTIME_KEY];

  const mock = makeMockPi();
  extension(mock.api);
  const runtime = (globalThis as unknown as Record<string, unknown>)[RUNTIME_KEY] as RuntimeHandle;

  return {
    agentDir,
    mock,
    runtime,
    dispose: () => {
      delete (globalThis as unknown as Record<string, unknown>)[RUNTIME_KEY];
      delete process.env["PI_CODING_AGENT_DIR"];
      cleanup(agentDir);
      if (runtime.server !== null) runtime.server = null;
    },
  };
}

test("AC-15.3：只注册 `tokens` 一个命令；tool.enabled:false 时不注册 token_stats", async () => {  const enabled = await boot();
  try {
    assert.deepEqual([...enabled.mock.commands.keys()], ["tokens"]);
    assert.deepEqual([...enabled.mock.tools.keys()], ["token_stats"]);
    const definition = enabled.mock.tools.get("token_stats");
    assert.equal(definition?.["name"], "token_stats");
    assert.ok(definition?.["parameters"], "工具必须声明 typebox 参数 schema");
  } finally {
    enabled.dispose();
  }

  const disabled = await boot({ config: { tool: { enabled: false } } });
  try {
    assert.deepEqual([...disabled.mock.commands.keys()], ["tokens"]);
    assert.equal(disabled.mock.tools.has("token_stats"), false, "AC-15.3：禁用时不得有残留注册");
  } finally {
    disabled.dispose();
  }
});

test("AC-15.1：扩展入口不出现 TUI 专属 API（custom / setStatus / setWidget / setFooter / pi-tui）", () => {
  const source = stripComments(
    fs.readFileSync(path.join(process.cwd(), "extensions", "pi-monitor", "index.ts"), "utf8"),
  );
  for (const forbidden of [
    "ctx.ui.custom",
    "setStatus",
    "setWidget",
    "setFooter",
    "pi-tui",
    "registerEntryRenderer",
    "registerMessageRenderer",
    "appendEntry",
  ]) {
    assert.equal(source.includes(forbidden), false, `index.ts 不得出现 ${forbidden}`);
  }
  // 11 章：`src/**` 禁止 import 宿主包，宿主依赖只允许出现在 index.ts 的显式 import 中。
  for (const file of walkTypeScript(path.join(process.cwd(), "src"))) {
    const body = stripComments(fs.readFileSync(file, "utf8"));
    assert.equal(/@earendil-works\//.test(body), false, `${file} 不得 import 宿主包`);
  }
});

/** 去掉注释后再做静态约束检查（避免把「禁止项」的说明文字本身当作违规）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTypeScript(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("¥8：`/tokens` 启动仪表盘时在后台按需获取汇率（且不阻塞命令返回）", async () => {
  // 源码级断言：联网取汇率必须由 `refreshAutoRate` 统一把关（开关、TTL、降级都在其中）。
  const source = fs.readFileSync(path.join(projectRoot, "extensions", "pi-monitor", "index.ts"), "utf8");
  assert.match(source, /refreshAutoRate\(runtime\.context/, "extension 必须在 /tokens 流程里接入自动汇率");
  assert.match(source, /void refreshAutoRate/, "必须 fire-and-forget（AC-6.8：命令不阻塞）");

  // 行为级断言（注入 fetcher，无真实网络）：开启 autoRate 后一次 /tokens 会取一次汇率。
  const scenario = await boot({ config: { currency: { autoRate: true } } });
  try {
    let calls = 0;
    scenario.runtime.context.rateFetcher = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ rates: { CNY: 6.7 } }), { status: 200 });
    }) as typeof fetch;
    const { ctx } = makeMockContext({ hasUI: true, mode: "rpc" });
    await scenario.mock.commands.get("tokens")?.handler("--no-open", ctx);
    assert.ok(scenario.runtime.server?.info, "服务必须已启动");
    await scenario.runtime.server?.stop();
    // 自动汇率是 fire-and-forget（AC-6.8），给它几个 tick 落地。
    for (let index = 0; index < 50 && calls === 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(calls, 1, "关闭前只允许取 1 次");
    assert.equal(scenario.runtime.engine.config.currency.rateSource, "auto");
    assert.equal(scenario.runtime.engine.config.currency.rate, 6.7);
  } finally {
    scenario.dispose();
  }
});

test("AC-6.9 / AC-15.2：无 UI 模式下静默返回，不调用任何 ctx.ui.*", async () => {
  const scenario = await boot();
  try {
    const { ctx, ui } = makeMockContext({ hasUI: false, mode: "json" });
    await scenario.mock.commands.get("tokens")?.handler("", ctx);
    assert.deepEqual(ui.calls, [], "不得调用 ctx.ui.*");
    assert.equal(scenario.mock.execCalls.length, 0, "不得打开浏览器");
    assert.equal(scenario.runtime.server, null, "不得启动服务");
    assert.equal(scenario.mock.messages.length, 0, "不得注入会话消息");
  } finally {
    scenario.dispose();
  }
});

test("AC-6.5：linkMessage:true 时新增且仅新增 1 条 ≤300 字符的链接消息；false 时 0 条", async () => {
  const scenario = await boot();
  try {
    const { ctx } = makeMockContext({ hasUI: true, mode: "rpc" });
    await scenario.mock.commands.get("tokens")?.handler("--no-open", ctx);
    assert.equal(scenario.mock.messages.length, 1);
    const message = scenario.mock.messages[0];
    assert.ok(message);
    assert.equal(message.customType, "pi-monitor:link");
    assert.equal(message.display, true);
    assert.ok(message.content.length <= 300, `长度 ${message.content.length}`);
    await scenario.runtime.server || undefined;
  } finally {
    await scenario.runtime.server?.stop();
    scenario.dispose();
  }
});

test("AC-6.3：浏览器打不开时命令成功返回，提示中含完整 URL", async () => {
  const scenario = await boot();
  try {
    scenario.mock.execBehaviour = "throw";
    const { ctx, ui } = makeMockContext({ hasUI: true, mode: "rpc" });
    await scenario.mock.commands.get("tokens")?.handler("", ctx);
    const url = scenario.runtime.server?.info?.url ?? "";
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]{32}$/);
    const texts = ui.calls.map((call) => call.message);
    assert.ok(
      texts.some((text) => text.includes(url)),
      "必须提示完整 URL",
    );
    assert.equal(texts.some((text) => text.toLowerCase().includes("error")), false, "不得报错");
  } finally {
    await scenario.runtime.server?.stop();
    scenario.dispose();
  }
});

test("AC-6.6 / AC-6.7：非法参数只提示一行、不抛异常、不产生报表", async () => {
  const scenario = await boot();
  try {
    const { ctx, ui } = makeMockContext({ hasUI: true, mode: "rpc" });
    await scenario.mock.commands.get("tokens")?.handler("--port abc extra", ctx);
    assert.ok(ui.calls.every((call) => call.kind === "notify"));
    assert.ok(
      ui.calls.some((call) => call.message.includes("--port abc") && call.message.includes("/tokens")),
      "必须给出用法提示",
    );
    for (const call of ui.calls) {
      // 输出中不得含 Markdown 表格分隔行（AC-6.6）。
      assert.equal(/\|\s*-{3,}/.test(call.message), false);
      assert.ok(call.message.length < 400);
    }
  } finally {
    await scenario.runtime.server?.stop();
    scenario.dispose();
  }
});

test("AC-6.2：重复 /tokens 复用端口与进程，只打开一次浏览器", async () => {
  const scenario = await boot();
  try {
    const first = makeMockContext({ hasUI: true, mode: "rpc" });
    await scenario.mock.commands.get("tokens")?.handler("", first.ctx);
    const infoAfterFirst = scenario.runtime.server?.info ?? null;
    assert.ok(infoAfterFirst);
    const execAfterFirst = scenario.mock.execCalls.length;
    assert.equal(execAfterFirst, 1, "首次必须尝试打开浏览器");

    const second = makeMockContext({ hasUI: true, mode: "rpc" });
    await scenario.mock.commands.get("tokens")?.handler("", second.ctx);
    const infoAfterSecond = scenario.runtime.server?.info ?? null;
    assert.ok(infoAfterSecond);
    assert.equal(infoAfterSecond.port, infoAfterFirst.port);
    assert.equal(infoAfterSecond.pid, infoAfterFirst.pid);
    assert.equal(infoAfterSecond.startedAt, infoAfterFirst.startedAt);
    assert.equal(infoAfterSecond.token, infoAfterFirst.token);
    assert.equal(scenario.mock.execCalls.length, execAfterFirst, "AC-6.2：只打开一次浏览器");
  } finally {
    await scenario.runtime.server?.stop();
    scenario.dispose();
  }
});

test("AC-15.4：一次会话内调用 3 次 → 消息条数 ≤ 3 且每条 ≤ 300 字符", async () => {
  const scenario = await boot();
  try {
    for (let index = 0; index < 3; index += 1) {
      const { ctx } = makeMockContext({ hasUI: true, mode: "rpc" });
      await scenario.mock.commands.get("tokens")?.handler("--no-open", ctx);
    }
    assert.ok(scenario.mock.messages.length <= 3);
    assert.equal(scenario.mock.messages.length, 3);
    for (const message of scenario.mock.messages) {
      assert.ok(message.content.length <= 300);
      assert.equal(message.customType, "pi-monitor:link");
    }
  } finally {
    await scenario.runtime.server?.stop();
    scenario.dispose();
  }
});

test("FR-4：临时会话（无会话文件）在 session_shutdown 时落盘并标记 ephemeral", async () => {
  const scenario = await boot();
  try {
    const messageEnd = scenario.mock.events.get("message_end")?.[0];
    const sessionStart = scenario.mock.events.get("session_start")?.[0];
    const shutdown = scenario.mock.events.get("session_shutdown")?.[0];
    assert.ok(messageEnd && sessionStart && shutdown);
    const ledgerPath = path.join(scenario.agentDir, "pi-monitor", "ledger.jsonl");

    // 有会话文件的会话：用量由扫描器落账（FR-2），message_end 不得产生任何待落盘条目。
    const fileCtx = makeMockContext({ hasUI: true, mode: "rpc", sessionId: "sess-file", sessionFile: "C:\\x.jsonl" }).ctx;
    await sessionStart({ reason: "startup" }, fileCtx);
    await messageEnd(
      {
        message: {
          role: "assistant",
          provider: "acme",
          model: "acme-1",
          timestamp: Date.parse("2026-09-19T10:00:00.000Z"),
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 5, totalTokens: 150, cost: { total: 0.001 } },
        },
      },
      fileCtx,
    );
    await shutdown({ reason: "exit" }, fileCtx);
    assert.equal(fs.existsSync(ledgerPath), false, "有会话文件的会话不得写 ephemeral 记录");

    // 临时会话（--no-session）：收集 assistant / toolResult，忽略 user。
    const tempCtx = makeMockContext({ hasUI: true, mode: "rpc", sessionId: "sess-temp", sessionFile: null }).ctx;
    await sessionStart({ reason: "startup" }, tempCtx);
    await messageEnd(
      {
        message: {
          role: "assistant",
          provider: "acme",
          model: "acme-1",
          timestamp: Date.parse("2026-09-19T10:05:00.000Z"),
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 5, totalTokens: 150, cost: { total: 0.001 } },
        },
      },
      tempCtx,
    );
    await messageEnd(
      {
        message: {
          role: "toolResult",
          toolName: "read",
          timestamp: Date.parse("2026-09-19T10:05:01.000Z"),
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.0005 } },
        },
      },
      tempCtx,
    );
    await messageEnd({ message: { role: "user", content: "hi" } }, tempCtx);
    // 无 usage 的消息不得产生条目。
    await messageEnd({ message: { role: "assistant", provider: "acme", model: "acme-1" } }, tempCtx);
    await shutdown({ reason: "exit" }, tempCtx);

    const lines = fs
      .readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length, 2, "只应落盘 assistant + toolResult 两条");
    assert.equal(lines.reduce((sum, record) => sum + (record["billed"] as number), 0), 165);
    for (const record of lines) {
      assert.equal(record["ephemeral"], true);
      assert.equal(record["sessionFile"], "(ephemeral)");
      assert.equal(record["sessionId"], "sess-temp");
    }
    assert.equal(lines[0]?.["kind"], "assistant");
    assert.equal(lines[1]?.["kind"], "toolResult");
    assert.equal(lines[1]?.["toolName"], "read");
  } finally {
    scenario.dispose();
  }
});

test("FR-4：/api/summary 不再返回 live（内存实时计数器已删除）", async () => {
  const scenario = await boot();
  try {
    const { ctx } = makeMockContext({ hasUI: true, mode: "rpc" });
    await scenario.mock.commands.get("tokens")?.handler("--no-open", ctx);
    const url = scenario.runtime.server?.info?.url;
    assert.ok(url, "服务必须已启动");
    const body = (await (await fetch(`${url.split("/?")[0]}/api/summary?window=all&t=${scenario.runtime.server?.info?.token}`)).json()) as Record<string, unknown>;
    assert.equal("live" in body, false, "FR-4.1~4.4 已删除：响应不得再有 live 字段");
    assert.ok(body["totals"], "totals 仍必须存在");
    await scenario.runtime.server?.stop();
  } finally {
    scenario.dispose();
  }
});

test("FR-7：token_stats 工具——全维度可调用、limit 夹取、from/to 成对校验（AC-7.1~AC-7.4）", async () => {
  const scenario = await boot({
    sessions: [
      {
        name: "s.jsonl",
        entries: [
          assistantEntry({ id: "a1", iso: "2026-09-19T10:00:00.000Z", input: 100, output: 50, costTotal: 0.001 }),
          assistantEntry({ id: "a2", iso: "2026-09-20T10:00:00.000Z", input: 20, output: 20, costTotal: 0.0005 }),
        ],
      },
    ],
  });
  try {
    await scenario.runtime.engine.scan({});
    const tool = scenario.mock.tools.get("token_stats");
    assert.ok(tool);
    const { ctx } = makeMockContext({ hasUI: true, mode: "rpc" });

    const dimensions = ["day", "week", "month", "provider", "model", "project", "session", "source", "kind"];
    for (const groupBy of dimensions) {
      const result = (await tool.execute("call", { window: "all", groupBy }, undefined, undefined, ctx)) as {
        content: Array<{ text: string }>;
        details: Record<string, any>;
      };
      assert.equal(result.details["window"] !== undefined, true, `${groupBy} window`);
      assert.equal(result.details["currency"]["code"], "CNY");
      assert.ok(Array.isArray(result.details["groups"]));
      assert.equal(result.details["groups"].length > 0, true, `${groupBy} 必须有分组`);
      assert.ok(result.content[0] && result.content[0].text.length <= 1024, "FR-7.1：文本 ≤ 1 KiB");
      assert.equal(/\|\s*-{3,}/.test(result.content[0]?.text ?? ""), false, "FR-7.1：不生成 Markdown 表格");
    }

    // AC-7.2：limit > 200 被夹到 200，details.truncated == true。
    const clamped = (await tool.execute("call", { window: "all", groupBy: "day", limit: 500 }, undefined, undefined, ctx)) as {
      details: Record<string, any>;
    };
    assert.equal(clamped.details["truncated"], true);

    // AC-7.3：只给 from 不给 to 必须报错，且错误文本含正确用法。
    await assert.rejects(
      () => tool.execute("call", { from: "2026-09-01" }, undefined, undefined, ctx),
      (error: Error) => {
        assert.ok(error.message.includes("from") && error.message.includes("to"));
        assert.ok(error.message.includes("YYYY-MM-DD"));
        return true;
      },
    );

    // AC-7.4：details.totals.tokens.billed 等于仪表盘 all 窗口同一数字。
    const all = (await tool.execute("call", { window: "all" }, undefined, undefined, ctx)) as { details: Record<string, any> };
    const engineAll = scenario.runtime.engine.records.reduce(
      (sum: number, record: any) => sum + record.billed,
      0,
    );
    assert.equal(all.details["totals"]["tokens"]["billed"], engineAll);
    assert.equal(all.details["totals"]["tokens"]["billed"], 190);
  } finally {
    scenario.dispose();
  }
});

test("FR-7.3：工具文本与 details 中的金额为人民币并带 currency 字段", async () => {
  const scenario = await boot({
    sessions: [
      { name: "s.jsonl", entries: [assistantEntry({ id: "a1", iso: "2026-09-19T10:00:00.000Z", input: 100, output: 50, costTotal: 0.001 })] },
    ],
  });
  try {
    await scenario.runtime.engine.scan({});
    const tool = scenario.mock.tools.get("token_stats");
    assert.ok(tool);
    const { ctx } = makeMockContext({ hasUI: true, mode: "rpc" });
    const result = (await tool.execute("call", { window: "all" }, undefined, undefined, ctx)) as {
      content: Array<{ text: string }>;
      details: Record<string, any>;
    };
    assert.equal(result.details["currency"]["code"], "CNY");
    assert.equal(result.details["currency"]["symbol"], "¥");
    assert.equal(result.details["currency"]["rate"], 7.2);
    assert.equal(result.details["totals"]["cost"]["cny"]["known"], 0.0072);
    assert.ok(result.content[0]?.text.includes("¥0.0072"), `文本应含人民币金额：${result.content[0]?.text}`);
    assert.equal(result.details["usage"], undefined, "FR-7.4：工具不得返回 usage");
  } finally {
    scenario.dispose();
  }
});

test("NFR-5 / 13 章：畸形事件与预算检查不得抛到 agent 主流程", async () => {
  const scenario = await boot({ config: { budget: { enabled: true, dailyCNY: 1 } } });
  try {
    const { ctx } = makeMockContext({ hasUI: true, mode: "rpc", sessionId: "s", sessionFile: "C:\\x.jsonl" });
    const messageEnd = scenario.mock.events.get("message_end")?.[0];
    assert.ok(messageEnd);
    // 全部是畸形事件：不得抛出（内部 try/catch + surfaceError）。
    await messageEnd({}, ctx);
    await messageEnd({ message: null }, ctx);
    await messageEnd({ message: { role: "assistant", usage: "bogus" } }, ctx);
    await messageEnd({ message: { role: "assistant", usage: { input: -1 } } }, ctx);
    await messageEnd({ message: { role: "toolResult" } }, ctx);

    const settled = scenario.mock.events.get("agent_settled")?.[0];
    assert.ok(settled);
    await settled({}, ctx);

    const shutdown = scenario.mock.events.get("session_shutdown")?.[0];
    assert.ok(shutdown);
    await shutdown({ reason: "quit" }, ctx);
  } finally {
    scenario.dispose();
  }
});
