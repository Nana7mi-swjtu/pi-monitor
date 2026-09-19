/**
 * dashboard-layout.test.ts — FR-8 / 8.4 / AC-8.2、AC-8.7~AC-8.10、10.1.4~10.1.5、ADR-0003。
 *
 * 本文件执行的是**浏览器实际执行的那份源码**（`CHART_JS`），不是测试专用副本（P-1）：
 * `renderDashboardHtml()` 把 `CHART_JS` 拼进页面，测试用 `new Function(CHART_JS)` 执行同一字符串。
 * 因此这里断言的是真实前端行为，而不是“测试里模仿出来的行为”。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { CHART_JS, renderDashboardHtml } from "../../src/dashboard/assets.ts";
import { dictionaries } from "../../src/i18n.ts";
import { heatmapGridRange, heatmapRange } from "../../src/time.ts";
import type { HeatmapGrid } from "../../src/types.ts";
import { projectRoot } from "../helpers.ts";

interface TrendLayout {
  step: number;
  gap: number;
  barWidth: number;
  width: number;
  labelEvery: number;
  wideLabel: boolean;
}

interface MonthCol {
  col: number;
  month: number;
  left: number;
}

interface HeatCell {
  day: string;
  pad: boolean;
  value: number;
  sessions: number;
  level: number;
}

interface ChartFns {
  trendLayout: (dayCount: number, availableWidth: number) => TrendLayout;
  trendLabels: (days: string[], layout: TrendLayout) => string[];
  addDays: (day: string, delta: number) => string;
  dayOffset: (a: string, b: string) => number;
  heatmapMonthCols: (grid: HeatmapGrid) => MonthCol[];
  heatmapCells: (grid: HeatmapGrid, daily: unknown[], edges: number[]) => HeatCell[];
  TREND_PLOT_HEIGHT: number;
  TREND_LABEL_MIN_PX: number;
  HEAT_CELL: number;
  HEAT_GAP: number;
}

/** 与 `renderDashboardHtml()` 完全相同的拼接方式（CHART_JS 在前）。 */
function loadChartFns(): ChartFns {
  const factory = new Function(
    `${CHART_JS}
     return {
       trendLayout: trendLayout,
       trendLabels: trendLabels,
       addDays: addDays,
       dayOffset: dayOffset,
       heatmapMonthCols: heatmapMonthCols,
       heatmapCells: heatmapCells,
       TREND_PLOT_HEIGHT: TREND_PLOT_HEIGHT,
       TREND_LABEL_MIN_PX: TREND_LABEL_MIN_PX,
       HEAT_CELL: HEAT_CELL,
       HEAT_GAP: HEAT_GAP,
     };`,
  );
  return factory() as ChartFns;
}

const chart = loadChartFns();
const assetsSource = fs.readFileSync(path.join(projectRoot, "src", "dashboard", "assets.ts"), "utf8");
const page = renderDashboardHtml({
  locale: "zh-CN",
  i18n: dictionaries as unknown as Record<string, Record<string, string>>,
  token: "a".repeat(32),
  config: {
    defaultWindow: "last7d",
    theme: "auto",
    locale: "zh-CN",
    tableLimit: 20,
    weekStart: "monday",
    timezone: "UTC",
    currency: { rate: 7.2 },
  },
} as never);

/* ------------------------------------------------------------------ 8.4 网格 */

test("8.4：recent 网格恒为 53 周，year 网格恰好覆盖该自然年且按周对齐", () => {
  const recent = heatmapRange("2026-09-19", "monday", 53);
  assert.equal(chart.dayOffset(recent.startDay, recent.endDay) + 1, 53 * 7);
  assert.equal(new Date(`${recent.startDay}T00:00:00Z`).getUTCDay(), 1, "首列必须是周一");
  assert.equal(new Date(`${recent.endDay}T00:00:00Z`).getUTCDay(), 0, "末列必须是周日");

  const year = heatmapGridRange("2026-01-01", "2026-12-31", "monday");
  assert.equal(year.weeks, 53);
  assert.equal(chart.dayOffset(year.startDay, year.endDay) + 1, year.weeks * 7);
  assert.ok(year.startDay < "2026-01-01" && year.endDay > "2026-12-31", "必须包含完整自然年");

  // 周日起始时首列必须是周日（weekStart 生效）。
  const sunday = heatmapGridRange("2024-01-01", "2024-12-31", "sunday");
  assert.equal(new Date(`${sunday.startDay}T00:00:00Z`).getUTCDay(), 0);
});

test("AC-8.7：月份标签列位于每列首个「在范围内日期」的月份变化处", () => {
  const grid: HeatmapGrid = {
    ...heatmapGridRange("2026-01-01", "2026-12-31", "monday"),
    weekStart: "monday",
    mode: "year",
    year: 2026,
    fromDay: "2026-01-01",
    toDay: "2026-12-31",
  };
  const cols = chart.heatmapMonthCols(grid);
  assert.equal(cols.length, 12, "一个自然年应恰好 12 个月份标签");
  assert.deepEqual(cols.map((item) => item.month), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.equal(cols[0]!.col, 0, "首个标签必须落在第 0 列（补齐格不应产生标签）");
  for (const item of cols) {
    assert.equal(item.left, item.col * (chart.HEAT_CELL + chart.HEAT_GAP), "月份标签 x 必须与列对齐");
  }
  // 列号严格递增（标签不重叠）。
  for (let i = 1; i < cols.length; i += 1) assert.ok(cols[i]!.col > cols[i - 1]!.col);

  // recent 模式：首列即数据首日，跨 13 个月份。
  const recentRange = heatmapRange("2026-09-19", "monday", 53);
  const recent: HeatmapGrid = {
    ...recentRange,
    weeks: 53,
    weekStart: "monday",
    mode: "recent",
    year: null,
    fromDay: recentRange.startDay,
    toDay: recentRange.endDay,
  };
  assert.equal(chart.heatmapMonthCols(recent).length, 13);
});

test("8.4：addDays / dayOffset 跨月、跨年与闰年都正确", () => {
  assert.equal(chart.addDays("2026-09-19", 1), "2026-09-20");
  assert.equal(chart.addDays("2026-09-30", 1), "2026-10-01");
  assert.equal(chart.addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(chart.addDays("2024-02-28", 1), "2024-02-29", "2024 是闰年");
  assert.equal(chart.addDays("2025-02-28", 1), "2025-03-01", "2025 不是闰年");
  assert.equal(chart.addDays("2026-01-01", -1), "2025-12-31");
  assert.equal(chart.dayOffset("2026-09-19", "2026-09-19"), 0);
  assert.equal(chart.dayOffset("2026-09-19", "2026-09-20"), 1);
  assert.equal(chart.dayOffset("2025-09-15", "2026-09-19"), 369);
  assert.equal(chart.dayOffset("2026-09-19", "2025-09-15"), -369);
});

/* ------------------------------------------------------- AC-8.9 趋势图宽度 */

test("AC-8.9：列宽由天数与可用宽度共同决定（图表总宽随日期数联动）", () => {
  const week = chart.trendLayout(7, 1100);
  assert.equal(week.step, 72, "7 天时列宽受上限约束");
  assert.equal(week.width, 72 * 7 + 6 * 3);

  const month = chart.trendLayout(30, 1100);
  // step = floor((1100 - 29×3) / 30) = 33
  assert.equal(month.step, 33);
  assert.equal(month.width, 33 * 30 + 29 * 3);
  assert.ok(month.width <= 1100, "刚好放得下时总宽（含间隙）不得超过容器");

  const year = chart.trendLayout(365, 1100);
  assert.equal(year.step, 18, "天数过多时停在下限");
  assert.ok(year.width > 1100, "超出容器 → 由外层横向滚动");

  // 同样天数下容器越宽列越宽，但不超过上限。
  assert.ok(chart.trendLayout(30, 600).step < chart.trendLayout(30, 1100).step);
  assert.equal(chart.trendLayout(30, 100000).step, 72);

  // 测量失败（0 / 负数 / NaN）时退化为可滚动宽度，不产生 0 宽柱子。
  for (const bad of [0, -5, Number.NaN]) {
    const layout = chart.trendLayout(7, bad);
    assert.equal(layout.step, 18);
    assert.ok(layout.barWidth > 0);
  }
  // 0 天或负数天按 1 天处理。
  assert.equal(chart.trendLayout(0, 1100).step, 72);
  assert.equal(chart.trendLayout(-3, 1100).step, 72);
});

test("AC-8.9：柱宽恒 > 0 且小于列宽（回归：曾因 flex 主轴错误导致柱宽 0）", () => {
  for (const days of [1, 2, 7, 14, 30, 31, 92, 365, 366]) {
    for (const width of [320, 480, 720, 1024, 1440, 2560]) {
      const layout = chart.trendLayout(days, width);
      assert.ok(layout.barWidth >= 2, `${days} 天 / ${width}px 柱宽 ${layout.barWidth}`);
      assert.ok(layout.barWidth < layout.step, "柱宽必须小于列宽（留出间隙）");
      assert.equal(layout.width, layout.step * days + (days - 1) * layout.gap, "总宽 = 列宽 × 天数 + 间隙");
      assert.ok(layout.step >= 18 && layout.step <= 72);
      // 未触及上下限时，图表必须正好放进容器（不多出横向滚动）。
      if (layout.step > 18 && layout.step < 72) {
        assert.ok(layout.width <= width, `${days} 天 / ${width}px → ${layout.width}px 溢出`);
      }
    }
  }
});

/* ------------------------------------------------------- AC-8.10 日期标签 */

test("AC-8.10：标签按 ceil(44/step) 抽稀，窄列只显示日，每月 1 日强制显示月-日", () => {
  const wide = chart.trendLayout(7, 1100);
  assert.equal(wide.labelEvery, 1);
  assert.equal(wide.wideLabel, true);
  const wideLabels = chart.trendLabels(["2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"], wide);
  assert.deepEqual(wideLabels, ["09-13", "09-14", "09-15", "09-16"], "宽列每列都显示 MM-DD");

  const narrow = chart.trendLayout(30, 1100);
  assert.equal(narrow.labelEvery, 2);
  assert.equal(narrow.wideLabel, false);
  const days = Array.from({ length: 31 }, (_, i) => chart.addDays("2026-08-20", i));
  const narrowLabels = chart.trendLabels(days, narrow);
  assert.equal(narrowLabels[0], "20", "窄列只显示日");
  assert.equal(narrowLabels[1], "", "抽稀位之外不显示");
  // 每月 1 日必须出现且用 MM-DD 形式。
  for (let i = 0; i < days.length; i += 1) {
    if (days[i]!.slice(8) === "01") assert.equal(narrowLabels[i], days[i]!.slice(5), `${days[i]} 必须带月份`);
  }
  assert.ok(narrowLabels.includes("09-01"));
  assert.ok(narrowLabels.includes("08-31") === false, "08-31 与 09-01 相邻，应只保留月起点");

  const dense = chart.trendLayout(365, 1100);
  assert.equal(dense.labelEvery, 3);
});

test("AC-8.10：任意布局下两个非空标签的像素间距 ≥ 44px（不重叠）", () => {
  for (const [days, width] of [[7, 1100], [7, 320], [30, 1100], [31, 900], [90, 700], [365, 1100], [365, 2560], [366, 1440]] as const) {
    const layout = chart.trendLayout(days, width);
    const list = Array.from({ length: days }, (_, i) => chart.addDays("2025-01-01", i));
    const labels = chart.trendLabels(list, layout);
    assert.equal(labels.length, days);
    let lastPixel: number | null = null;
    let count = 0;
    for (let i = 0; i < labels.length; i += 1) {
      const text = labels[i]!;
      if (text === "") continue;
      const pixel = i * layout.step;
      if (lastPixel !== null) {
        assert.ok(
          pixel - lastPixel >= chart.TREND_LABEL_MIN_PX,
          `${days}天/${width}px：index ${i} 与上一个标签仅相距 ${pixel - lastPixel}px`,
        );
      }
      lastPixel = pixel;
      count += 1;
      assert.equal(/^(\d{2}|\d{2}-\d{2})$/.test(text), true, `非法标签文本 ${text}`);
    }
    assert.ok(count > 0, "必须有标签");
    assert.ok(count <= days);
  }
});

test("AC-8.10：标签字号 ≥ 11px 且水平排列（不再使用 9px 竖排）", () => {
  assert.equal(/\.trend \.lab \{[^}]*font-size: 11px/.test(assetsSource), true);
  assert.equal(assetsSource.includes("writing-mode"), false, "日期标签不再竖排");
  // 列间隙由 JS 下发，CSS 不得再写死 gap（否则宽度计算与真实布局会不一致）。
  const trendRule = /\.trend \{([^}]*)\}/.exec(assetsSource)?.[1] as string;
  assert.equal(/\bgap\b/.test(trendRule), false, ".trend 的 gap 必须由 trendLayout 行内设置");
  const appJs = /const APP_JS = String\.raw`([\s\S]*?)`;/.exec(assetsSource)?.[1] as string;
  assert.match(appJs, /node\.style\.gap = layout\.gap/);
});

test("FR-4：页面不存在「本会话（实时）」卡片（内存实时计数器已删除）", () => {
  const appJs = /const APP_JS = String\.raw`([\s\S]*?)`;/.exec(assetsSource)?.[1] as string;
  assert.equal(appJs.includes("summary.live"), false, "前端不得再读 summary.live");
  assert.equal(appJs.includes("card.live"), false, "前端不得再渲染实时卡片");
  assert.equal(page.includes('id="card-live"'), false);
  // 字典里的键必须一并删除（否则是死键）。
  for (const key of ["card.live", "card.liveNote"]) {
    assert.equal(key in dictionaries["zh-CN"], false, `${key} 应为死键并已删除`);
    assert.equal(key in dictionaries["en-US"], false, `${key} 应为死键并已删除`);
  }
});

/* --------------------------------------------------- AC-8.2 指标固定 tokens */

test("AC-8.2：页面不存在指标切换控件，图表数值固定取 tokens.billed", () => {  assert.equal(page.includes('id="metric"'), false, "模板不得再包含指标下拉");
  assert.equal(page.includes("metric.tokens"), false);
  const appJs = /const APP_JS = String\.raw`([\s\S]*?)`;/.exec(assetsSource)?.[1] as string;
  assert.equal(appJs.includes("state.metric"), false, "前端不得再持有指标状态");
  assert.equal(appJs.includes("totals.tokens.billed"), true);
  // 指标开关的 i18n 键必须已删除（否则是死键）。
  for (const key of ["header.metric", "metric.tokens", "metric.cost", "metric.messages", "heatmap.monthly"]) {
    assert.equal(key in dictionaries["zh-CN"], false, `${key} 应为死键并已删除`);
    assert.equal(key in dictionaries["en-US"], false, `${key} 应为死键并已删除`);
  }
});

/* ------------------------------------------- AC-8.7 / AC-8.8 模板结构断言 */

test("AC-8.7 / AC-8.8：模板含月份行、星期列、年份选项卡与趋势滚动容器", () => {
  for (const id of ["heat-months", "heat-days", "heat-years", "heat", "trend-scroll", "trend-peak", "trend"]) {
    assert.ok(page.includes(`id="${id}"`), `模板缺少 id=${id}`);
  }
  // 月份行与网格必须同处一个滚动容器（10.3：列对齐不因滚动错位）。
  const wrap = page.slice(page.indexOf('class="heat-wrap"'), page.indexOf('id="heat-legend"'));
  assert.ok(wrap.includes('id="heat-months"') && wrap.includes('id="heat"'));
  assert.ok(wrap.includes('class="heat-inner"'), "月份行与网格需同为居中/滚动单元");
  // 年份选项卡的容器存在且由脚本填充。
  assert.ok(page.includes('id="heat-years"'));
  // 每行列标签只出现 3 个（行 0/2/4）。
  const appJs = /const APP_JS = String\.raw`([\s\S]*?)`;/.exec(assetsSource)?.[1] as string;
  assert.match(appJs, /r === 0 \|\| r === 2 \|\| r === 4/);
  // weekStart 决定标签顺序。
  assert.match(appJs, /weekStart === "sunday"/);
});

test("AC-8.8：年份请求使用 year 参数，回退到最近一年时复用 window=all", () => {
  const appJs = /const APP_JS = String\.raw`([\s\S]*?)`;/.exec(assetsSource)?.[1] as string;
  assert.ok(appJs.includes('"/api/daily?year=" + state.heatYear'), "必须按 year 取数");
  assert.ok(appJs.includes('window: "all"'), "最近一年复用 window=all");
  assert.ok(appJs.includes("listYears"), "年份选项卡由数据推导");
});

/* --------------------------------------------- AC-8.9 几何回归（根因防护） */

test("AC-8.9：.trend .bar 不得使用 flex 简写（ADR-0003 的根因）", () => {
  const rule = /\.trend \.bar \{([^}]*)\}/.exec(assetsSource)?.[1] as string;
  assert.ok(rule, "未找到 .trend .bar 规则");
  assert.equal(/\bflex\b/.test(rule), false, ".trend .bar 不得再出现 flex（会覆盖行内 height 并把宽度留成 0）");
  // 宽高必须由脚本行内设置，且来自 trendLayout。
  const appJs = /const APP_JS = String\.raw`([\s\S]*?)`;/.exec(assetsSource)?.[1] as string;
  assert.match(appJs, /"<div class=\\"bar\\" style=\\"width:" \+ layout\.barWidth \+ "px;height:"/);
  // 柱子所在列也必须显式给宽（否则列宽不由天数决定）。
  assert.match(appJs, /class=\\"col\\" style=\\"width:" \+ layout\.step \+ "px/);
});

test("10.1.4：热力图补齐格不算 0 值日，且不可聚焦", () => {
  const appJs = /const APP_JS = String\.raw`([\s\S]*?)`;/.exec(assetsSource)?.[1] as string;
  assert.match(appJs, /heatmapCells\(grid, heat\.daily, edges\)/, "单元格由 heatmapCells 计算（前端不自算周对齐）");
  assert.ok(appJs.includes('class=\\"cell pad\\"'), "补齐格必须渲染为无背景占位格");
});

/*
 * 回归（用户报告）：最近一年只显示 1 个格子。
 * 根因是服务端把 recent 模式的 fromDay/toDay 也设成了「统计末日」，导致 370/371 个格子
 * 被当成补齐格。这里用真实前端函数断言：recent 网格的统计范围必须覆盖整个网格。
 */
test("AC-8.8：最近一年网格的统计范围就是网格本身（否则只剩 1 个非补齐格）", () => {
  const span = heatmapRange("2026-09-19", "monday", 53);
  const recent: HeatmapGrid = {
    ...span,
    weeks: 53,
    weekStart: "monday",
    mode: "recent",
    year: null,
    fromDay: span.startDay,
    toDay: span.endDay,
  };
  const daily = [
    { day: "2026-09-13", totals: { tokens: { billed: 100 }, sessions: 1 } },
    { day: "2026-09-19", totals: { tokens: { billed: 300 }, sessions: 2 } },
  ];
  const cells = chart.heatmapCells(recent, daily, [50, 200, 400]);
  assert.equal(cells.length, 53 * 7);
  assert.equal(cells.filter((cell) => cell.pad).length, 0, "recent 模式不得有补齐格");
  const colored = cells.filter((cell) => !cell.pad && cell.value > 0);
  assert.equal(colored.length, 2, "有数据的两天必须着色");
  assert.equal(cells.find((cell) => cell.day === "2026-09-19")?.level, 3, "按分桶上色");
  assert.equal(cells.find((cell) => cell.day === "2026-09-20")?.level, 0, "网格内其余日期按 0 值日上色");

  // year 模式：网格首尾多余日仍为补齐格（AC-8.8 的「其余为无背景补齐格」）。
  const yearSpan = heatmapGridRange("2026-01-01", "2026-12-31", "monday");
  const year: HeatmapGrid = {
    ...yearSpan,
    weekStart: "monday",
    mode: "year",
    year: 2026,
    fromDay: "2026-01-01",
    toDay: "2026-12-31",
  };
  const yearCells = chart.heatmapCells(year, daily, [50, 200, 400]);
  assert.equal(yearCells.filter((cell) => cell.pad).length, yearSpan.weeks * 7 - 365);
  assert.equal(yearCells.filter((cell) => cell.value > 0).length, 2);
});

test("FR-8 / AC-8.4：刷新按钮必须重新扫描（不能只重读内存），且页面会自动刷新", () => {
  const appJs = /const APP_JS = String\.raw`([\s\S]*?)`;/.exec(assetsSource)?.[1] as string;
  // 「刷新」不再直接 loadAll（那只会重读服务端内存里的旧数据）。
  assert.ok(
    /getElementById\("btn-refresh"\)\.addEventListener\("click", function \(\) \{ rescan\(/.test(appJs),
    "刷新按钮必须走 rescan（重新扫描 + 重载）",
  );
  assert.equal(
    /getElementById\("btn-refresh"\)\.addEventListener\("click", loadAll\)/.test(appJs),
    false,
    "刷新按钮不得只重读内存数据",
  );
  // 页面存活时按周期自动重扫；切回标签页时立即补一次；隐藏时跳过。
  assert.match(appJs, /AUTO_REFRESH_MS = 30000/);
  assert.match(appJs, /setInterval\(function \(\) \{[\s\S]{0,200}if \(document\.hidden\) return;[\s\S]{0,80}autoRefresh\(\)/);
  assert.match(appJs, /visibilitychange/);
  assert.match(appJs, /api\("\/api\/rescan", \{ method: "POST" \}\)/);
  // 首屏必须确认汇率（自动汇率过期时联网一次），但不得递归重载。
  assert.match(appJs, /state\.ratePending/);
  assert.match(appJs, /api\("\/api\/rate\/refresh", \{ method: "POST" \}\)/);
  // 取汇率失败后必须有静默期，否则网络不通时会每 30 s 重试一次。
  assert.match(appJs, /RATE_RETRY_BACKOFF_MS/);
  assert.match(appJs, /rateBackoffActive\(\)/);
});

test("¥8 / FR-13：汇率行标注来源，设置抽屉提供自动汇率与自动刷新开关", () => {
  const appJs = /const APP_JS = String\.raw`([\s\S]*?)`;/.exec(assetsSource)?.[1] as string;
  assert.match(appJs, /t\("rate\.line", \{ rate: state\.rate\.toFixed\(2\), source: rateSourceLabel\(\) \}\)/);
  for (const id of ["set-autorate", "set-autorefresh", "btn-rate-refresh", "set-rate-note"]) {
    assert.ok(page.includes(`id="${id}"`), `设置抽屉缺少 ${id}`);
  }
  for (const key of ["settings.autoRate", "settings.autoRefresh", "settings.rateRefresh", "settings.rateNote", "rate.source.auto", "rate.source.manual"]) {
    for (const locale of ["zh-CN", "en-US"] as const) {
      assert.equal(typeof dictionaries[locale][key], "string", `${locale} 缺少 ${key}`);
    }
  }
});

/* -------------------------------------------------- 脚本拼接与语法（NFR-11） */

test("FR-8：CHART_JS 拼在 APP_JS 之前，合并后同一 <script> 内语法正确", () => {
  const chartIndex = page.indexOf(CHART_JS);
  const appIndex = page.indexOf("const BOOT = window.__PI_MONITOR_BOOT__;");
  assert.ok(chartIndex > 0, "页面必须内联 CHART_JS");
  assert.ok(appIndex > chartIndex, "CHART_JS 必须先于 APP_JS（保证 use strict 与 var 初始化顺序）");
  const script = page.slice(page.lastIndexOf("<script>", appIndex) + 8, page.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script), "合并后的页面脚本存在语法错误");
});

test("FR-13：新增文案键在两种语言中都存在（无裸 key）", () => {
  for (const key of ["heatmap.year.recent", "daily.peak"]) {
    for (const locale of ["zh-CN", "en-US"] as const) {
      const value = dictionaries[locale][key];
      assert.equal(typeof value, "string", `${locale} 缺少 ${key}`);
      assert.notEqual(value, key);
    }
  }
  // 星期与月份复用既有键（0=周日…6=周六、1..12 月）。
  assert.equal(dictionaries["en-US"]["weekday.3"], "Wed");
  assert.equal(dictionaries["zh-CN"]["month.12"], "12 月");
});
