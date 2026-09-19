/**
 * format.ts — 数字 / 金额 / 百分比格式化 + CSV / Markdown 导出（纯函数，无 IO）。
 * 需求：第 9 章（9.1 数字与货币格式、9.2 仪表盘文案、9.3 Markdown、9.4 CSV）、
 *       AC-9.1.1~AC-9.1.3、AC-9.4、AC-9.5、¥6（CSV 同时给出 USD 与 CNY）、P-13
 */

import { translate, type Dict } from "./i18n.ts";
import { round6 } from "./money.ts";
import type {
  AggregateDimension,
  AggregateResult,
  DailyRow,
  GroupRow,
  Locale,
  MetaInfo,
  Totals,
  UsageRecord,
} from "./types.ts";

/** ¥1：面向用户的人民币符号。 */
export const CNY_SYMBOL = "¥";
/** 9.1：美元金额仅出现在导出的「USD 参考列」中（$6）。 */
export const USD_SYMBOL = "$";
/** ¥7：未知金额显示 `—`，禁止显示 ¥0.00。 */
export const UNKNOWN_MONEY = "—";

const THOUSAND_RE = /\B(?=(\d{3})+(?!\d))/g;

function addThousands(fixed: string): string {
  const negative = fixed.startsWith("-");
  const body = negative ? fixed.slice(1) : fixed;
  const [intPart, decimalPart] = body.split(".");
  const grouped = (intPart ?? "").replace(THOUSAND_RE, ",");
  const sign = negative ? "-" : "";
  return decimalPart === undefined ? `${sign}${grouped}` : `${sign}${grouped}.${decimalPart}`;
}

/**
 * 9.1：计数（页面卡片）—— `k=1e3, M=1e6, B=1e9`；
 * 结果 < 10 保留 1 位小数，≥ 10 取整；< 1000 显示原值。
 * AC-9.1.1：999 / 1000 / 9999 / 12345 / 1234567 → 999 / 1.0k / 10k / 12k / 1.2M
 */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index] as [number, string];
    if (abs < unit[0]) continue;
    const scaled = value / unit[0];
    const text = scaled.toFixed(1);
    const parsed = Number.parseFloat(text);
    if (parsed >= 1000) {
      const bigger = units[index - 1];
      if (bigger !== undefined) {
        const upScaled = value / bigger[0];
        const upText = upScaled.toFixed(1);
        const upParsed = Number.parseFloat(upText);
        return upParsed >= 10 ? `${Math.round(upParsed)}${bigger[1]}` : `${upText}${bigger[1]}`;
      }
    }
    return parsed >= 10 ? `${Math.round(parsed)}${unit[1]}` : `${text}${unit[1]}`;
  }
  return String(Math.round(value));
}

/** 9.1：计数（表格 / 导出 / JSON）—— 原始整数；页面表格 ≥ 10000 用千分位。 */
export function formatCountExact(value: number, group = true): string {
  if (!Number.isFinite(value)) return "0";
  const int = Math.round(value);
  return group ? addThousands(String(int)) : String(int);
}

/**
 * 9.1：金额格式 —— `¥` + 4 位小数；`≥ 100` 用 2 位小数；`≥ 10000` 用千分位；未知 `—`。
 * AC-9.1.2：0.0002176 / 1.5 / 123.456 / 12345.6 → ¥0.0002 / ¥1.5000 / ¥123.46 / ¥12,345.60
 * AC-9.1.3：`null` → `—`（不是 ¥0.0000，¥7）。
 */
export function formatAmount(value: number | null, symbol: string): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return UNKNOWN_MONEY;
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 2 : 4;
  const fixed = value.toFixed(decimals);
  if (abs >= 10000) return `${symbol}${addThousands(fixed)}`;
  return `${symbol}${fixed}`;
}

/** 9.1：人民币金额。 */
export function formatCNY(value: number | null): string {
  return formatAmount(value, CNY_SYMBOL);
}

/** 9.1：美元金额（仅导出参考列，$6）。 */
export function formatUSD(value: number | null): string {
  return formatAmount(value, USD_SYMBOL);
}

/** 9.1：百分比 —— 1 位小数 + `%`。 */
export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0.0%";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 9.1：汇率 —— `1 USD = 7.20 CNY`。 */
export function formatRate(rate: number): string {
  return `1 USD = ${rate.toFixed(2)} CNY`;
}

/** 9.3：Markdown 中带千分位的整数。 */
export function formatInt(value: number): string {
  return formatCountExact(value, true);
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 9.3：生成时间 `YYYY-MM-DD HH:mm:ss ±HH:MM`（时区固定为窗口时区）。 */
export function formatDateTime(date: Date, _tz: string): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  return (
    `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ` +
    `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}:${pad2(local.getUTCSeconds())} ` +
    `${sign}${pad2(Math.floor(absOffset / 60))}:${pad2(absOffset % 60)}`
  );
}

/** AC-9.5：下载文件名 `pi-monitor-<window>-<YYYYMMDD-HHmmss>.<ext>`。 */
export function exportFileName(windowSlug: string, date: Date, ext: string): string {
  const stamp =
    `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}` +
    `-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  return `pi-monitor-${windowSlug}-${stamp}.${ext}`;
}

// ---------------------------------------------------------------------------
// 9.4 CSV
// ---------------------------------------------------------------------------

/** 9.4：列顺序固定。 */
export const CSV_COLUMNS: readonly string[] = [
  "ts",
  "day",
  "tz",
  "provider",
  "model",
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
  "costCny",
  "costCnyEst",
  "sessionId",
  "cwd",
  "project",
  "source",
  "entryId",
];

function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return csvEscape(String(value));
}

/**
 * 9.4：逐条记录导出。
 *  - UTF-8 带 BOM（Excel 中文兼容）。
 *  - `costCny = costUsd × rate`（6 位小数），`costCnyEst` 同理（¥6）。
 *  - 文件头含一行注释 `# rate=7.20 generated=<ISO>`（便于再次核对汇率）。
 */
export function recordsToCsv(records: readonly UsageRecord[], rate: number, generatedAt: Date): string {
  const lines: string[] = [];
  lines.push(`# rate=${rate.toFixed(2)} generated=${generatedAt.toISOString()}`);
  lines.push(CSV_COLUMNS.join(","));
  for (const record of records) {
    const costCny = record.costUsd === null ? null : round6(record.costUsd * rate);
    const costCnyEst = record.costUsdEst === null ? null : round6(record.costUsdEst * rate);
    lines.push(
      [
        csvCell(record.ts),
        csvCell(record.day),
        csvCell(record.tz),
        csvCell(record.provider),
        csvCell(record.model),
        csvCell(record.kind),
        csvCell(record.toolName),
        csvCell(record.input),
        csvCell(record.output),
        csvCell(record.cacheRead),
        csvCell(record.cacheWrite),
        csvCell(record.reasoning),
        csvCell(record.billed),
        csvCell(record.costUsd),
        csvCell(record.costUsdEst),
        csvCell(costCny),
        csvCell(costCnyEst),
        csvCell(record.sessionId),
        csvCell(record.cwd),
        csvCell(record.project),
        csvCell(record.source),
        csvCell(record.entryId),
      ].join(","),
    );
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// 9.3 Markdown
// ---------------------------------------------------------------------------

export interface MarkdownOverviewColumn {
  label: string;
  totals: Totals;
}

export interface MarkdownInput {
  locale: Locale;
  windowLabel: string;
  timezone: string;
  rate: number;
  generatedAt: Date;
  overview: MarkdownOverviewColumn[];
  daily: readonly DailyRow[];
  breakdown?: { dimension: AggregateDimension; groups: readonly GroupRow[] };
  meta: MetaInfo;
  files: number;
  records: number;
  dedupeSkipped: number;
  updatedAt: string | null;
}

/**
 * 9.3：导出 Markdown。区块顺序固定：标题 → 汇率/生成时间 → 概览 → 每日明细 → 分解表 → 数据源。
 * 金额为人民币，并附 USD 参考列；首部含汇率行（¥4）。
 */
export function buildMarkdown(input: MarkdownInput): string {
  const { locale, rate } = input;
  const t = (key: string, params?: Dict) => translate(locale, key, params);
  const out: string[] = [];

  const from = input.daily.length > 0 ? (input.daily[0] as DailyRow).day : "";
  const lastRow = input.daily[input.daily.length - 1];
  const to = lastRow !== undefined ? lastRow.day : "";
  out.push(`# ${t("md.title", { window: input.windowLabel, from, to, tz: input.timezone })}`);
  out.push("");
  out.push(`${t("md.rate", { rate: rate.toFixed(2) })} · ${t("md.generated")}：${formatDateTime(input.generatedAt, input.timezone)}`);
  out.push("");

  // 概览
  out.push(`## ${t("md.overview")}`);
  const headers = [t("md.metric"), ...input.overview.map((column) => column.label)];
  out.push(`| ${headers.join(" | ")} |`);
  out.push(`| ${headers.map(() => "---").join(" | ")} |`);
  const row = (label: string, pick: (totals: Totals) => string): string =>
    `| ${label} | ${input.overview.map((column) => pick(column.totals)).join(" | ")} |`;

  out.push(row(t("md.billed"), (totals) => formatCount(totals.tokens.billed)));
  out.push(
    row(
      t("md.inOut"),
      (totals) =>
        `${formatCount(totals.tokens.input)} / ${formatCount(totals.tokens.output)} / ${formatCount(totals.tokens.cacheRead)} / ${formatCount(totals.tokens.cacheWrite)}`,
    ),
  );
  out.push(row(t("md.actualCostCNY"), (totals) => formatCNY(totals.cost.cny.known)));
  out.push(row(t("md.estCostCNY"), (totals) => formatCNY(totals.cost.cny.estimated)));
  out.push(row(t("md.actualCostUSD"), (totals) => formatUSD(totals.cost.usd.known)));
  out.push(row(t("md.messages"), (totals) => formatInt(totals.messages.total)));
  out.push(row(t("md.activeDays"), (totals) => formatInt(totals.activeDays)));
  out.push(row(t("md.sessions"), (totals) => formatInt(totals.sessions)));
  out.push("");

  // 每日明细
  out.push(`## ${t("md.daily")}`);
  out.push(`| ${[t("md.date"), t("md.billed"), t("col.input"), t("col.output"), t("col.cacheRead"), t("md.actualCostCNY"), t("md.messages")].join(" | ")} |`);
  out.push(`| ${Array.from({ length: 7 }, () => "---").join(" | ")} |`);
  if (input.daily.length === 0) {
    out.push(`| ${t("empty.range")} |  |  |  |  |  |  |`);
  } else {
    for (const entry of input.daily) {
      out.push(
        `| ${entry.day} | ${formatCount(entry.totals.tokens.billed)} | ${formatCount(entry.totals.tokens.input)} | ` +
          `${formatCount(entry.totals.tokens.output)} | ${formatCount(entry.totals.tokens.cacheRead)} | ` +
          `${formatCNY(entry.totals.cost.cny.known)} | ${formatInt(entry.totals.messages.total)} |`,
      );
    }
  }
  out.push("");

  // 分解表
  if (input.breakdown !== undefined) {
    out.push(`## ${t("md.byDimension", { dimension: t(`dim.${input.breakdown.dimension}`) })}`);
    out.push(`| ${[t("col.name"), t("md.billed"), t("md.share"), t("md.actualCostCNY")].join(" | ")} |`);
    out.push(`| ${Array.from({ length: 4 }, () => "---").join(" | ")} |`);
    for (const group of input.breakdown.groups) {
      out.push(
        `| ${group.label} | ${formatCount(group.totals.tokens.billed)} | ${formatPercent(group.share)} | ${formatCNY(group.totals.cost.cny.known)} |`,
      );
    }
    out.push("");
  }

  // 数据源
  out.push(`## ${t("md.source")}`);
  out.push(
    t("md.sourceLine", {
      files: formatInt(input.files),
      records: formatInt(input.records),
      skipped: formatInt(input.dedupeSkipped),
      updated: input.updatedAt ?? "—",
    }),
  );
  out.push("");
  return out.join("\n");
}

/** 供 `/api/export?format=json` 与仪表盘共用的 JSON 序列化规范。 */
export function toExportJson(result: AggregateResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
