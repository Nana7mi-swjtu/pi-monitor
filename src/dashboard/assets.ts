/**
 * dashboard/assets.ts — 内嵌 HTML / CSS / JS（10.3 技术约束、9.2 文案规范）。
 * 需求：FR-8（仪表盘）、FR-9（导出，浏览器侧 Blob 生成）、FR-13（语言即时切换）、
 *       9.1（数字与货币格式，前端为同一算法的镜像）、9.2（文案）、10.1（页面结构）、
 *       10.3（无 CDN / 无外部字体 / 安全响应头配合）、NFR-11（可访问性）、NFR-14（首屏）
 *
 * 资产以字符串常量内嵌，运行时拼装（10.3）：不使用 public/ 外链，避免打包与路径问题。
 */

import type { Locale, RateSource } from "../types.ts";

export interface RenderOptions {
  locale: Locale;
  i18n: Record<string, Record<string, string>>;
  token: string;
  config: {
    defaultWindow: string | number;
    theme: string;
    locale: string;
    tableLimit: number;
    /** ¥8：是否在页面上自动重取汇率（跟随 `currency.autoRate`）。 */
    autoRate?: boolean;
    /** 页面存活时的自动刷新开关（`dashboard.autoRefresh`）。 */
    autoRefresh?: boolean;
    currency: {
      code: "CNY";
      symbol: "¥";
      rate: number;
      rateSource: RateSource;
      autoRate?: boolean;
      rateFetchedAt?: string | null;
    };
  };
}

const STYLES = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --border: #e2e5ea; --text: #1c2024; --muted: #6b7280;
  --accent: #2563eb; --accent-soft: #dbeafe; --danger: #dc2626; --warn: #b45309;
  --h0: #ebedf0; --h1: #c6e48b; --h2: #7bc96f; --h3: #239a3b; --h4: #196127;
  --grid: #e2e5ea;
}
:root[data-theme="dark"] {
  --bg: #10141a; --panel: #171c24; --border: #2a3140; --text: #e6e9ee; --muted: #98a2b3;
  --accent: #60a5fa; --accent-soft: #1e293b; --danger: #f87171; --warn: #fbbf24;
  --h0: #1f242c; --h1: #0e4429; --h2: #006d32; --h3: #26a641; --h4: #39d353;
  --grid: #2a3140;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue",
    "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px; line-height: 1.5;
}
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
a { color: var(--accent); }
.wrap { max-width: 1280px; margin: 0 auto; padding: 16px 16px 48px; }
header.top {
  display: flex; flex-wrap: wrap; gap: 12px; align-items: center;
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  padding: 12px 16px; position: sticky; top: 0; z-index: 20;
}
.brand { font-weight: 700; font-size: 18px; letter-spacing: .2px; }
.rate { color: var(--muted); font-size: 12px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; align-items: center; }
label.ctl { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
select, input[type="text"], input[type="number"], button {
  font: inherit; color: var(--text); background: var(--panel);
  border: 1px solid var(--border); border-radius: 8px; padding: 5px 9px;
}
select:focus-visible, input:focus-visible, button:focus-visible, [tabindex]:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px;
}
button { cursor: pointer; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button:disabled { opacity: .55; cursor: not-allowed; }
section.panel {
  background: var(--panel); border: 1px solid var(--border); border-radius: 12px;
  padding: 14px 16px; margin-top: 14px;
}
h2.sec { font-size: 14px; margin: 0 0 10px; display: flex; align-items: center; gap: 8px; }
h2.sec .hint { color: var(--muted); font-weight: 400; font-size: 12px; }
.warnbar { border: 1px solid var(--warn); border-radius: 12px; padding: 10px 14px; margin-top: 14px; color: var(--warn); }
.warnbar ul { margin: 6px 0 0; padding-left: 18px; }
.progress { height: 6px; border-radius: 4px; background: var(--h0); overflow: hidden; margin-top: 8px; }
.progress > i { display: block; height: 100%; background: var(--accent); width: 0; transition: width .2s; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
.card { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.card .k { color: var(--muted); font-size: 12px; }
.card .v { font-size: 20px; font-weight: 650; margin-top: 2px; word-break: break-all; }
.card .d { font-size: 11px; color: var(--muted); margin-top: 2px; }
/* 10.1.5 / AC-8.9~8.10：柱宽与列宽一律由 trendLayout() 算出后行内设置。
   禁止在纵向容器上用 flex 简写设定主轴尺寸（那会把柱高钉死并让柱宽停为 0，见 ADR-0003）。 */
.trend-scroll { overflow-x: auto; padding-bottom: 4px; }
.trend { display: flex; align-items: flex-end; height: 140px; padding-top: 6px; width: max-content; margin: 0 auto; }
.trend .col { display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 4px; flex: 0 0 auto; }
.trend .bar { background: var(--accent); border-radius: 3px 3px 0 0; }
.trend .lab { font-size: 11px; line-height: 14px; color: var(--muted); white-space: nowrap; }
h2.sec #daily-toggle { margin-left: auto; }
/* 10.1.4 / AC-8.7~8.8：月份标签行 + 星期标签列 + 网格共用一个横向滚动容器，保证列对齐。 */
.heat-wrap { overflow-x: auto; padding-bottom: 4px; }
.heat-inner { width: max-content; margin: 0 auto; }
.heat-months { position: relative; height: 15px; margin-left: 34px; }
.heat-months span { position: absolute; top: 0; font-size: 11px; line-height: 15px; color: var(--muted); white-space: nowrap; }
.heat-body { display: flex; gap: 6px; }
.heat-days { display: grid; grid-template-rows: repeat(7, 12px); gap: 3px; width: 28px; font-size: 10px; color: var(--muted); }
.heat-days span { line-height: 12px; text-align: right; }
.heat { display: grid; grid-auto-flow: column; grid-template-rows: repeat(7, 12px); gap: 3px; }
.heat .cell { width: 12px; height: 12px; border-radius: 2px; background: var(--h0); }
.heat .cell.pad { background: none; }
.heat .cell.l1 { background: var(--h1); } .heat .cell.l2 { background: var(--h2); }
.heat .cell.l3 { background: var(--h3); } .heat .cell.l4 { background: var(--h4); }
.heat-years { display: flex; gap: 6px; flex-wrap: wrap; margin-left: auto; }
.heat-years button { font-size: 12px; padding: 2px 8px; }
.heat-years button[aria-selected="true"] { background: var(--accent-soft); border-color: var(--accent); }
.legend { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; flex-wrap: wrap; margin-top: 8px; }
.legend .sw { width: 12px; height: 12px; border-radius: 2px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { border-bottom: 1px solid var(--border); padding: 6px 8px; text-align: right; white-space: nowrap; }
th:first-child, td:first-child { text-align: left; }
thead th { color: var(--muted); font-weight: 600; font-size: 12px; }
.tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.tabs button[aria-selected="true"] { background: var(--accent-soft); border-color: var(--accent); }
.actions { display: flex; gap: 8px; flex-wrap: wrap; }
.bar-line { margin-bottom: 10px; }
.bar-line .t { display: flex; justify-content: space-between; font-size: 12px; color: var(--muted); }
.bar-line .track { height: 8px; background: var(--h0); border-radius: 4px; overflow: hidden; margin-top: 4px; }
.bar-line .track > i { display: block; height: 100%; background: var(--accent); }
.bar-line.over .track > i { background: var(--danger); }
.bar-line.over .t { color: var(--danger); }
.muted { color: var(--muted); }
.scroll { overflow-x: auto; }
footer.bottom { margin-top: 18px; color: var(--muted); font-size: 12px; display: flex; gap: 14px; flex-wrap: wrap; }
aside.drawer {
  position: fixed; inset: 0 0 0 auto; width: min(420px, 100%); background: var(--panel);
  border-left: 1px solid var(--border); padding: 18px; overflow-y: auto; z-index: 40;
  transform: translateX(102%); transition: transform .18s ease;
}
aside.drawer[data-open="true"] { transform: none; }
aside.drawer .row { margin-bottom: 12px; }
aside.drawer label { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
aside.drawer input[type="number"], aside.drawer input[type="text"], aside.drawer select { width: 100%; }
.scrim { position: fixed; inset: 0; background: rgba(0,0,0,.35); z-index: 35; display: none; }
.scrim[data-open="true"] { display: block; }
dl.kv { display: grid; grid-template-columns: minmax(140px, 240px) 1fr; gap: 4px 14px; margin: 0; }
dl.kv dt { color: var(--muted); } dl.kv dd { margin: 0; }
details summary { cursor: pointer; }
.toast {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  padding: 8px 14px; z-index: 60; box-shadow: 0 6px 24px rgba(0,0,0,.14);
}
@media (max-width: 720px) {
  .cards { grid-template-columns: 1fr 1fr; }
  header.top { position: static; }
}
`;

/**
 * 8.4 / 10.1.4~10.1.5 / AC-8.7~AC-8.10：图表布局纯函数（ADR-0003 D-5）。
 *
 * 本常量同时用于两处，不存在第二份实现：
 *   1) 拼在页面脚本最前面，由浏览器执行；
 *   2) 由 `test/unit/dashboard-layout.test.ts` 用 `new Function(CHART_JS)` 执行后逐条断言。
 *
 * 书写约束：字符串内不得出现反引号与 `${`（否则会截断/介入外层模板字面量）。
 */
export const CHART_JS = String.raw`"use strict";
/* 10.1.5：趋势图柱高上限（px）。 */
var TREND_PLOT_HEIGHT = 118;
var TREND_MIN_STEP = 18;
var TREND_MAX_STEP = 72;
var TREND_GAP = 3;
var TREND_LABEL_MIN_PX = 44;
var TREND_WIDE_LABEL_PX = 40;
/* 8.4：热力图单元格尺寸（必须与 CSS 中的 12px / 3px 一致）。 */
var HEAT_CELL = 12;
var HEAT_GAP = 3;

/* ISO 日键 ±n 天（只用 UTC 民用运算，不受时区/夏令时影响）。 */
function addDays(day, delta) {
  var p = day.split("-");
  var ms = Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) + delta * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/* b - a（单位：天）。 */
function dayOffset(a, b) {
  var pa = a.split("-");
  var pb = b.split("-");
  var ma = Date.UTC(Number(pa[0]), Number(pa[1]) - 1, Number(pa[2]));
  var mb = Date.UTC(Number(pb[0]), Number(pb[1]) - 1, Number(pb[2]));
  return Math.round((mb - ma) / 86400000);
}

/*
 * AC-8.9：列宽由「天数」与「可用宽度」共同决定，所以图表总宽随天数联动；
 * 恰好能放下时总宽（含列间隙）≤ 容器宽，放不下时 step 停在下限并由外层横向滚动。
 */
function trendLayout(dayCount, availableWidth) {
  var n = Math.max(1, Math.floor(dayCount || 0));
  var avail = Math.floor(availableWidth || 0);
  if (!isFinite(avail) || avail <= 0) avail = TREND_MIN_STEP * n;
  var gap = TREND_GAP;
  /* (n - 1) 个间隙必须一起计入，否则刚好“放得下”时仍会多出一条横向滚动。 */
  var step = Math.floor((avail - (n - 1) * gap) / n);
  if (step > TREND_MAX_STEP) step = TREND_MAX_STEP;
  if (step < TREND_MIN_STEP) step = TREND_MIN_STEP;
  return {
    step: step,
    gap: gap,
    barWidth: Math.max(2, step - gap - 1),
    width: step * n + (n - 1) * gap,
    labelEvery: Math.max(1, Math.ceil(TREND_LABEL_MIN_PX / step)),
    wideLabel: step >= TREND_WIDE_LABEL_PX
  };
}

/*
 * AC-8.10：日期标签。
 * 候选 = 抽稀位 + 每月 1 日；再按「像素间距 ≥ TREND_LABEL_MIN_PX」贪心取舍，
 * 因此任意两个非空标签都不会重叠（月起点优先保留，必要时挤掉旁边的普通标签）。
 * 返回与 days 等长的数组，空字符串表示该列不显示标签。
 */
function trendLabels(days, layout) {
  var i;
  var out = new Array(days.length);
  for (i = 0; i < days.length; i += 1) out[i] = "";

  var candidates = [];
  for (i = 0; i < days.length; i += 1) {
    var monthStart = days[i].slice(8) === "01";
    if (!monthStart && i % layout.labelEvery !== 0) continue;
    candidates.push({ index: i, monthStart: monthStart });
  }
  /* 月起点先占位（它们互不冲突：相邻月起点至少相距 28 天）。 */
  candidates.sort(function (a, b) {
    if (a.monthStart !== b.monthStart) return a.monthStart ? -1 : 1;
    return a.index - b.index;
  });

  var taken = [];
  for (i = 0; i < candidates.length; i += 1) {
    var pixel = candidates[i].index * layout.step;
    var free = true;
    for (var t = 0; t < taken.length; t += 1) {
      if (Math.abs(taken[t] * layout.step - pixel) < TREND_LABEL_MIN_PX) { free = false; break; }
    }
    if (free) taken.push(candidates[i].index);
  }

  for (i = 0; i < taken.length; i += 1) {
    var day = days[taken[i]];
    var isFirst = day.slice(8) === "01";
    out[taken[i]] = (layout.wideLabel || isFirst) ? day.slice(5) : day.slice(8);
  }
  return out;
}

/*
 * AC-8.7：月份标签行的列位置。
 * 某列「首个在范围内日期的月份」与前一列不同时，就在该列打一个标签。
 */
function heatmapMonthCols(grid) {
  var out = [];
  var prevMonth = -1;
  for (var col = 0; col < grid.weeks; col += 1) {
    var first = null;
    for (var row = 0; row < 7; row += 1) {
      var day = addDays(grid.startDay, col * 7 + row);
      if (day >= grid.fromDay && day <= grid.toDay) { first = day; break; }
    }
    if (first === null) continue;
    var month = Number(first.slice(5, 7));
    if (month === prevMonth) continue;
    out.push({ col: col, month: month, left: col * (HEAT_CELL + HEAT_GAP) });
    prevMonth = month;
  }
  return out;
}

/*
 * AC-8.8 / 10.1.4：热力图网格 → 单元格列表（纯函数，测试执行同一份源码）。
 * pad 为真表示该日不属于统计范围（无背景、不可聚焦）；其余格子即使当日无记录
 * 也按 0 值日上色（图例首档就是「0」）。
 */
function heatmapCells(grid, daily, edges) {
  var byDay = {};
  (daily || []).forEach(function (row) { byDay[row.day] = row; });
  var levels = edges || [0, 0, 0];
  var cells = [];
  for (var i = 0; i < grid.weeks * 7; i += 1) {
    var key = addDays(grid.startDay, i);
    var pad = key < grid.fromDay || key > grid.toDay;
    var row = pad ? null : byDay[key];
    var value = row ? row.totals.tokens.billed : 0;
    var level = 0;
    if (value > 0) {
      if (value <= levels[0]) level = 1;
      else if (value <= levels[1]) level = 2;
      else if (value <= levels[2]) level = 3;
      else level = 4;
    }
    cells.push({
      day: key,
      pad: pad,
      value: value,
      sessions: row ? row.totals.sessions : 0,
      level: pad ? 0 : level,
    });
  }
  return cells;
}
`;

const APP_JS = String.raw`
"use strict";
const BOOT = window.__PI_MONITOR_BOOT__;
const TOKEN = BOOT.token;
const I18N = BOOT.i18n;
const BOOT_CONFIG = BOOT.config || {};
const BOOT_CURRENCY = BOOT_CONFIG.currency || {};
const BOOT_DASHBOARD = BOOT_CONFIG.dashboard || {};
/* ¥8：自动汇率的重取间隔（与服务端 rates.AUTO_RATE_TTL_MS 一致）。 */
const AUTO_RATE_TTL_MS = 12 * 60 * 60 * 1000;
/* 页面存活时的自动刷新间隔（dashboard.autoRefresh）。 */
const AUTO_REFRESH_MS = 30000;
/* 汇率获取失败后的静默期（避免网络不通时每 30 s 重试）。 */
const RATE_RETRY_BACKOFF_MS = 10 * 60 * 1000;
const state = {
  window: BOOT_CONFIG.defaultWindow || "last7d",
  from: null,
  to: null,
  /* AC-8.2 / D-3：图表固定按计费 Token 统计，不再有指标切换状态。 */
  dim: "model",
  locale: BOOT_CONFIG.locale,
  theme: BOOT_CONFIG.theme,
  rate: BOOT_CURRENCY.rate,
  rateSource: BOOT_CURRENCY.rateSource || "manual",
  rateFetchedAt: BOOT_CURRENCY.rateFetchedAt || null,
  autoRate: BOOT_CURRENCY.autoRate === true,
  autoRefresh: BOOT_DASHBOARD.autoRefresh !== false,
  refreshTimer: null,
  lastLoadAt: 0,
  ratePending: false,
  rateFailedAt: 0,
  summary: null,
  daily: null,
  heat: null,
  /* 8.4 / AC-8.8：热力图年份选择。null = 最近一年；heatAll 为全量日表（用于推导可选年份）。 */
  heatYear: null,
  heatAll: null,
  heatYears: [],
  breakdown: null,
  health: null,
  config: BOOT_CONFIG,
  loading: false,
  error: null,
  scanTimer: null,
};

/* ------------------------------------------------------------------ i18n */
function humanize(key) {
  const leaf = key.indexOf(".") >= 0 ? key.slice(key.lastIndexOf(".") + 1) : key;
  const spaced = leaf.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
function t(key, params) {
  const dict = I18N[state.locale] || {};
  const en = I18N["en-US"] || {};
  let text = dict[key];
  if (text === undefined) text = en[key];
  if (text === undefined) text = humanize(key);
  return text.replace(/\{(\w+)\}/g, function (m, name) {
    return params && params[name] !== undefined ? String(params[name]) : m;
  });
}
function esc(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/* ------------------------------------------------- 9.1 数字与货币格式（镜像） */
function fmtCount(value) {
  if (!isFinite(value)) return "0";
  const abs = Math.abs(value);
  const units = [[1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (let i = 0; i < units.length; i += 1) {
    if (abs < units[i][0]) continue;
    const scaled = value / units[i][0];
    const text = scaled.toFixed(1);
    const parsed = parseFloat(text);
    if (parsed >= 1000 && i > 0) {
      const up = value / units[i - 1][0];
      const upText = up.toFixed(1);
      const upParsed = parseFloat(upText);
      return upParsed >= 10 ? Math.round(upParsed) + units[i - 1][1] : upText + units[i - 1][1];
    }
    return parsed >= 10 ? Math.round(parsed) + units[i][1] : text + units[i][1];
  }
  return String(Math.round(value));
}
function fmtInt(value) {
  if (!isFinite(value)) return "0";
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function fmtAmount(value, symbol) {
  if (value === null || value === undefined || !isFinite(value)) return "\u2014";
  const abs = Math.abs(value);
  const decimals = abs >= 100 ? 2 : 4;
  const fixed = value.toFixed(decimals);
  if (abs >= 10000) {
    const negative = fixed.charAt(0) === "-";
    const body = negative ? fixed.slice(1) : fixed;
    const parts = body.split(".");
    const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return symbol + (negative ? "-" : "") + grouped + (parts[1] !== undefined ? "." + parts[1] : "");
  }
  return symbol + fixed;
}
function fmtCNY(value) { return fmtAmount(value, "\u00a5"); }
function fmtUSD(value) { return fmtAmount(value, "$"); }
function fmtPercent(ratio) { return isFinite(ratio) ? (ratio * 100).toFixed(1) + "%" : "0.0%"; }
function fmtRate(rate) { return "1 USD = " + rate.toFixed(2) + " CNY"; }
/* ¥8 / ¥4：汇率行必须可追溯到来源（手动设置 / 自动获取）。 */
function rateSourceLabel() {
  return state.rateSource === "auto" ? t("rate.source.auto") : t("rate.source.manual");
}
function rateText() {
  return t("rate.line", { rate: state.rate.toFixed(2), source: rateSourceLabel() });
}
function fmtISO(date) {
  const p = function (n) { return n < 10 ? "0" + n : String(n); };
  return date.getFullYear() + "-" + p(date.getMonth() + 1) + "-" + p(date.getDate()) +
    " " + p(date.getHours()) + ":" + p(date.getMinutes()) + ":" + p(date.getSeconds());
}

/* -------------------------------------------------------------------- API */
async function api(path, options) {
  const opts = options || {};
  const headers = Object.assign({ "X-Pi-Monitor-Token": TOKEN }, opts.headers || {});
  const res = await fetch(path, Object.assign({}, opts, { headers: headers }));
  if (!res.ok) {
    let reason = res.status + " " + res.statusText;
    try {
      const body = await res.json();
      if (body && body.error) reason = body.error;
    } catch (e) { /* 保持状态码文本 */ }
    throw new Error(reason);
  }
  if (res.status === 304) return null;
  return res.json();
}
function query(extra) {
  const params = new URLSearchParams();
  if (state.from && state.to) { params.set("from", state.from); params.set("to", state.to); }
  else { params.set("window", String(state.window)); }
  Object.keys(extra || {}).forEach(function (key) {
    if (extra[key] !== undefined && extra[key] !== null) params.set(key, String(extra[key]));
  });
  return params.toString();
}

/* ----------------------------------------------------------------- render */
function applyTheme() {
  const mode = state.theme === "auto"
    ? (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : state.theme;
  document.documentElement.setAttribute("data-theme", mode);
}
function showToast(message) {
  const node = document.getElementById("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(node.__timer);
  node.__timer = setTimeout(function () { node.hidden = true; }, 3200);
}
function renderChrome() {
  document.getElementById("btn-rescan").textContent = t("action.rescan");
  document.getElementById("btn-rebuild").textContent = t("action.rebuild");
  document.getElementById("btn-settings").textContent = t("action.settings");
  document.getElementById("btn-refresh").textContent = t("header.refresh");
  document.getElementById("btn-lang").textContent = state.locale === "zh-CN" ? "EN" : "\u4e2d\u6587";
  document.getElementById("rate-line").textContent = rateText();
  document.getElementById("lbl-rate").textContent = t("settings.rate");
  document.getElementById("lbl-autorate").textContent = t("settings.autoRate");
  document.getElementById("lbl-autorefresh").textContent = t("settings.autoRefresh");
  document.getElementById("btn-rate-refresh").textContent = t("settings.rateRefresh");
  document.getElementById("footer-privacy").textContent = t("footer.privacy");
  document.getElementById("footer-hint").textContent = t("footer.hint");
  document.getElementById("sec-overview").textContent = t("md.overview");
  document.getElementById("sec-heatmap").textContent = t("heatmap.title");
  document.getElementById("sec-trend").textContent = t("daily.title");
  document.getElementById("sec-breakdown").textContent = t("breakdown.title");
  document.getElementById("sec-budget").textContent = t("budget.title");
  document.getElementById("sec-actions").textContent = t("action.settings");
  document.getElementById("sec-health").textContent = t("health.title");
  document.getElementById("drawer-title").textContent = t("settings.title");
  document.getElementById("lbl-locale").textContent = t("settings.locale");
  document.getElementById("lbl-theme").textContent = t("settings.theme");
  document.getElementById("lbl-budget-enabled").textContent = t("settings.budgetEnabled");
  document.getElementById("lbl-daily").textContent = t("settings.dailyCNY");
  document.getElementById("lbl-monthly").textContent = t("settings.monthlyCNY");
  document.getElementById("lbl-estimated").textContent = t("settings.includeEstimated");
  document.getElementById("lbl-lan").textContent = t("settings.allowLan");
  document.getElementById("btn-save-settings").textContent = t("settings.save");
  document.getElementById("btn-export-md").textContent = t("action.exportMd");
  document.getElementById("btn-export-json").textContent = t("action.exportJson");
  document.getElementById("btn-export-csv").textContent = t("action.exportCsv");
  const windowSelect = document.getElementById("window");
  Array.prototype.forEach.call(windowSelect.options, function (option) {
    option.textContent = t("window." + option.value);
  });
  Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (node) {
    node.textContent = t("dim." + node.getAttribute("data-dim"));
  });
  document.getElementById("window-from").placeholder = t("window.from");
  document.getElementById("window-to").placeholder = t("window.to");
  document.getElementById("btn-apply-window").textContent = t("window.apply");
  document.getElementById("daily-toggle").textContent = document.getElementById("daily-body").hidden
    ? t("daily.expand") : t("daily.collapse");
  renderHeatYears();
  Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (node) {
    node.textContent = t(node.getAttribute("data-i18n"));
  });
}
/* AC-8.8：年份选项卡 = 「最近一年」+ 数据中出现过的年份（倒序）。 */
function renderHeatYears() {
  const node = document.getElementById("heat-years");
  if (!node) return;
  const options = [{ value: null, label: t("heatmap.year.recent") }];
  state.heatYears.forEach(function (year) { options.push({ value: year, label: String(year) }); });
  if (options.length <= 1) { node.innerHTML = ""; return; }
  node.innerHTML = options.map(function (option) {
    const raw = option.value === null ? "" : String(option.value);
    const selected = state.heatYear === option.value ? "true" : "false";
    return "<button type=\"button\" role=\"tab\" data-year=\"" + raw + "\" aria-selected=\"" + selected + "\">" +
      esc(option.label) + "</button>";
  }).join("");
}
/* 全量日表 → 出现过数据的年份（倒序）。 */
function listYears(heat) {
  const seen = {};
  const daily = (heat && heat.daily) || [];
  for (let i = 0; i < daily.length; i += 1) seen[daily[i].day.slice(0, 4)] = true;
  return Object.keys(seen).map(Number).sort(function (a, b) { return b - a; });
}
function warningsFrom(health, config) {
  const out = [];
  if (config && config.dedupe === "off") out.push({ key: "warn.dedupeOff", detail: null });
  if (config && config.dashboard && config.dashboard.allowLan) out.push({ key: "warn.allowLan", detail: null });
  if (health && health.status === "readonly") out.push({ key: "warn.schemaHigher", detail: null });
  if (health && health.tzChanged) out.push({ key: "warn.tzChanged", detail: null });
  if (health && health.lockTimeout) out.push({ key: "warn.lockTimeout", detail: null });
  if (health) {
    const damaged = (health.corruptLines || 0) + (health.invalidSessions || 0) +
      (health.inconsistencyCount || 0) + (health.corruptCost || 0) + (health.corruptUsage || 0) +
      (health.corruptDuplicateIds || 0);
    if (damaged > 0) out.push({ key: "warn.corrupt", params: { count: damaged }, detail: health });
    if ((health.configWarnings || []).length > 0) {
      out.push({ key: "warn.corrupt", params: { count: health.configWarnings.length }, detail: { configWarnings: health.configWarnings } });
    }
  }
  return out;
}
function renderWarnings() {
  const node = document.getElementById("warnings");
  const items = warningsFrom(state.health, state.config);
  if (items.length === 0) { node.innerHTML = ""; node.hidden = true; return; }
  node.hidden = false;
  node.innerHTML = items.map(function (item) {
    const details = item.detail
      ? " <details style=\"display:inline-block\"><summary>" + esc(t("warn.details")) + "</summary><pre class=\"mono\" style=\"white-space:pre-wrap;font-size:11px\">" +
        esc(JSON.stringify(item.detail, null, 2)) + "</pre></details>"
      : "";
    return "<div>" + esc(t(item.key, item.params)) + details + "</div>";
  }).join("");
}
function renderScanState() {
  const node = document.getElementById("scan-state");
  const health = state.health;
  if (!health) { node.hidden = true; return; }
  if (health.scanning) {
    node.hidden = false;
    node.innerHTML = esc(t("header.scanningProgress", { progress: Math.round((health.progress || 0) * 100) })) +
      "<div class=\"progress\"><i style=\"width:" + Math.round((health.progress || 0) * 100) + "%\"></i></div>";
  } else {
    node.hidden = true;
    node.innerHTML = "";
  }
  document.getElementById("rev").textContent =
    t("header.revision") + " " + (health.revision || 0) + (health.lastScanAt ? " \u00b7 " + t("header.updated") + " " + fmtISO(new Date(health.lastScanAt)) : "");
}
function card(label, value, delta) {
  return "<div class=\"card\"><div class=\"k\">" + esc(label) + "</div><div class=\"v\">" + esc(value) +
    "</div>" + (delta ? "<div class=\"d\">" + esc(delta) + "</div>" : "") + "</div>";
}
function deltaText(current, previous, hasData, isMoney) {
  if (!hasData || previous === null || previous === undefined) return t("card.noPrev");
  if (previous === 0) return t("card.vsPrev") + " \u2014";
  const ratio = (current - previous) / previous;
  return t("card.vsPrev") + " " + (ratio >= 0 ? "+" : "") + fmtPercent(ratio);
}
function renderCards() {
  const node = document.getElementById("cards");
  const summary = state.summary;
  if (!summary) { node.innerHTML = "<div class=\"muted\">" + esc(t("state.loading")) + "</div>"; return; }
  const totals = summary.totals;
  const prev = summary.comparison ? summary.comparison.totals : null;
  const hasPrev = !!(summary.comparison && summary.comparison.hasData);
  const live = summary.live;
  const html = [];
  html.push(card(t("card.billed"), fmtCount(totals.tokens.billed), deltaText(totals.tokens.billed, prev ? prev.tokens.billed : null, hasPrev)));
  html.push(card(t("card.input"), fmtCount(totals.tokens.input)));
  html.push(card(t("card.output"), fmtCount(totals.tokens.output)));
  html.push(card(t("card.cacheRead"), fmtCount(totals.tokens.cacheRead)));
  html.push(card(t("card.cacheWrite"), fmtCount(totals.tokens.cacheWrite)));
  html.push(card(t("card.costKnown"), fmtCNY(totals.cost.cny.known), deltaText(totals.cost.cny.known || 0, prev ? prev.cost.cny.known : null, hasPrev && prev && prev.cost.cny.known !== null)));
  html.push(card(t("card.costEstimated"), fmtCNY(totals.cost.cny.estimated)));
  html.push(card(t("card.messages"), fmtInt(totals.messages.total)));
  html.push(card(t("card.activeDays"), fmtInt(totals.activeDays)));
  html.push(card(t("card.sessions"), fmtInt(totals.sessions)));
  if (live) {
    html.push(card(t("card.live"), fmtCount(live.tokens.billed), t("card.liveNote") + " \u00b7 " + fmtCNY(live.cost.cny.known)));
  }
  node.innerHTML = html.join("");
}
function renderHeatmap() {
  const node = document.getElementById("heat");
  const monthsNode = document.getElementById("heat-months");
  const daysNode = document.getElementById("heat-days");
  const legendNode = document.getElementById("heat-legend");
  const heat = state.heat;
  const grid = heat && heat.grid;
  if (!heat || !heat.daily || !grid) {
    node.innerHTML = ""; monthsNode.innerHTML = ""; daysNode.innerHTML = ""; legendNode.innerHTML = "";
    return;
  }
  const edges = (heat.buckets && heat.buckets.edges) || [0, 0, 0];

  // 8.4：网格区间由服务端下发的 grid 给出（按 weekStart 对齐），前端不自算周对齐。
  // AC-8.2 / D-3：指标固定为计费 Token。
  const cells = [];
  heatmapCells(grid, heat.daily, edges).forEach(function (cell) {
    // 8.4：补齐格（不属于统计范围）不算 0 值日，无背景也不可聚焦。
    if (cell.pad) { cells.push("<span class=\"cell pad\"></span>"); return; }
    const label = t("heatmap.cell", { day: cell.day, value: fmtInt(cell.value), sessions: cell.sessions });
    cells.push("<span class=\"cell l" + cell.level + "\" tabindex=\"0\" role=\"img\" title=\"" + esc(label) + "\" aria-label=\"" + esc(label) + "\"></span>");
  });
  node.innerHTML = cells.join("");

  // AC-8.7：上方月份标签行（与网格同处一个滚动容器，列对齐不会错位）。
  monthsNode.style.width = (grid.weeks * (HEAT_CELL + HEAT_GAP) - HEAT_GAP) + "px";
  monthsNode.innerHTML = heatmapMonthCols(grid).map(function (item) {
    return "<span style=\"left:" + item.left + "px\">" + esc(t("month." + item.month)) + "</span>";
  }).join("");

  // AC-8.7：左侧星期标签列，每隔一行标注（行 0/2/4）；顺序随 weekStart 变化（0=周日…6=周六）。
  const order = grid.weekStart === "sunday" ? [0, 1, 2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6, 0];
  const dayLabels = [];
  for (let r = 0; r < 7; r += 1) {
    dayLabels.push(r === 0 || r === 2 || r === 4 ? esc(t("weekday." + order[r])) : "");
  }
  daysNode.innerHTML = dayLabels.map(function (text) { return "<span>" + text + "</span>"; }).join("");

  const labels = (heat.buckets && heat.buckets.legend) || [];
  legendNode.innerHTML = esc(t("heatmap.less")) + labels.map(function (text, index) {
    return "<span class=\"sw\" style=\"background:var(--h" + Math.min(4, index) + ")\"></span><span>" + esc(text) + "</span>";
  }).join("") + esc(t("heatmap.more"));
  renderHeatYears();
}
function renderTrend() {
  const node = document.getElementById("trend");
  const scroll = document.getElementById("trend-scroll");
  const peakNode = document.getElementById("trend-peak");
  const daily = state.daily && state.daily.daily ? state.daily.daily : [];
  const body = document.getElementById("daily-body");
  const head = "<tr><th>" + esc(t("daily.date")) + "</th><th>" + esc(t("col.billed")) + "</th><th>" +
    esc(t("col.input")) + "</th><th>" + esc(t("col.output")) + "</th><th>" + esc(t("col.cacheRead")) +
    "</th><th>" + esc(t("col.cost")) + "</th><th>" + esc(t("col.messages")) + "</th></tr>";
  if (daily.length === 0) {
    node.innerHTML = "<div class=\"muted\">" + esc(t("empty.range")) + "</div>";
    peakNode.textContent = "";
    body.innerHTML = head;
    return;
  }
  // AC-8.2 / D-3：图表数值恒为当日计费 Token。
  const values = daily.map(function (row) { return row.totals.tokens.billed; });
  const max = Math.max.apply(null, values.concat([1]));
  // AC-8.9：列宽 = f(天数, 容器宽)，所以图表总宽随日期数联动；
  // 宽度不够时 step 停在下限，由 .trend-scroll 横向滚动。
  const layout = trendLayout(daily.length, scroll.clientWidth);
  // 列间隙由 JS 下发（与 trendLayout 的宽度计算保持同一来源）。
  node.style.gap = layout.gap + "px";
  // AC-8.10：标签位置一次性算好（保证不重叠）。
  const labels = trendLabels(daily.map(function (row) { return row.day; }), layout);
  peakNode.textContent = t("daily.peak", { value: fmtInt(max) });
  node.innerHTML = daily.map(function (row, index) {
    const value = row.totals.tokens.billed;
    // AC-8.9：宽高均为行内显式值，不再依赖 flex 主轴尺寸。
    const height = value <= 0 ? 2 : Math.max(2, Math.round((value / max) * TREND_PLOT_HEIGHT));
    return "<div class=\"col\" style=\"width:" + layout.step + "px\" title=\"" +
      esc(row.day + " \u00b7 " + fmtInt(value) + " tokens") + "\">" +
      "<div class=\"bar\" style=\"width:" + layout.barWidth + "px;height:" + height + "px\"></div>" +
      "<div class=\"lab\">" + esc(labels[index]) + "</div></div>";
  }).join("");
  body.innerHTML = head + daily.map(function (row) {
    return "<tr><td>" + esc(row.day) + "</td><td>" + fmtInt(row.totals.tokens.billed) + "</td><td>" +
      fmtInt(row.totals.tokens.input) + "</td><td>" + fmtInt(row.totals.tokens.output) + "</td><td>" +
      fmtInt(row.totals.tokens.cacheRead) + "</td><td>" + esc(fmtCNY(row.totals.cost.cny.known)) + "</td><td>" +
      fmtInt(row.totals.messages.total) + "</td></tr>";
  }).join("");
}
function renderBreakdown() {
  const table = document.getElementById("breakdown-table");
  const result = state.breakdown;
  if (!result || !result.groups || result.groups.length === 0) {
    table.innerHTML = "<tbody><tr><td class=\"muted\">" + esc(t("empty.range")) + "</td></tr></tbody>";
    return;
  }
  const head = "<thead><tr><th>" + esc(t("col.name")) + "</th><th>" + esc(t("col.billed")) + "</th><th>" +
    esc(t("col.input")) + "</th><th>" + esc(t("col.output")) + "</th><th>" + esc(t("col.cacheRead")) +
    "</th><th>" + esc(t("col.cost")) + "</th><th>" + esc(t("col.share")) + "</th><th>" + esc(t("col.messages")) + "</th></tr></thead>";
  const rows = result.groups.map(function (group) {
    return "<tr><td title=\"" + esc(group.key) + "\">" + esc(group.label) + "</td><td>" +
      fmtInt(group.totals.tokens.billed) + "</td><td>" + fmtInt(group.totals.tokens.input) + "</td><td>" +
      fmtInt(group.totals.tokens.output) + "</td><td>" + fmtInt(group.totals.tokens.cacheRead) + "</td><td>" +
      esc(fmtCNY(group.totals.cost.cny.known)) + "</td><td>" + fmtPercent(group.share) + "</td><td>" +
      fmtInt(group.totals.messages.total) + "</td></tr>";
  }).join("");
  table.innerHTML = head + "<tbody>" + rows + "</tbody>";
}
function renderBudget() {
  const node = document.getElementById("budget-body");
  const config = state.config;
  const progress = config && config.budgetProgress;
  const enabled = config && config.budget && config.budget.enabled;
  const rows = [];
  if (enabled && progress) {
    ["daily", "monthly"].forEach(function (period) {
      const item = progress[period];
      if (!item) return;
      const ratio = Math.min(1, Math.max(0, item.ratio));
      rows.push("<div class=\"bar-line" + (item.exceeded ? " over" : "") + "\"><div class=\"t\"><span>" +
        esc(t("budget." + period)) + "</span><span>" + esc(t("budget.progress", { spent: fmtCNY(item.spentCNY), limit: fmtCNY(item.limitCNY) })) +
        (item.exceeded ? " \u00b7 " + esc(t("budget.over", { amount: fmtCNY(item.overCNY) })) : "") +
        "</span></div><div class=\"track\"><i style=\"width:" + Math.round(ratio * 100) + "%\"></i></div></div>");
    });
  }
  node.innerHTML = rows.join("");
  document.getElementById("budget-panel").hidden = rows.length === 0;
}
function renderHealth() {
  const node = document.getElementById("health-body");
  const health = state.health;
  if (!health) { node.innerHTML = ""; return; }  const rows = [
    ["health.files", fmtInt(health.files)],
    ["health.records", fmtInt(health.records)],
    ["health.dedupeSkipped", fmtInt(health.dedupeSkipped)],
    ["health.corruptLines", fmtInt(health.corruptLines)],
    ["health.invalidSessions", fmtInt(health.invalidSessions)],
    ["health.inconsistency", fmtInt(health.inconsistencyCount)],
    ["health.corruptDuplicateIds", fmtInt(health.corruptDuplicateIds)],
    ["health.corruptCost", fmtInt(health.corruptCost)],
    ["health.corruptUsage", fmtInt(health.corruptUsage)],
    ["health.skippedFiles", fmtInt(health.skippedFiles)],
    ["health.ledgerRepaired", fmtInt(health.ledgerRepaired)],
    ["health.tz", health.tz + (health.tzChanged ? " \u26a0" : "")],
    ["health.rateSource", rateSourceLabel() + (state.rateFetchedAt ? " \u00b7 " + fmtISO(new Date(state.rateFetchedAt)) : "")],
    ["health.lastScanMs", fmtInt(health.lastScanMs) + " ms"],
    ["health.indexSize", fmtInt(Math.round(health.indexSizeBytes / 1024)) + " KiB"],
    ["health.dataDir", health.dataDir],
    ["health.startedAt", health.startedAt + " (" + t("health.pid") + " " + health.pid + ")"],
  ];
  if (health.logPath) rows.push(["health.enableDebug", health.logPath]);
  if ((health.unknownKeys || []).length > 0) rows.push(["health.unknownKeys", health.unknownKeys.join(", ")]);
  if ((health.configWarnings || []).length > 0) rows.push(["health.configWarnings", health.configWarnings.join("; ")]);
  node.innerHTML = "<dl class=\"kv\">" + rows.map(function (row) {
    return "<dt>" + esc(t(row[0])) + "</dt><dd class=\"mono\">" + esc(row[1]) + "</dd>";
  }).join("") + "</dl>";
}

function renderFooterMeta() {
  // 10.1 页脚：数据目录（脱敏）、记录数、去重跳过、隐私说明。
  const health = state.health;
  const node = document.getElementById("footer-meta");
  if (!health) {
    node.textContent = "";
    return;
  }
  node.textContent =
    t("health.dataDir") + ": " + health.dataDir + " · " +
    t("health.records") + ": " + fmtInt(health.records) + " · " +
    t("health.dedupeSkipped") + ": " + fmtInt(health.dedupeSkipped);
}

/* ------------------------------------------------------------------ load */
function setError(error) {
  state.error = error ? String(error.message || error) : null;
  const node = document.getElementById("error");
  if (!state.error) { node.hidden = true; node.textContent = ""; return; }
  node.hidden = false;
  node.textContent = t("state.error", { reason: state.error }) + " " + t("state.suggestion", { action: t("header.refresh") });
}
async function loadAll() {
  state.loading = true;
  try {
    const [health, config, summary, daily, heatAll, breakdown] = await Promise.all([
      api("/api/health?ts=" + Date.now()),
      api("/api/config?ts=" + Date.now()),
      api("/api/summary?" + query()),
      api("/api/daily?" + query({ metric: "tokens" })),
      api("/api/daily?" + query({ window: "all", metric: "tokens" })),
      api("/api/breakdown?" + query({ dim: state.dim, limit: state.config.tableLimit || 20 })),
    ]);
    state.health = health;
    applyConfigState(config);
    state.summary = summary;
    state.daily = daily;
    state.heatAll = heatAll;
    state.heatYears = listYears(heatAll);
    // AC-8.8：年份已从数据中消失时回退到「最近一年」。
    if (state.heatYear !== null && state.heatYears.indexOf(state.heatYear) < 0) state.heatYear = null;
    // 8.4：最近一年直接复用 window=all 的响应（其 grid 为最近 53 周）；
    //      选定年份时另取一次（服务端按该自然年重新分桶）。
    state.heat = state.heatYear === null
      ? heatAll
      : await api("/api/daily?year=" + state.heatYear + "&metric=tokens");
    state.breakdown = breakdown;
    setError(null);
    // ¥8：汇率已过 TTL → 后台取一次（不阻塞首屏）；取到新值后用新汇率重新聚合一次。
    if (
      config.currency && config.currency.autoRate && rateIsStale(config.currency.rateFetchedAt) &&
      !state.ratePending && !rateBackoffActive()
    ) {
      state.ratePending = true;
      refreshRate(false).then(function (changed) {
        state.ratePending = false;
        if (changed) loadAll();
      }, function () { state.ratePending = false; });
    }
  } catch (error) {
    setError(error);
  } finally {
    state.loading = false;
    state.lastLoadAt = Date.now();
    renderChrome();
    renderWarnings();
    renderScanState();
    renderCards();
    renderHeatmap();
    renderTrend();
    renderBreakdown();
    renderBudget();
    renderHealth();
    renderFooterMeta();
  }
  if (state.health && state.health.scanning) scheduleScanPoll();
}
/* ¥8：汇率信息同步到页面状态（服务端是唯一真相）。 */
function applyConfigState(config) {
  if (!config) return;
  state.config = config;
  const currency = config.currency || {};
  if (typeof currency.rate === "number") state.rate = currency.rate;
  if (currency.rateSource) state.rateSource = currency.rateSource;
  state.rateFetchedAt = currency.rateFetchedAt || null;
  state.autoRate = currency.autoRate === true;
  if (config.locale) state.locale = config.locale;
  if (config.dashboard && config.dashboard.autoRefresh === false) state.autoRefresh = false;
}
function rateIsStale(fetchedAt) {
  if (!fetchedAt) return true;
  const parsed = Date.parse(fetchedAt);
  return !isFinite(parsed) || (Date.now() - parsed) >= AUTO_RATE_TTL_MS;
}
function rateBackoffActive() {
  return state.rateFailedAt > 0 && (Date.now() - state.rateFailedAt) < RATE_RETRY_BACKOFF_MS;
}

/* 页面存活时的自动刷新（默认开启；可在设置抽屉关闭）。 */
function scheduleAutoRefresh() {
  if (state.refreshTimer) { clearInterval(state.refreshTimer); state.refreshTimer = null; }
  if (!state.autoRefresh) return;
  state.refreshTimer = setInterval(function () {
    // 隐藏的标签页不扫（省 IO）；重新可见时由 visibilitychange 处补一数。
    if (document.hidden) return;
    autoRefresh();
  }, AUTO_REFRESH_MS);
}
async function autoRefresh() {
  if (state.loading || state.scanTimer) return;
  try {
    await api("/api/rescan", { method: "POST" });
    await loadAll();
  } catch (error) { /* 静默：下一个周期重试 */ }
}
async function refreshOnFocus() {
  if (state.loading || state.scanTimer) return;
  if (Date.now() - state.lastLoadAt < AUTO_REFRESH_MS / 2) return;
  await autoRefresh();
}

function scheduleScanPoll() {
  if (state.scanTimer) return;
  state.scanTimer = setTimeout(async function () {
    state.scanTimer = null;
    try {
      const health = await api("/api/health?ts=" + Date.now());
      const wasScanning = state.health && state.health.scanning;
      state.health = health;
      renderScanState();
      // FR-8.3 / AC-8.4：扫描完成后自动刷新数据，无需手动刷新。
      if (wasScanning && !health.scanning) { await loadAll(); return; }
    } catch (error) { /* 轮询失败静默重试 */ }
    if (state.health && state.health.scanning) scheduleScanPoll();
  }, 800);
}

/* ---------------------------------------------------------------- exports */
function download(name, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}
function fileStamp() {
  const d = new Date();
  const p = function (n) { return n < 10 ? "0" + n : String(n); };
  return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}
function windowSlug() {
  if (state.from && state.to) return state.from + "_" + state.to;
  return String(state.window);
}
function csvEscape(value) {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/.test(text) ? "\"" + text.replace(/"/g, "\"\"") + "\"" : text;
}
const CSV_COLUMNS = ["ts","day","tz","provider","model","kind","toolName","input","output","cacheRead","cacheWrite",
  "reasoning","billed","costUsd","costUsdEst","costCny","costCnyEst","sessionId","cwd","project","source","entryId"];

async function exportJson() {
  const result = await api("/api/export?" + query({ format: "json", dim: "model" }));
  download("pi-monitor-" + windowSlug() + "-" + fileStamp() + ".json", JSON.stringify(result, null, 2), "application/json");
}
async function exportMarkdown() {
  const result = await api("/api/export?" + query({ format: "json", dim: "model" }));
  const rate = result.currency.rate;
  const daily = result.daily || [];
  const groups = result.groups || [];
  const lines = [];
  lines.push("# pi-monitor report \u00b7 " + result.window.label + " (" + result.window.from + " \u2192 " + result.window.to + ", " + result.window.tz + ")");
  lines.push("");
  lines.push(t("md.rate", { rate: rate.toFixed(2), source: result.currency.rateSource === "auto" ? t("rate.source.auto") : t("rate.source.manual") }) + " \u00b7 " + t("md.generated") + ": " + fmtISO(new Date(result.generatedAt)));
  lines.push("");
  lines.push("## " + t("md.overview"));
  const headers = [t("md.metric"), result.window.label];
  lines.push("| " + headers.join(" | ") + " |");
  lines.push("| --- | --- |");
  const totals = result.totals;
  lines.push("| " + t("md.billed") + " | " + fmtCount(totals.tokens.billed) + " |");
  lines.push("| " + t("md.inOut") + " | " + fmtCount(totals.tokens.input) + " / " + fmtCount(totals.tokens.output) + " / " + fmtCount(totals.tokens.cacheRead) + " / " + fmtCount(totals.tokens.cacheWrite) + " |");
  lines.push("| " + t("md.actualCostCNY") + " | " + fmtCNY(totals.cost.cny.known) + " |");
  lines.push("| " + t("md.estCostCNY") + " | " + fmtCNY(totals.cost.cny.estimated) + " |");
  lines.push("| " + t("md.actualCostUSD") + " | " + fmtUSD(totals.cost.usd.known) + " |");
  lines.push("| " + t("md.messages") + " | " + fmtInt(totals.messages.total) + " |");
  lines.push("| " + t("md.activeDays") + " | " + fmtInt(totals.activeDays) + " |");
  lines.push("| " + t("md.sessions") + " | " + fmtInt(totals.sessions) + " |");
  lines.push("");
  lines.push("## " + t("md.daily"));
  lines.push("| " + [t("md.date"), t("md.billed"), t("col.input"), t("col.output"), t("col.cacheRead"), t("md.actualCostCNY"), t("md.messages")].join(" | ") + " |");
  lines.push("| " + new Array(7).join("--- | ") + "--- |");
  if (daily.length === 0) lines.push("| " + t("empty.range") + " |  |  |  |  |  |  |");
  daily.forEach(function (row) {
    lines.push("| " + row.day + " | " + fmtCount(row.totals.tokens.billed) + " | " + fmtCount(row.totals.tokens.input) + " | " +
      fmtCount(row.totals.tokens.output) + " | " + fmtCount(row.totals.tokens.cacheRead) + " | " +
      fmtCNY(row.totals.cost.cny.known) + " | " + fmtInt(row.totals.messages.total) + " |");
  });
  lines.push("");
  lines.push("## " + t("md.breakdown"));
  lines.push("| " + [t("col.name"), t("md.billed"), t("md.share"), t("md.actualCostCNY")].join(" | ") + " |");
  lines.push("| --- | --- | --- | --- |");
  groups.forEach(function (group) {
    lines.push("| " + group.label + " | " + fmtCount(group.totals.tokens.billed) + " | " + fmtPercent(group.share) + " | " + fmtCNY(group.totals.cost.cny.known) + " |");
  });
  lines.push("");
  lines.push("## " + t("md.source"));
  const health = state.health || {};
  lines.push(t("md.sourceLine", {
    files: fmtInt(health.files || 0), records: fmtInt(health.records || 0),
    skipped: fmtInt(health.dedupeSkipped || 0), updated: health.lastScanAt ? fmtISO(new Date(health.lastScanAt)) : "\u2014",
  }));
  lines.push("");
  download("pi-monitor-" + windowSlug() + "-" + fileStamp() + ".md", lines.join("\n"), "text/markdown;charset=utf-8");
}
async function exportCsv() {
  const rate = state.rate;
  const lines = [];
  lines.push("# rate=" + rate.toFixed(2) + " generated=" + new Date().toISOString());
  lines.push(CSV_COLUMNS.join(","));
  let cursor = null;
  for (let page = 0; page < 200; page += 1) {
    const payload = await api("/api/records?" + query({ limit: 500 }) + (cursor ? "&cursor=" + cursor : ""));
    payload.records.forEach(function (record) {
      const costCny = record.costUsd === null ? null : Math.round(record.costUsd * rate * 1e6) / 1e6;
      const costCnyEst = record.costUsdEst === null ? null : Math.round(record.costUsdEst * rate * 1e6) / 1e6;
      lines.push([record.ts, record.day, record.tz, record.provider, record.model, record.kind, record.toolName,
        record.input, record.output, record.cacheRead, record.cacheWrite, record.reasoning, record.billed,
        record.costUsd, record.costUsdEst, costCny, costCnyEst, record.sessionId, record.cwd, record.project,
        record.source, record.entryId].map(csvEscape).join(","));
    });
    cursor = payload.nextCursor;
    if (!cursor) break;
  }
  download("pi-monitor-" + windowSlug() + "-" + fileStamp() + ".csv", "\ufeff" + lines.join("\r\n") + "\r\n", "text/csv;charset=utf-8");
}

/* --------------------------------------------------------------- settings */
function openDrawer(open) {
  document.getElementById("drawer").setAttribute("data-open", open ? "true" : "false");
  document.getElementById("scrim").setAttribute("data-open", open ? "true" : "false");
  if (open) fillSettings();
}
function fillSettings() {
  const config = state.config;
  document.getElementById("set-rate").value = String(config.currency.rate);
  document.getElementById("set-autorate").checked = !!config.currency.autoRate;
  document.getElementById("set-autorefresh").checked = state.autoRefresh;
  document.getElementById("set-rate-note").textContent = t("settings.rateNote", {
    source: rateSourceLabel(),
    time: state.rateFetchedAt ? fmtISO(new Date(state.rateFetchedAt)) : "\u2014",
  });
  document.getElementById("set-locale").value = state.locale;
  document.getElementById("set-theme").value = state.theme;
  document.getElementById("set-budget-enabled").checked = !!config.budget.enabled;
  document.getElementById("set-daily").value = config.budget.dailyCNY === null ? "" : String(config.budget.dailyCNY);
  document.getElementById("set-monthly").value = config.budget.monthlyCNY === null ? "" : String(config.budget.monthlyCNY);
  document.getElementById("set-estimated").checked = !!config.budget.includeEstimated;
  document.getElementById("set-lan").checked = !!config.dashboard.allowLan;
  document.getElementById("set-readonly-note").textContent = config.readOnly ? t("settings.readonly") : "";
}
async function saveSettings() {
  const daily = document.getElementById("set-daily").value;
  const monthly = document.getElementById("set-monthly").value;
  const patch = {
    currency: { rate: Number(document.getElementById("set-rate").value), autoRate: document.getElementById("set-autorate").checked },
    dashboard: { theme: document.getElementById("set-theme").value, allowLan: document.getElementById("set-lan").checked, autoRefresh: document.getElementById("set-autorefresh").checked },
    locale: document.getElementById("set-locale").value,
    budget: {
      enabled: document.getElementById("set-budget-enabled").checked,
      dailyCNY: daily === "" ? null : Number(daily),
      monthlyCNY: monthly === "" ? null : Number(monthly),
      includeEstimated: document.getElementById("set-estimated").checked,
    },
  };
  try {
    const result = await api("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!result.ok) throw new Error("rejected: " + (result.rejected || []).join(", "));
    showToast(t("settings.saved"));
    state.theme = patch.dashboard.theme;
    state.locale = patch.locale;
    state.autoRate = patch.currency.autoRate;
    state.autoRefresh = patch.dashboard.autoRefresh;
    applyTheme();
    scheduleAutoRefresh();
    await loadAll();
  } catch (error) {
    showToast(t("settings.writeFailed", { reason: String(error.message || error) }));
  }
}
/*
 * ¥8：汇率刷新（手动点「立即更新」= notify 为真）。
 * 返回 true 表示汇率发生变化、页面数据需要用新汇率重新聚合并重渲染。
 */
async function refreshRate(notify) {
  try {
    const result = await api("/api/rate/refresh", { method: "POST" });
    const before = state.rate;
    if (typeof result.rate === "number") state.rate = result.rate;
    if (result.rateSource) state.rateSource = result.rateSource;
    state.rateFetchedAt = result.fetchedAt || state.rateFetchedAt;
    if (typeof result.autoRate === "boolean") state.autoRate = result.autoRate;
    renderChrome();
    if (!result.ok) {
      state.rateFailedAt = Date.now();
      if (notify) showToast(t("rate.auto.failed", { reason: result.reason || "unknown" }));
      return false;
    }
    state.rateFailedAt = 0;
    if (notify) showToast(t("rate.auto.applied", { rate: state.rate.toFixed(2) }));
    return before !== state.rate;
  } catch (error) {
    state.rateFailedAt = Date.now();
    if (notify) showToast(t("rate.auto.failed", { reason: String(error.message || error) }));
    return false;
  }
}

/* AC-8.4 / ¥8：重新扫描并重载（「刷新」按钮与自动刷新共用）。 */
async function rescan(notify, message) {
  const button = document.getElementById("btn-rescan");
  const refreshButton = document.getElementById("btn-refresh");
  button.disabled = true;
  refreshButton.disabled = true;
  try {
    await api("/api/rescan", { method: "POST" });
    await loadAll();
    if (notify) showToast(message || (t("action.rescan") + " \u2713"));
  } catch (error) {
    showToast(String(error.message || error));
  } finally {
    button.disabled = false;
    refreshButton.disabled = false;
  }
}

async function rebuild() {
  const answer = window.prompt(t("action.rebuildConfirm"), "");
  if (answer !== "REBUILD") return;
  const button = document.getElementById("btn-rebuild");
  button.disabled = true;
  button.textContent = t("action.rebuildRunning");
  try {
    await api("/api/rebuild", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "REBUILD" }),
    });
    await loadAll();
    showToast(t("action.rebuild") + " \u2713");
  } catch (error) {
    showToast(String(error.message || error));
  } finally {
    button.disabled = false;
    renderChrome();
  }
}

/* ------------------------------------------------------------------ wire */
function wire() {
  document.getElementById("window").addEventListener("change", function (event) {
    state.window = event.target.value;
    state.from = null; state.to = null;
    loadAll();
  });
  document.getElementById("btn-apply-window").addEventListener("click", function () {
    const from = document.getElementById("window-from").value.trim();
    const to = document.getElementById("window-to").value.trim();
    if (from && to) { state.from = from; state.to = to; state.window = "custom"; loadAll(); }
  });
  document.getElementById("heat-years").addEventListener("click", function (event) {
    const button = event.target.closest("button[data-year]");
    if (!button) return;
    const raw = button.getAttribute("data-year");
    state.heatYear = raw === "" ? null : Number(raw);
    loadAll();
  });
  // AC-8.9：列宽依赖容器宽度，改变窗口尺寸后必须重算。
  window.addEventListener("resize", function () { renderTrend(); });
  document.getElementById("btn-refresh").addEventListener("click", function () { rescan(true, t("header.refreshed")); });
  document.getElementById("btn-lang").addEventListener("click", function () {
    state.locale = state.locale === "zh-CN" ? "en-US" : "zh-CN";
    // FR-13.4：语言切换即时生效（前端字典切换，无需刷新页面）。
    renderChrome(); renderWarnings(); renderScanState(); renderCards(); renderHeatmap();
    renderTrend(); renderBreakdown(); renderBudget(); renderHealth(); renderFooterMeta();
  });
  document.getElementById("btn-theme").addEventListener("click", function () {
    state.theme = state.theme === "dark" ? "light" : "dark";
    applyTheme();
  });
  document.getElementById("daily-toggle").addEventListener("click", function () {
    const body = document.getElementById("daily-body");
    body.hidden = !body.hidden;
    renderChrome();
  });
  document.getElementById("tabs").addEventListener("click", function (event) {
    const button = event.target.closest("button[data-dim]");
    if (!button) return;
    state.dim = button.getAttribute("data-dim");
    Array.prototype.forEach.call(document.querySelectorAll("#tabs button"), function (node) {
      node.setAttribute("aria-selected", node === button ? "true" : "false");
    });
    loadAll();
  });
  document.getElementById("btn-rescan").addEventListener("click", function () { rescan(true); });
  document.getElementById("btn-rate-refresh").addEventListener("click", async function () {
    const changed = await refreshRate(true);
    if (changed) await loadAll(); else renderChrome();
  });
  document.getElementById("btn-rebuild").addEventListener("click", rebuild);
  document.getElementById("btn-export-md").addEventListener("click", function () { exportMarkdown().catch(function (e) { showToast(String(e.message || e)); }); });
  document.getElementById("btn-export-json").addEventListener("click", function () { exportJson().catch(function (e) { showToast(String(e.message || e)); }); });
  document.getElementById("btn-export-csv").addEventListener("click", function () { exportCsv().catch(function (e) { showToast(String(e.message || e)); }); });
  document.getElementById("btn-settings").addEventListener("click", function () { openDrawer(true); });
  document.getElementById("btn-close-drawer").addEventListener("click", function () { openDrawer(false); });
  document.getElementById("scrim").addEventListener("click", function () { openDrawer(false); });
  document.getElementById("btn-save-settings").addEventListener("click", saveSettings);
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  }
  // AC-8.4：切回本页时不必等下一个周期（用户刚用完 token 回到仪表盘）。
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) refreshOnFocus();
  });
}

/* FR-8.5：加载后无未捕获 JS 异常（window.onerror 为空）。 */
window.addEventListener("error", function (event) {
  setError(event.message || "uncaught error");
});
applyTheme();
wire();
renderChrome();
scheduleAutoRefresh();
loadAll();
`;

/** 10.1：单页结构；资产内联（10.3）。 */
export function renderDashboardHtml(options: RenderOptions): string {
  const boot = {
    token: options.token,
    locale: options.locale,
    config: options.config,
    i18n: options.i18n,
  };
  return `<!doctype html>
<html lang="${options.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>pi-monitor</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <div class="brand">pi-monitor</div>
      <div class="rate" id="rate-line"></div>
    </div>
    <div class="controls">
      <label class="ctl"><span data-i18n="header.window">Window</span><select id="window">
        <option value="today">today</option>
        <option value="yesterday">yesterday</option>
        <option value="last7d" selected>last7d</option>
        <option value="last30d">last30d</option>
        <option value="week">week</option>
        <option value="month">month</option>
        <option value="all">all</option>
      </select></label>
      <label class="ctl"><input type="text" id="window-from" size="8"><input type="text" id="window-to" size="8">
        <button type="button" id="btn-apply-window">apply</button></label>
      <button type="button" id="btn-lang"></button>
      <button type="button" id="btn-theme" aria-label="theme">◐</button>
      <button type="button" id="btn-refresh"></button>
      <button type="button" id="btn-settings"></button>
    </div>
  </header>

  <div class="muted" id="rev" style="margin-top:8px;font-size:12px"></div>
  <div id="scan-state" hidden></div>
  <div id="warnings" class="warnbar" hidden></div>
  <div id="error" class="warnbar" hidden></div>

  <section class="panel">
    <h2 class="sec" id="sec-overview">overview</h2>
    <div class="cards" id="cards"></div>
  </section>

  <section class="panel">
    <h2 class="sec"><span id="sec-heatmap">heatmap</span>
      <span class="heat-years" id="heat-years" role="tablist"></span></h2>
    <div class="heat-wrap">
      <div class="heat-inner">
        <div class="heat-months" id="heat-months" aria-hidden="true"></div>
        <div class="heat-body">
          <div class="heat-days" id="heat-days" aria-hidden="true"></div>
          <div class="heat" id="heat" role="group"></div>
        </div>
      </div>
    </div>
    <div class="legend" id="heat-legend"></div>
  </section>

  <section class="panel">
    <h2 class="sec"><span id="sec-trend">trend</span>
      <span class="hint" id="trend-peak"></span>
      <button type="button" id="daily-toggle"></button></h2>
    <div class="trend-scroll" id="trend-scroll"><div class="trend" id="trend"></div></div>
    <div class="scroll" style="margin-top:10px"><table id="daily-table"><tbody id="daily-body" hidden></tbody></table></div>
  </section>

  <section class="panel">
    <h2 class="sec" id="sec-breakdown">breakdown</h2>
    <div class="tabs" id="tabs" role="tablist">
      <button type="button" data-dim="model" aria-selected="true">model</button>
      <button type="button" data-dim="provider" aria-selected="false">provider</button>
      <button type="button" data-dim="project" aria-selected="false">project</button>
      <button type="button" data-dim="session" aria-selected="false">session</button>
      <button type="button" data-dim="source" aria-selected="false">source</button>
      <button type="button" data-dim="kind" aria-selected="false">kind</button>
    </div>
    <div class="scroll"><table id="breakdown-table"></table></div>
  </section>

  <section class="panel" id="budget-panel" hidden>
    <h2 class="sec" id="sec-budget">budget</h2>
    <div id="budget-body"></div>
  </section>

  <section class="panel">
    <h2 class="sec" id="sec-actions">actions</h2>
    <div class="actions">
      <button type="button" id="btn-rescan"></button>
      <button type="button" id="btn-rebuild"></button>
      <button type="button" id="btn-export-md"></button>
      <button type="button" id="btn-export-json"></button>
      <button type="button" id="btn-export-csv"></button>
    </div>
  </section>

  <section class="panel">
    <h2 class="sec" id="sec-health">health</h2>
    <div id="health-body"></div>
  </section>

  <footer class="bottom">
    <span id="footer-meta"></span>
    <span id="footer-privacy"></span>
    <span id="footer-hint"></span>
  </footer>
</div>

<div class="scrim" id="scrim" data-open="false"></div>
<aside class="drawer" id="drawer" data-open="false" aria-label="settings">
  <h2 class="sec"><span id="drawer-title">settings</span> <button type="button" id="btn-close-drawer" style="margin-left:auto">×</button></h2>
  <div class="row"><label for="set-rate" id="lbl-rate"></label><input type="number" id="set-rate" step="0.01" min="0.01" max="100"></div>
  <div class="row"><label><input type="checkbox" id="set-autorate"> <span id="lbl-autorate"></span></label><button type="button" id="btn-rate-refresh"></button></div>
  <div class="row muted" id="set-rate-note" style="font-size:12px"></div>
  <div class="row"><label><input type="checkbox" id="set-autorefresh"> <span id="lbl-autorefresh"></span></label></div>
  <div class="row"><label for="set-locale" id="lbl-locale"></label><select id="set-locale"><option value="zh-CN">中文</option><option value="en-US">English</option></select></div>
  <div class="row"><label for="set-theme" id="lbl-theme"></label><select id="set-theme"><option value="auto">auto</option><option value="light">light</option><option value="dark">dark</option></select></div>
  <div class="row"><label><input type="checkbox" id="set-budget-enabled"> <span id="lbl-budget-enabled"></span></label></div>
  <div class="row"><label for="set-daily" id="lbl-daily"></label><input type="number" id="set-daily" step="0.01" min="0"></div>
  <div class="row"><label for="set-monthly" id="lbl-monthly"></label><input type="number" id="set-monthly" step="0.01" min="0"></div>
  <div class="row"><label><input type="checkbox" id="set-estimated"> <span id="lbl-estimated"></span></label></div>
  <div class="row"><label><input type="checkbox" id="set-lan"> <span id="lbl-lan"></span></label></div>
  <div class="row"><button type="button" class="primary" id="btn-save-settings"></button></div>
  <div class="row muted" id="set-readonly-note" style="font-size:12px"></div>
</aside>
<div class="toast" id="toast" hidden></div>

<script>window.__PI_MONITOR_BOOT__ = ${JSON.stringify(boot).replace(/</g, "\\u003c")};</script>
<script>${CHART_JS}${APP_JS}</script>
</body>
</html>
`;
}
