/**
 * i18n.ts — zh-CN / en-US 字典（纯函数，无 IO）。
 * 需求：FR-13（含 AC-13.1~AC-13.3）、9.2 仪表盘文案规范
 *
 * 规则：
 *  - FR-13.1 语言解析：配置 `locale` → `PI_MONITOR_LOCALE` → `LANG/LC_ALL` → 默认 `en-US`。
 *  - FR-13.4 仪表盘语言切换即时生效（前端字典切换，无需刷新页面）。
 *  - FR-13.5 缺键回退英文；不得把裸 key 展示给用户（AC-13.3）。
 *  - 9.2 标题恒为 `pi-monitor`，不随语言变化。
 */

import type { Locale, LocaleSetting, WindowSpec } from "./types.ts";

export type Dict = Record<string, string>;

export const SUPPORTED_LOCALES: readonly Locale[] = ["zh-CN", "en-US"];

const EN: Dict = {
  "app.title": "pi-monitor",

  "header.window": "Window",
  "header.language": "Language",
  "header.theme": "Theme",
  "header.refresh": "Refresh",
  "header.refreshed": "Refreshed",
  "header.revision": "revision",
  "header.updated": "updated",
  "header.scanning": "Indexing",
  "header.scanningProgress": "Indexing {progress}%",
  "header.ready": "Index ready",

  "window.today": "Today",
  "window.yesterday": "Yesterday",
  "window.week": "This week",
  "window.month": "This month",
  "window.last7d": "Last 7 days",
  "window.last30d": "Last 30 days",
  "window.all": "All time",
  "window.custom": "Custom",
  "window.lastN": "Last {n} days",
  "window.range": "{from} → {to}",
  "window.from": "From",
  "window.to": "To",
  "window.apply": "Apply",

  "theme.auto": "Auto",
  "theme.light": "Light",
  "theme.dark": "Dark",

  "locale.zh-CN": "中文",
  "locale.en-US": "English",

  "rate.line": "Rate 1 USD = {rate} CNY ({source})",
  "rate.short": "1 USD = {rate} CNY",
  "rate.source.manual": "manual",
  "rate.source.auto": "auto-fetched",
  "rate.auto.applied": "Rate updated: 1 USD = {rate} CNY",
  "rate.auto.failed": "Automatic rate update failed: {reason}",

  "warn.title": "Warnings",
  "warn.dedupeOff": "⚠ Deduplication is disabled",
  "warn.allowLan": "⚠ The dashboard is reachable from the local network (allowLan)",
  "warn.schemaHigher": "⚠ Index schema is newer than this build — running read-only",
  "warn.tzChanged": "⚠ Timezone changed — rebuild the index recommended",
  "warn.corrupt": "⚠ {count} damaged record(s) detected",
  "warn.details": "Details",
  "warn.lockTimeout": "⚠ Another process is writing the index — read-only for now",

  "card.billed": "Billed tokens",
  "card.input": "Input",
  "card.output": "Output",
  "card.cacheRead": "Cache read",
  "card.cacheWrite": "Cache write",
  "card.costKnown": "Actual cost",
  "card.costEstimated": "Estimated cost",
  "card.messages": "Messages",
  "card.activeDays": "Active days",
  "card.sessions": "Sessions",
  "card.vsPrev": "vs previous",
  "card.noPrev": "—",

  "heatmap.title": "Daily heatmap",
  "heatmap.legend": "Legend",
  "heatmap.cell": "{day} · {value} · {sessions} session(s)",
  "heatmap.less": "Less",
  "heatmap.more": "More",
  "heatmap.year.recent": "Last 12 months",

  "daily.title": "Daily trend",
  "daily.expand": "Show daily table",
  "daily.collapse": "Hide daily table",
  "daily.peak": "Peak {value}",
  "daily.date": "Date",

  "breakdown.title": "Breakdown",
  "breakdown.dim": "Dimension",
  "dim.day": "Day",
  "dim.week": "Week",
  "dim.month": "Month",
  "dim.provider": "Provider",
  "dim.model": "Model",
  "dim.project": "Project",
  "dim.session": "Session",
  "dim.source": "Source",
  "dim.kind": "Kind",

  "col.name": "Name",
  "col.billed": "Billed tokens",
  "col.input": "Input",
  "col.output": "Output",
  "col.cacheRead": "Cache read",
  "col.cost": "Cost",
  "col.share": "Share",
  "col.messages": "Messages",

  "budget.title": "Budget",
  "budget.daily": "Daily budget",
  "budget.monthly": "Monthly budget",
  "budget.over": "over by {amount}",
  "budget.progress": "{spent} / {limit}",

  "action.rescan": "Rescan",
  "action.rebuild": "Rebuild index",
  "action.rebuildConfirm": "Type REBUILD to confirm",
  "action.rebuildRunning": "Rebuilding…",
  "action.exportMd": "Export Markdown",
  "action.exportJson": "Export JSON",
  "action.exportCsv": "Export CSV",
  "action.settings": "Settings",
  "action.close": "Close",

  "settings.title": "Settings",
  "settings.rate": "USD → CNY rate",
  "settings.autoRate": "Fetch the rate online (USD → CNY)",
  "settings.rateRefresh": "Update now",
  "settings.rateNote": "Source: {source} · updated {time}",
  "settings.autoRefresh": "Auto refresh this page (30s)",
  "settings.locale": "Language",
  "settings.theme": "Theme",
  "settings.budget": "Budget",
  "settings.budgetEnabled": "Enable budget alerts",
  "settings.dailyCNY": "Daily budget (CNY)",
  "settings.monthlyCNY": "Monthly budget (CNY)",
  "settings.includeEstimated": "Include estimated cost",
  "settings.allowLan": "Allow LAN access (restart required)",
  "settings.save": "Save",
  "settings.saved": "Saved",
  "settings.writeFailed": "Save failed: {reason}",
  "settings.readonly": "Read-only keys are not editable from the dashboard.",

  "health.title": "Health",
  "health.files": "Session files",
  "health.records": "Records",
  "health.dedupeSkipped": "Dedupe skipped",
  "health.corruptLines": "Corrupt lines",
  "health.invalidSessions": "Invalid sessions",
  "health.inconsistency": "Total-token mismatches",
  "health.corruptDuplicateIds": "Duplicate entry ids",
  "health.corruptCost": "Damaged costs",
  "health.corruptUsage": "Damaged usage",
  "health.skippedFiles": "Skipped files",
  "health.ledgerRepaired": "Ledger repairs",
  "health.configWarnings": "Config warnings",
  "health.unknownKeys": "Unknown config keys",
  "health.tz": "Timezone",
  "health.tzChanged": "Timezone changed",
  "health.rateSource": "Rate source",
  "health.lastScanMs": "Last scan",
  "health.indexSize": "Index size",
  "health.dataDir": "Data directory",
  "health.startedAt": "Started at",
  "health.pid": "pid",
  "health.enableDebug": "Enable debug logging",

  "dedupe.title": "Deduplicated records",
  "dedupe.fp": "Fingerprint",
  "dedupe.kept": "Kept in",
  "dedupe.skipped": "Skipped in",

  "footer.privacy": "All data stays on this machine",
  "footer.hint": "Run /tokens in pi to open this page again",

  "empty.range": "No records in this range",
  "state.loading": "Loading…",
  "state.error": "❌ {reason}",
  "state.suggestion": "Suggestion: {action}",
  "state.retry": "Retry",

  "unknown": "(unknown)",

  "md.title": "pi-monitor report · {window} ({from} → {to}, {tz})",
  "md.rate": "Rate: 1 USD = {rate} CNY ({source})",
  "md.generated": "Generated",
  "md.overview": "Overview",
  "md.daily": "Daily detail",
  "md.breakdown": "Breakdown",
  "md.source": "Data source",
  "md.metric": "Metric",
  "md.date": "Date",
  "md.actualCostCNY": "Actual cost (CNY)",
  "md.estCostCNY": "Estimated cost (CNY)",
  "md.actualCostUSD": "Actual cost (USD)",
  "md.messages": "Messages",
  "md.activeDays": "Active days",
  "md.sessions": "Sessions",
  "md.billed": "Billed tokens",
  "md.inOut": "↳ input / output / cache read / cache write",
  "md.share": "Share",
  "md.byDimension": "By {dimension}",
  "md.sourceLine": "{files} session file(s) · {records} record(s) · {skipped} dedupe-skipped · index {updated}",

  "tool.summary": "{window}: {billed} billed tokens, actual cost {cost}, estimated {estimated}.",
  "tool.top": "Top {dimension}: {items}",
  "tool.noRecords": "No records in {window}.",

  "month.1": "Jan",
  "month.2": "Feb",
  "month.3": "Mar",
  "month.4": "Apr",
  "month.5": "May",
  "month.6": "Jun",
  "month.7": "Jul",
  "month.8": "Aug",
  "month.9": "Sep",
  "month.10": "Oct",
  "month.11": "Nov",
  "month.12": "Dec",

  "weekday.0": "Sun",
  "weekday.1": "Mon",
  "weekday.2": "Tue",
  "weekday.3": "Wed",
  "weekday.4": "Thu",
  "weekday.5": "Fri",
  "weekday.6": "Sat",
};

const ZH: Dict = {
  "app.title": "pi-monitor",

  "header.window": "窗口",
  "header.language": "语言",
  "header.theme": "主题",
  "header.refresh": "刷新",
  "header.refreshed": "已刷新",
  "header.revision": "版本",
  "header.updated": "更新于",
  "header.scanning": "正在建立索引",
  "header.scanningProgress": "正在建立索引 {progress}%",
  "header.ready": "索引就绪",

  "window.today": "今天",
  "window.yesterday": "昨天",
  "window.week": "本周",
  "window.month": "本月",
  "window.last7d": "近 7 天",
  "window.last30d": "近 30 天",
  "window.all": "全部",
  "window.custom": "自定义",
  "window.lastN": "近 {n} 天",
  "window.range": "{from} → {to}",
  "window.from": "起",
  "window.to": "止",
  "window.apply": "应用",

  "theme.auto": "跟随系统",
  "theme.light": "浅色",
  "theme.dark": "深色",

  "locale.zh-CN": "中文",
  "locale.en-US": "English",

  "rate.line": "汇率 1 USD = {rate} CNY（{source}）",
  "rate.short": "1 USD = {rate} CNY",
  "rate.source.manual": "手动设置",
  "rate.source.auto": "自动获取",
  "rate.auto.applied": "汇率已更新：1 USD = {rate} CNY",
  "rate.auto.failed": "自动获取汇率失败：{reason}",

  "warn.title": "警告",
  "warn.dedupeOff": "⚠ 去重已关闭",
  "warn.allowLan": "⚠ 仪表盘已开放局域网访问（dashboard.allowLan）",
  "warn.schemaHigher": "⚠ 索引版本高于当前版本，正在只读运行",
  "warn.tzChanged": "⚠ 时区已变更，建议重建索引",
  "warn.corrupt": "⚠ 检测到 {count} 条损坏记录",
  "warn.details": "详情",
  "warn.lockTimeout": "⚠ 另一进程正在写入索引，当前为只读模式",

  "card.billed": "计费 Token",
  "card.input": "输入",
  "card.output": "输出",
  "card.cacheRead": "缓存读",
  "card.cacheWrite": "缓存写",
  "card.costKnown": "真实成本",
  "card.costEstimated": "估算成本",
  "card.messages": "消息数",
  "card.activeDays": "活跃天数",
  "card.sessions": "会话数",
  "card.vsPrev": "环比",
  "card.noPrev": "—",

  "heatmap.title": "每日热力图",
  "heatmap.legend": "图例",
  "heatmap.cell": "{day} · {value} · {sessions} 个会话",
  "heatmap.less": "少",
  "heatmap.more": "多",
  "heatmap.year.recent": "最近一年",

  "daily.title": "每日趋势",
  "daily.expand": "展开每日表格",
  "daily.collapse": "收起每日表格",
  "daily.peak": "峰值 {value}",
  "daily.date": "日期",

  "breakdown.title": "分解",
  "breakdown.dim": "维度",
  "dim.day": "日",
  "dim.week": "周",
  "dim.month": "月",
  "dim.provider": "Provider",
  "dim.model": "模型",
  "dim.project": "项目",
  "dim.session": "会话",
  "dim.source": "来源",
  "dim.kind": "类型",

  "col.name": "名称",
  "col.billed": "计费 Token",
  "col.input": "输入",
  "col.output": "输出",
  "col.cacheRead": "缓存读",
  "col.cost": "成本",
  "col.share": "占比",
  "col.messages": "消息数",

  "budget.title": "预算",
  "budget.daily": "日预算",
  "budget.monthly": "月预算",
  "budget.over": "超支 {amount}",
  "budget.progress": "{spent} / {limit}",

  "action.rescan": "重新扫描",
  "action.rebuild": "重建索引",
  "action.rebuildConfirm": "输入 REBUILD 以确认重建",
  "action.rebuildRunning": "正在重建…",
  "action.exportMd": "导出 Markdown",
  "action.exportJson": "导出 JSON",
  "action.exportCsv": "导出 CSV",
  "action.settings": "设置",
  "action.close": "关闭",

  "settings.title": "设置",
  "settings.rate": "汇率（1 USD → CNY）",
  "settings.autoRate": "联网自动获取汇率（USD → CNY）",
  "settings.rateRefresh": "立即更新",
  "settings.rateNote": "来源：{source} · 更新于 {time}",
  "settings.autoRefresh": "页面自动刷新（30 秒）",
  "settings.locale": "语言",
  "settings.theme": "主题",
  "settings.budget": "预算",
  "settings.budgetEnabled": "启用预算提醒",
  "settings.dailyCNY": "日预算（元）",
  "settings.monthlyCNY": "月预算（元）",
  "settings.includeEstimated": "计入估算成本",
  "settings.allowLan": "允许局域网访问（需重启）",
  "settings.save": "保存",
  "settings.saved": "已保存",
  "settings.writeFailed": "保存失败：{reason}",
  "settings.readonly": "只读键不可在仪表盘中修改。",

  "health.title": "健康",
  "health.files": "会话文件",
  "health.records": "记录数",
  "health.dedupeSkipped": "去重跳过",
  "health.corruptLines": "损坏行",
  "health.invalidSessions": "无效会话",
  "health.inconsistency": "一致性不符",
  "health.corruptDuplicateIds": "重复 entry id",
  "health.corruptCost": "损坏成本",
  "health.corruptUsage": "损坏 usage",
  "health.skippedFiles": "跳过文件",
  "health.ledgerRepaired": "账本修复",
  "health.configWarnings": "配置警告",
  "health.unknownKeys": "未知配置键",
  "health.tz": "时区",
  "health.tzChanged": "时区变更",
  "health.rateSource": "汇率来源",
  "health.lastScanMs": "上次扫描",
  "health.indexSize": "索引大小",
  "health.dataDir": "数据目录",
  "health.startedAt": "启动于",
  "health.pid": "pid",
  "health.enableDebug": "启用调试日志",

  "dedupe.title": "去重跳过明细",
  "dedupe.fp": "指纹",
  "dedupe.kept": "保留于",
  "dedupe.skipped": "跳过自",

  "footer.privacy": "全部数据位于本机",
  "footer.hint": "在 pi 中输入 /tokens 可再次打开本页面",

  "empty.range": "该区间暂无记录",
  "state.loading": "加载中…",
  "state.error": "❌ {reason}",
  "state.suggestion": "建议：{action}",
  "state.retry": "重试",

  "unknown": "(unknown)",

  "md.title": "pi-monitor 报表 · {window}（{from} → {to}，{tz}）",
  "md.rate": "汇率：1 USD = {rate} CNY（{source}）",
  "md.generated": "生成时间",
  "md.overview": "概览",
  "md.daily": "每日明细",
  "md.breakdown": "分解表",
  "md.source": "数据源",
  "md.metric": "指标",
  "md.date": "日期",
  "md.actualCostCNY": "真实成本 (CNY)",
  "md.estCostCNY": "估算成本 (CNY)",
  "md.actualCostUSD": "真实成本 (USD)",
  "md.messages": "消息数",
  "md.activeDays": "活跃天数",
  "md.sessions": "会话数",
  "md.billed": "计费 Token",
  "md.inOut": "↳ 输入 / 输出 / 缓存读 / 缓存写",
  "md.share": "占比",
  "md.byDimension": "按{dimension}",
  "md.sourceLine": "{files} 个会话文件 · {records} 条记录 · 去重跳过 {skipped} 条 · 索引 {updated} 更新",

  "tool.summary": "{window}：{billed} 计费 Token，真实成本 {cost}，估算成本 {estimated}。",
  "tool.top": "{dimension} Top：{items}",
  "tool.noRecords": "{window} 暂无记录。",

  "month.1": "1 月",
  "month.2": "2 月",
  "month.3": "3 月",
  "month.4": "4 月",
  "month.5": "5 月",
  "month.6": "6 月",
  "month.7": "7 月",
  "month.8": "8 月",
  "month.9": "9 月",
  "month.10": "10 月",
  "month.11": "11 月",
  "month.12": "12 月",

  "weekday.0": "周日",
  "weekday.1": "周一",
  "weekday.2": "周二",
  "weekday.3": "周三",
  "weekday.4": "周四",
  "weekday.5": "周五",
  "weekday.6": "周六",
};

export const dictionaries: Record<Locale, Dict> = { "en-US": EN, "zh-CN": ZH };

/** FR-13.5：缺键回退英文；仍缺失时做最小可读化（绝不返回裸 key）。 */
export function translate(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const primary = dictionaries[locale]?.[key];
  const fallback = EN[key];
  const template = primary ?? fallback ?? humanizeKey(key);
  return interpolate(template, params);
}

function humanizeKey(key: string): string {
  const leaf = key.includes(".") ? (key.split(".").pop() as string) : key;
  const spaced = leaf.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** FR-13.1：语言解析 —— 配置 → `PI_MONITOR_LOCALE` → `LANG/LC_ALL` → 默认 `en-US`。 */
export function resolveLocale(
  configured: LocaleSetting,
  env: NodeJS.ProcessEnv = process.env,
): { locale: Locale; source: "config" | "env" | "system" | "default" } {
  if (configured === "zh-CN" || configured === "en-US") {
    return { locale: configured, source: "config" };
  }
  const fromEnv = env["PI_MONITOR_LOCALE"];
  const normalizedEnv = normalizeLocale(fromEnv);
  if (normalizedEnv !== null) return { locale: normalizedEnv, source: "env" };

  const fromSystem = normalizeLocale(env["LC_ALL"]) ?? normalizeLocale(env["LANG"]);
  if (fromSystem !== null) return { locale: fromSystem, source: "system" };

  return { locale: "en-US", source: "default" };
}

function normalizeLocale(value: string | undefined): Locale | null {
  if (value === undefined || value.length === 0) return null;
  const lower = value.toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en-US";
  return null;
}

/** FR-5.1 / 9.2：窗口的可读标签。 */
export function windowLabel(locale: Locale, window: WindowSpec): string {
  switch (window.kind) {
    case "today":
    case "yesterday":
    case "week":
    case "month":
    case "last7d":
    case "last30d":
    case "all":
      return translate(locale, `window.${window.kind}`);
    case "lastN":
      return translate(locale, "window.lastN", { n: window.n ?? window.days });
    case "custom":
    default:
      return translate(locale, "window.range", { from: window.fromDay, to: window.toDay });
  }
}

/** 9.1：日期恒为 ISO，不本地化。 */
export function isoDay(day: string): string {
  return day;
}
