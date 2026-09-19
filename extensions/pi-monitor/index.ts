/**
 * extensions/pi-monitor/index.ts — 唯一扩展入口。
 * 需求：FR-4（临时会话落盘）、FR-6（`/tokens`，唯一命令）、FR-7（`token_stats` 工具）、
 *       FR-10（预算提醒）、FR-11（配置）、FR-14、FR-15（通道契约）、AC-6.1~AC-6.9、
 *       AC-7.1~AC-7.5、AC-15.1~AC-15.4、NFR-5、NFR-9、19 附录 A（扩展 API 事实清单）
 *
 * 通道约束（FR-15，禁止项）：
 *  - 禁止 `ctx.ui.custom` / `setStatus` / `setWidget` / `setFooter` / 任何 TUI 组件（AC-15.1）。
 *  - 无 UI 模式（`json` / `print`）下不得调用任何 `ctx.ui.*`（AC-15.2）。
 *  - 除 1 条 ≤ 300 字符的链接消息与工具结果外，不得向会话注入内容（P-11）。
 *  - 除 `tokens` 外不注册任何命令（AC-15.3）。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { sumTotals } from "../../src/aggregate.ts";
import { buildLinkMessage, parseTokensArgs, TOKENS_USAGE } from "../../src/args.ts";
import { evaluateBudget } from "../../src/budget.ts";
import { loadConfig, type LoadedConfig } from "../../src/config.ts";
import { fingerprintOf } from "../../src/dedupe.ts";
import { formatCNY, formatCount, formatPercent } from "../../src/format.ts";
import { createNullLogger } from "../../src/health.ts";
import { resolveLocale, translate } from "../../src/i18n.ts";
import { readBudgetState, writeBudgetState } from "../../src/ledger.ts";
import { openBrowser } from "../../src/opener.ts";
import { readUsageComponents } from "../../src/parser.ts";
import { resolveAgentDir, resolveConfigPath } from "../../src/paths.ts";
import { MonitorEngine } from "../../src/scanner.ts";
import { dayKey, resolveWindow } from "../../src/time.ts";
import { buildToolAggregate, refreshAutoRate, type MonitorContext, type QueryOptions } from "../../src/dashboard/api.ts";
import { DashboardServer } from "../../src/dashboard/server.ts";
import type { BudgetState, Locale, RecordKind, Totals, UsageRecord } from "../../src/types.ts";

/** FR-6.5：链接消息上限 300 字符（见 src/args.ts）。 */
/** FR-7.1：工具文本上限 1 KiB。 */
const TOOL_TEXT_LIMIT = 1024;
/** FR-7.2：`limit` 上限 200。 */
const TOOL_LIMIT_MAX = 200;

/** FR-4：临时会话（无会话文件）待落盘的 usage 条目。 */
interface EphemeralUsageEntry {
  kind: RecordKind;
  toolName: string | null;
  usage: unknown;
  provider: string | null;
  model: string | null;
  ts: number;
}

interface Runtime {
  agentDir: string;
  configPath: string;
  loadedConfig: LoadedConfig;
  engine: MonitorEngine;
  server: DashboardServer | null;
  context: MonitorContext;
  loaded: boolean;
  sessionId: string | null;
  sessionFile: string | null;
  /** FR-4：临时会话的待落盘队列（`session_start` 时清空，`session_shutdown` 时写账本）。 */
  ephemeralEntries: EphemeralUsageEntry[];
  budgetState: BudgetState | null;
  browserOpened: boolean;
}

/**
 * 附录 A：不得在 factory 中启动后台资源（socket / 定时器）。
 * 运行期状态放在全局，使得 `/reload` 或会话重载后仍能复用同一个 HTTP 服务（AC-6.2）。
 */
const RUNTIME_KEY = "__piMonitorRuntime_v1__";

function globalStore(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function localeFrom(config: LoadedConfig): Locale {
  return resolveLocale(config.config.locale).locale;
}

function createRuntime(): Runtime {
  const agentDir = resolveAgentDir();
  const configPath = resolveConfigPath(agentDir);
  const loadedConfig = loadConfig(configPath);
  const engine = new MonitorEngine({
    agentDir,
    config: loadedConfig.config,
    logger: createNullLogger(),
  });
  const context: MonitorContext = {
    engine,
    loaded: loadedConfig,
    configPath,
    logPath: null,
    locale: localeFrom(loadedConfig),
    readOnly: false,
    lockTimeout: false,
    sessionId: null,
  };
  return {
    agentDir,
    configPath,
    loadedConfig,
    engine,
    server: null,
    context,
    loaded: false,
    sessionId: null,
    sessionFile: null,
    ephemeralEntries: [],
    budgetState: null,
    browserOpened: false,
  };
}

function getRuntime(): Runtime {
  const store = globalStore();
  const existing = store[RUNTIME_KEY] as Runtime | undefined;
  if (existing !== undefined) return existing;
  const created = createRuntime();
  store[RUNTIME_KEY] = created;
  return created;
}

/** FR-2 / FR-12：按需载入索引（不阻塞命令返回；扫描在后台）。 */
function ensureLoaded(runtime: Runtime): void {
  if (runtime.loaded) return;
  runtime.engine.load();
  runtime.loaded = true;
  runtime.context.readOnly = runtime.engine.readOnly;
  runtime.context.lockTimeout = runtime.engine.lockTimeout;
}

/** NFR-5 / 13 章：错误只降级为一行提示，绝不抛到 agent 主流程。 */
function surfaceError(ctx: ExtensionContext, error: unknown): void {
  if (!ctx.hasUI) return;
  const message = (error as Error)?.message ?? String(error);
  ctx.ui.notify(`pi-monitor: ${message}`, "error");
}

/** FR-6.5：链接消息只含标题、URL 与关闭方法，且 ≤ 300 字符。 */
export { buildLinkMessage, parseTokensArgs };

export default function piMonitorExtension(pi: ExtensionAPI): void {
  const runtime = getRuntime();

  // AC-15.3：`tool.enabled:false` 时不注册 `token_stats`（此时无残留注册）。
  if (runtime.loadedConfig.config.tool.enabled) {
    registerTokenStatsTool(pi);
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      // 配置可能已变化（尤其 `tool.enabled`），会话启动时重新读取。
      const loadedConfig = loadConfig(runtime.configPath);
      runtime.loadedConfig = loadedConfig;
      runtime.engine.setConfig(loadedConfig.config);
      runtime.context.loaded = loadedConfig;
      runtime.context.locale = localeFrom(loadedConfig);
      runtime.sessionId = ctx.sessionManager.getSessionId();
      runtime.sessionFile = ctx.sessionManager.getSessionFile() ?? null;
      runtime.context.sessionId = runtime.sessionId;
      runtime.ephemeralEntries = [];
      runtime.browserOpened = false;
      const today = dayKey(Date.now(), runtime.engine.timezone);
      runtime.budgetState = readBudgetState(runtime.engine.paths.budgetState, today, today.slice(0, 7));
    } catch (error) {
      surfaceError(ctx, error);
    }
  });

  /**
   * FR-4：只为临时会话（无会话文件）收集待落盘的条目。
   *
   * 不再维护「本会话（实时）」内存计数器：同一进程里可能有多个会话，
   * 且仪表盘进程未必就是产生用量的那个进程，内存计数器无法可靠地代表「本会话」；
   * 当天用量由账本 + 仪表盘自动刷新（≤30 s）呈现（FR-8.7）。
   */
  pi.on("message_end", async (event, ctx) => {
    try {
      const message = event.message as unknown as Record<string, unknown>;
      const role = message["role"];
      if (role !== "assistant" && role !== "toolResult") return;
      const usage = message["usage"];
      if (usage === undefined || usage === null) return;
      // 有会话文件的会话由扫描器落账（FR-2），这里只为无文件的临时会话留底。
      if (runtime.sessionFile !== null && runtime.sessionFile.length > 0) return;

      const provider =
        typeof message["provider"] === "string" ? (message["provider"] as string) : (ctx.model?.provider ?? null);
      const modelId = typeof message["model"] === "string" ? (message["model"] as string) : (ctx.model?.id ?? null);
      const kind: RecordKind = role === "assistant" ? "assistant" : "toolResult";
      const toolName = typeof message["toolName"] === "string" ? (message["toolName"] as string) : null;
      const ts = typeof message["timestamp"] === "number" ? (message["timestamp"] as number) : Date.now();

      runtime.ephemeralEntries.push({ kind, toolName, usage, provider, model: modelId, ts });
    } catch (error) {
      surfaceError(ctx, error);
    }
  });

  // FR-10.3：`agent_settled` 之后检查预算（不阻塞 agent）。
  pi.on("agent_settled", async (_event, ctx) => {
    try {
      checkBudget(pi, runtime, ctx);
    } catch (error) {
      surfaceError(ctx, error);
    }
  });

  pi.on("session_shutdown", async (_event, _ctx) => {
    try {
      // FR-4：临时会话结束后按配置落盘。
      captureEphemeral(runtime);
      // FR-6.10：按 `dashboard.stopOnExit` 关闭服务。
      if (runtime.server !== null && runtime.loadedConfig.config.dashboard.stopOnExit) {
        await runtime.server.stop();
        runtime.server = null;
        runtime.browserOpened = false;
      }
    } catch {
      // 清理失败不影响退出（NFR-5）。
    }
  });

  // FR-6：唯一命令。
  pi.registerCommand("tokens", {
    description: "Open the pi-monitor dashboard (usage, CNY cost, heatmap) in your browser.",
    handler: async (args, ctx) => {
      // AC-6.9 / AC-15.2：无 UI 模式（json / print）下静默返回，不启动服务、不调用 ctx.ui.*。
      if (!ctx.hasUI) return;
      try {
        await handleTokensCommand(pi, runtime, args, ctx);
      } catch (error) {
        surfaceError(ctx, error);
      }
    },
  });
}

async function handleTokensCommand(
  pi: ExtensionAPI,
  runtime: Runtime,
  args: string,
  ctx: ExtensionContext,
): Promise<void> {
  const parsed = parseTokensArgs(args);
  for (const invalid of parsed.invalid) {
    // AC-6.7：非法参数只提示一行，继续执行默认行为，不抛异常。
    ctx.ui.notify(`pi-monitor: 已忽略无法识别的参数 "${invalid}"（用法：${TOKENS_USAGE}）`, "info");
  }

  if (!runtime.loadedConfig.config.dashboard.enabled) {
    ctx.ui.notify("pi-monitor: 仪表盘已在配置中禁用（dashboard.enabled=false）", "info");
    return;
  }

  // FR-6.2 启动顺序：① 载入配置与账本 ② 同步启动 HTTP 服务 ③ 触发后台增量扫描
  //                  ④ 打开浏览器 ⑤ 返回。
  // AC-6.8：500 MiB 冷索引下命令返回 < 1.5 s，因此「载入 + 扫描」必须全部在后台完成；
  // 这里先同步标出「正在建立索引」，让首屏立即看到进度条。
  runtime.engine.markScanning();

  let server = runtime.server;
  if (server === null || !server.running) {
    const config = runtime.engine.config.dashboard;
    server = new DashboardServer({
      port: parsed.port ?? config.port,
      portRange: config.portRange,
      allowLan: config.allowLan,
      locale: runtime.context.locale,
      context: () => runtime.context,
    });
    runtime.server = server;
    await server.start();
    runtime.browserOpened = false;
  }

  const info = runtime.server?.info ?? null;
  if (info === null) throw new Error("仪表盘服务启动失败");

  // 后台载入 + 增量扫描（不阻塞命令返回，AC-6.8）。
  void runtime.engine
    .scan({})
    .then(() => {
      runtime.loaded = true;
      runtime.context.readOnly = runtime.engine.readOnly;
      runtime.context.lockTimeout = runtime.engine.lockTimeout;
    })
    .catch(() => {
      /* 扫描失败由 engine 计数并降级，命令本身不失败（13 章）。 */
    });

  // ¥8：汇率过期时后台联网取一次（不阻塞命令返回；关闭 autoRate 时零出站）。
  void refreshAutoRate(runtime.context, {}).catch(() => {
    /* 汇率失败只降级（保留上次的值），不影响仪表盘启动（NFR-5）。 */
  });

  // AC-6.2：服务已在运行时复用现有进程 / 端口 / token，且只打开一次浏览器。
  let opened = false;
  if (!parsed.noOpen && !runtime.browserOpened) {
    opened = await openBrowser(info.url, (command, execArgs, options) =>
      pi.exec(command, execArgs, options as { timeout?: number } | undefined),
    );
    runtime.browserOpened = true;
  }

  // FR-6.5：唯一允许的两条反馈通道（均极小）。
  ctx.ui.notify(`pi-monitor 仪表盘已启动：${info.url}`, "info");
  if (!parsed.noOpen && !opened) {
    // AC-6.3：浏览器打不开时改为提示完整 URL（不报错）。
    ctx.ui.notify(`pi-monitor: 无法自动打开浏览器，请手动访问 ${info.url}`, "info");
  }
  if (runtime.loadedConfig.config.dashboard.linkMessage) {
    pi.sendMessage(
      { customType: "pi-monitor:link", content: buildLinkMessage(info.url, runtime.context.locale), display: true },
      { deliverAs: "steer" },
    );
  }
}

/** FR-7：`token_stats` 工具（可关闭，供 agent 用自然语言取数）。 */
function registerTokenStatsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "token_stats",
    label: "Token Stats",
    description:
      "Return the user's own pi token/usage totals (billed tokens, CNY cost) for a window, optionally grouped by dimension. Use it when the user asks about their own token usage or spend.",
    promptSnippet: "Read the user's pi usage/token/cost statistics for a time window",
    promptGuidelines: [
      "Use token_stats when the user asks about their own pi token usage, spend, or cost; it is local-only and returns CNY amounts.",
    ],
    parameters: Type.Object({
      window: Type.Optional(Type.Union([Type.String(), Type.Number()])),
      from: Type.Optional(Type.String({ description: "YYYY-MM-DD (requires `to`)" })),
      to: Type.Optional(Type.String({ description: "YYYY-MM-DD (requires `from`)" })),
      groupBy: Type.Optional(
        StringEnum(["day", "week", "month", "provider", "model", "project", "session", "source", "kind"] as const),
      ),
      project: Type.Optional(Type.String()),
      provider: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      source: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: TOOL_LIMIT_MAX })),
    }),
    async execute(_toolCallId, params) {
      const runtime = getRuntime();
      ensureLoaded(runtime);

      const input = params as Record<string, unknown>;
      const from = typeof input["from"] === "string" ? (input["from"] as string) : undefined;
      const to = typeof input["to"] === "string" ? (input["to"] as string) : undefined;
      if ((from === undefined) !== (to === undefined)) {
        // AC-7.3：错误信息必须含 `from` 与 `to` 的正确用法。
        throw new Error(
          'token_stats: `from` and `to` must be provided together as YYYY-MM-DD. Example: { "from": "2026-09-01", "to": "2026-09-19" }.',
        );
      }

      const requestedLimit = typeof input["limit"] === "number" ? (input["limit"] as number) : 20;
      const clampedLimit = Math.max(1, Math.min(TOOL_LIMIT_MAX, Math.floor(requestedLimit)));

      const query: QueryOptions = {};
      if (from !== undefined && to !== undefined) {
        query.from = from;
        query.to = to;
      } else if (typeof input["window"] === "number") {
        query.window = String(input["window"]);
      } else if (typeof input["window"] === "string" && (input["window"] as string).length > 0) {
        query.window = input["window"] as string;
      } else {
        query.window = "last7d";
      }
      if (typeof input["groupBy"] === "string") query.dim = input["groupBy"] as string;
      if (typeof input["project"] === "string") query.project = input["project"] as string;
      if (typeof input["provider"] === "string") query.provider = input["provider"] as string;
      if (typeof input["model"] === "string") query.model = input["model"] as string;
      if (typeof input["source"] === "string") query.source = input["source"] as string;

      const result = buildToolAggregate(runtime.context, query, clampedLimit);
      const locale = runtime.context.locale;
      const totals = result.totals;

      // FR-7.2 / AC-7.2：夹取后的 limit 必须体现在 `details.truncated`。
      const details = {
        window: result.window,
        currency: result.currency,
        totals,
        groups: result.groups ?? [],
        daily: result.daily ?? [],
        truncated: requestedLimit > TOOL_LIMIT_MAX || result.truncated === true,
      };

      const lines: string[] = [];
      if (totals.messages.total === 0) {
        lines.push(translate(locale, "tool.noRecords", { window: result.window.label }));
      } else {
        lines.push(
          translate(locale, "tool.summary", {
            window: result.window.label,
            billed: formatCount(totals.tokens.billed),
            cost: formatCNY(totals.cost.cny.known),
            estimated: formatCNY(totals.cost.cny.estimated),
          }),
        );
        for (const group of (result.groups ?? []).slice(0, 5)) {
          lines.push(
            `· ${group.label}: ${formatCount(group.totals.tokens.billed)} (${formatPercent(group.share)}), ${formatCNY(group.totals.cost.cny.known)}`,
          );
        }
      }

      // FR-7.1：`content[0].text` ≤ 1 KiB，一句话 + 最多 5 行要点，不生成 Markdown 表格。
      let text = lines.join("\n");
      if (text.length > TOOL_TEXT_LIMIT) text = `${text.slice(0, TOOL_TEXT_LIMIT - 1)}…`;
      return { content: [{ type: "text", text }], details };
    },
  });
}

/** FR-10：预算判定与提醒（真实成本；`includeEstimated` 时才计入估算）。 */
function checkBudget(pi: ExtensionAPI, runtime: Runtime, ctx: ExtensionContext): void {
  const config = runtime.engine.config;
  if (!config.budget.enabled) return; // FR-10.7：未启用时完全静默。
  ensureLoaded(runtime);

  const now = Date.now();
  const tz = runtime.engine.timezone;
  const weekStart = config.weekStart;
  const day = dayKey(now, tz);
  const month = day.slice(0, 7);
  const todayWindow = resolveWindow({ kind: "today" }, { tz, weekStart, now });
  const monthWindow = resolveWindow({ kind: "month" }, { tz, weekStart, now });

  // AC-10.4：只用内存聚合，不触发全量重扫。
  const today = windowTotals(runtime, todayWindow.fromMs, todayWindow.toMs);
  const monthly = windowTotals(runtime, monthWindow.fromMs, monthWindow.toMs);

  const outcome = evaluateBudget({
    config,
    rate: config.currency.rate,
    day,
    month,
    todayUsd: today.cost.usd,
    monthUsd: monthly.cost.usd,
    state: runtime.budgetState ?? { schemaVersion: 1, day, month, fired: { daily: [], monthly: [] } },
  });
  runtime.budgetState = outcome.state;
  try {
    writeBudgetState(runtime.engine.paths.budgetState, outcome.state);
  } catch {
    // 磁盘失败不影响提醒（13 章）。
  }

  for (const alert of outcome.alerts) {
    if (!ctx.hasUI) continue;
    const period = alert.period === "daily" ? "日预算" : "月预算";
    ctx.ui.notify(
      `pi-monitor: ${period}已达 ${formatPercent(alert.threshold)}（${formatCNY(alert.spentCNY)} / ${formatCNY(alert.limitCNY)}）`,
      "info",
    );
  }

  // FR-10.4：`budget.injectMessage` 默认 false；开启时才额外发一条消息。
  if (outcome.alerts.length > 0 && config.budget.injectMessage) {
    const first = outcome.alerts[0] as (typeof outcome.alerts)[number];
    const period = first.period === "daily" ? "日预算" : "月预算";
    pi.sendMessage(
      {
        customType: "pi-monitor:budget",
        content: `pi-monitor 预算提醒：${period} ${formatCNY(first.spentCNY)} / ${formatCNY(first.limitCNY)}`,
        display: true,
      },
      { deliverAs: "followUp" },
    );
  }
}

/** 8.1：复用 `aggregate.sumTotals` 的唯一实现（禁止第二份求和逻辑）。 */
function windowTotals(runtime: Runtime, fromMs: number, toMs: number): Totals {
  const records = runtime.engine.records.filter((record) => record.ts >= fromMs && record.ts <= toMs);
  return sumTotals(records, runtime.engine.config.currency.rate);
}

/** FR-4：临时会话（无文件）结束时按配置落盘并标记 `ephemeral:true`。 */
function captureEphemeral(runtime: Runtime): void {
  const config = runtime.engine.config;
  if (!config.ephemeralCapture) return;
  if (runtime.sessionFile !== null && runtime.sessionFile.length > 0) return;
  if (runtime.ephemeralEntries.length === 0) return;

  const tz = runtime.engine.timezone;
  const sessionId = runtime.sessionId ?? "ephemeral";
  const emptyPricing = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();
  const records: UsageRecord[] = [];

  for (let index = 0; index < runtime.ephemeralEntries.length; index += 1) {
    const entry = runtime.ephemeralEntries[index] as EphemeralUsageEntry;
    const components = readUsageComponents(entry.usage, entry.provider, entry.model, emptyPricing);
    if (components === null) continue;
    records.push({
      v: 1,
      fp: fingerprintOf({
        entryId: `${sessionId}:${index}`,
        ts: entry.ts,
        provider: entry.provider,
        model: entry.model,
        input: components.input,
        output: components.output,
        cacheRead: components.cacheRead,
        cacheWrite: components.cacheWrite,
      }),
      ts: entry.ts,
      tsSource: "message",
      day: dayKey(entry.ts, tz),
      tz,
      provider: entry.provider,
      model: entry.model,
      api: null,
      kind: entry.kind,
      toolName: entry.toolName,
      input: components.input,
      output: components.output,
      cacheRead: components.cacheRead,
      cacheWrite: components.cacheWrite,
      reasoning: components.reasoning,
      billed: components.billed,
      costUsd: components.costUsd,
      costUsdEst: components.costUsdEst,
      sessionId,
      sessionFile: "(ephemeral)",
      entryId: `${sessionId}:${index}`,
      cwd: null,
      project: "(unknown)",
      source: "pi",
      ephemeral: true,
    });
  }
  if (records.length > 0) runtime.engine.persistEphemeral(records);
}
