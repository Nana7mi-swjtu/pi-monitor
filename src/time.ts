/**
 * time.ts — 时区 / 日界 / 窗口计算（纯函数，无 IO）。
 * 需求：T-1~T-6（4.5）、8.2（窗口边界）、FR-5.1、AC-5.3、AC-5.5
 *
 * 关键不变量：
 *  - T-2：日键 = 该时区下的自然日 `YYYY-MM-DD`
 *  - T-5：聚合先按 `messageTimestamp` 定位日键，再做窗口过滤
 */

import type { WeekStart, WindowSpec } from "./types.ts";

export interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = 周日（与 Date#getUTCDay 一致）。 */
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tz: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(tz);
  if (cached) return cached;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  formatterCache.set(tz, dtf);
  return dtf;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** T-1：校验 IANA 时区名；非法时由 resolveTimezone 回退。 */
export function isValidTimezone(tz: string): boolean {
  if (tz === "local" || tz === "utc" || tz === "UTC") return true;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export interface ResolvedTimezone {
  /** 传给 Intl 的时区标识（local 已解析为系统 IANA 名）。 */
  tz: string;
  /** 配置语义：local / utc / IANA。 */
  kind: "local" | "utc" | "iana";
  warning?: string;
}

/** T-1：解析配置 `timezone` —— `local` | `utc` | IANA 名，默认 local。 */
export function resolveTimezone(spec: string | undefined): ResolvedTimezone {
  const raw = (spec ?? "local").trim();
  if (raw.length === 0 || raw === "local") {
    return { tz: localTimezone(), kind: "local" };
  }
  if (raw.toLowerCase() === "utc") {
    return { tz: "UTC", kind: "utc" };
  }
  if (isValidTimezone(raw)) {
    return { tz: raw, kind: "iana" };
  }
  return {
    tz: localTimezone(),
    kind: "local",
    warning: `timezone: 非法时区 "${raw}"，已回退系统本地时区 ${localTimezone()}`,
  };
}

let cachedLocal: string | null = null;

export function localTimezone(): string {
  if (cachedLocal === null) {
    try {
      cachedLocal = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      cachedLocal = "UTC";
    }
  }
  return cachedLocal;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** 该时区下的墙上时间分量。 */
export function partsInTz(ts: number, tz: string): TzParts {
  const parts = getFormatter(tz).formatToParts(new Date(ts));
  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let weekday = 0;
  for (const part of parts) {
    switch (part.type) {
      case "year":
        year = Number(part.value);
        break;
      case "month":
        month = Number(part.value);
        break;
      case "day":
        day = Number(part.value);
        break;
      case "hour":
        hour = Number(part.value) % 24;
        break;
      case "minute":
        minute = Number(part.value);
        break;
      case "second":
        second = Number(part.value);
        break;
      case "weekday":
        weekday = WEEKDAY_INDEX[part.value] ?? 0;
        break;
      default:
        break;
    }
  }
  return { year, month, day, hour, minute, second, weekday };
}

/** 该时区相对 UTC 的偏移毫秒（wallClock = ts + offset）。保持精确（不缓存，见 dayKey 的桶缓存）。 */
export function tzOffsetMs(ts: number, tz: string): number {
  const parts = partsInTz(ts, tz);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** 墙上时间 → UTC 毫秒（处理 DST：迭代一次收敛）。 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  tz: string,
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const offset1 = tzOffsetMs(guess, tz);
  const result1 = guess - offset1;
  const offset2 = tzOffsetMs(result1, tz);
  return offset2 === offset1 ? result1 : guess - offset2;
}

/** T-2：日键 `YYYY-MM-DD`。
 *
 * 性能：`Intl.DateTimeFormat.formatToParts` 是热路径上的主要开销（每次调用 ~10 µs）。
 * 这里按「UTC 小时桶」缓存结果：一个小时内如果时区偏移不变且整个小时落在同一本地自然日，
 * 则桶内所有时间戳的日键相同，可用 2 次 Intl 调用覆盖约 360 万个时间戳。
 * 跨本地日界或含 DST 切换的桶回退到精确计算（仍然逐条正确）。
 */
export function dayKey(ts: number, tz: string): string {
  const bucketStart = Math.floor(ts / 3_600_000) * 3_600_000;
  const info = hourBucket(bucketStart, tz);
  if (info.day !== null) return info.day;
  const p = partsInTz(ts, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

interface HourBucketInfo {
  /** 整个小时都落在同一本地自然日时为该日键，否则为 null（逐条精确计算）。 */
  day: string | null;
  offset: number;
}

const hourBucketCache = new Map<string, HourBucketInfo>();

function hourBucket(bucketStart: number, tz: string): HourBucketInfo {
  const key = `${tz}|${bucketStart}`;
  const hit = hourBucketCache.get(key);
  if (hit !== undefined) return hit;

  const offset = tzOffsetMs(bucketStart, tz);
  const offsetEnd = tzOffsetMs(bucketStart + 3_599_999, tz);
  let info: HourBucketInfo = { day: null, offset };
  if (offset === offsetEnd) {
    const localStart = bucketStart + offset;
    const localEnd = bucketStart + 3_599_999 + offset;
    if (Math.floor(localStart / 86_400_000) === Math.floor(localEnd / 86_400_000)) {
      info = { day: new Date(localStart).toISOString().slice(0, 10), offset };
    }
  }
  if (hourBucketCache.size > 50_000) hourBucketCache.clear();
  hourBucketCache.set(key, info);
  return info;
}

/** `YYYY-MM-DD` → 该时区当日起点（含）。 */
export function dayStartMs(day: string, tz: string): number {
  const [year, month, date] = parseDayKey(day);
  return zonedTimeToUtc(year, month, date, 0, 0, 0, 0, tz);
}

/** `YYYY-MM-DD` → 该时区当日终点（含，23:59:59.999）。 */
export function dayEndMs(day: string, tz: string): number {
  return dayStartMs(addCivilDays(day, 1), tz) - 1;
}

/** 自然日位移（只做民用日期运算，不受 DST 影响）。 */
export function addCivilDays(day: string, delta: number): string {
  const [year, month, date] = parseDayKey(day);
  const cursor = new Date(Date.UTC(year, month - 1, date));
  cursor.setUTCDate(cursor.getUTCDate() + delta);
  return `${cursor.getUTCFullYear()}-${pad2(cursor.getUTCMonth() + 1)}-${pad2(cursor.getUTCDate())}`;
}

/** 两个日键之间的自然日差（b - a）。 */
export function civilDayDiff(a: string, b: string): number {
  const [ay, am, ad] = parseDayKey(a);
  const [by, bm, bd] = parseDayKey(b);
  const ms = Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad);
  return Math.round(ms / 86_400_000);
}

/** 该日键的星期（0 = 周日）。 */
export function weekdayOf(day: string): number {
  const [year, month, date] = parseDayKey(day);
  return new Date(Date.UTC(year, month - 1, date)).getUTCDay();
}

/** T-3：本周起点日键。 */
export function weekStartDay(day: string, weekStart: WeekStart): string {
  const weekday = weekdayOf(day);
  if (weekStart === "sunday") return addCivilDays(day, -weekday);
  const delta = weekday === 0 ? -6 : 1 - weekday;
  return addCivilDays(day, delta);
}

/** T-4：本月起点日键。 */
export function monthStartDay(day: string): string {
  const [year, month] = parseDayKey(day);
  return `${year}-${pad2(month)}-01`;
}

/** 下月同日（用于月末边界）。 */
export function nextMonthStartDay(day: string): string {
  const [year, month] = parseDayKey(day);
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  return `${nextYear}-${pad2(nextMonth)}-01`;
}

/** 该日所属 ISO 周（周一为起始）的 key，用于 `groupBy: "week"`。 */
export function weekKey(day: string, weekStart: WeekStart): string {
  return weekStartDay(day, weekStart);
}

/** 该日所属月份的 key，用于 `groupBy: "month"`。 */
export function monthKey(day: string): string {
  return day.slice(0, 7);
}

function parseDayKey(day: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) {
    throw new Error(`非法日键：${day}（应为 YYYY-MM-DD）`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** FR-5.1 的窗口名枚举（不含自定义区间）。 */
export type NamedWindow = "today" | "yesterday" | "week" | "month" | "last7d" | "last30d" | "all";

export const NAMED_WINDOWS: readonly NamedWindow[] = [
  "today",
  "yesterday",
  "week",
  "month",
  "last7d",
  "last30d",
  "all",
];

export interface WindowInput {
  kind: WindowSpec["kind"];
  n?: number;
  fromDay?: string;
  toDay?: string;
}

/** 解析窗口参数：窗口名 | 最近 N 天（number / "7d"）| from..to。 */
export function parseWindowInput(input: unknown, fallback: WindowInput = { kind: "last7d" }): WindowInput {
  if (typeof input === "number" && Number.isFinite(input)) {
    const n = Math.max(1, Math.floor(input));
    return { kind: "lastN", n };
  }
  if (typeof input === "string") {
    const value = input.trim();
    if (value.length === 0) return fallback;
    if ((NAMED_WINDOWS as readonly string[]).includes(value)) {
      return { kind: value as NamedWindow };
    }
    const nMatch = /^(\d+)d?$/i.exec(value);
    if (nMatch) {
      const n = Math.max(1, Math.min(3650, Number(nMatch[1])));
      return { kind: "lastN", n };
    }
    const range = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(value);
    if (range) {
      return { kind: "custom", fromDay: range[1] as string, toDay: range[2] as string };
    }
  }
  return fallback;
}

export interface ResolveWindowOptions {
  tz: string;
  weekStart: WeekStart;
  now: number;
}

/**
 * 8.2：窗口边界计算。
 * 返回的 `fromMs`/`toMs` 为闭区间（含首含尾）。
 * `all` 的真实边界由 aggregate 依据账本数据回填。
 */
export function resolveWindow(input: WindowInput, options: ResolveWindowOptions): WindowSpec {
  const { tz, weekStart, now } = options;
  const today = dayKey(now, tz);

  let fromDay: string;
  let toDay: string;
  let swapped = false;

  switch (input.kind) {
    case "today":
      fromDay = today;
      toDay = today;
      break;
    case "yesterday": {
      const yesterday = addCivilDays(today, -1);
      fromDay = yesterday;
      toDay = yesterday;
      break;
    }
    case "week":
      fromDay = weekStartDay(today, weekStart);
      toDay = addCivilDays(fromDay, 6);
      break;
    case "month":
      fromDay = monthStartDay(today);
      toDay = addCivilDays(nextMonthStartDay(today), -1);
      break;
    case "last7d":
      fromDay = addCivilDays(today, -6);
      toDay = today;
      break;
    case "last30d":
      fromDay = addCivilDays(today, -29);
      toDay = today;
      break;
    case "lastN": {
      const n = Math.max(1, Math.floor(input.n ?? 1));
      fromDay = addCivilDays(today, -(n - 1));
      toDay = today;
      break;
    }
    case "custom": {
      fromDay = input.fromDay ?? today;
      toDay = input.toDay ?? today;
      if (civilDayDiff(fromDay, toDay) < 0) {
        // AC-5.5：反向窗口自动交换并置 swapped。
        const tmp = fromDay;
        fromDay = toDay;
        toDay = tmp;
        swapped = true;
      }
      break;
    }
    case "all":
    default:
      fromDay = "";
      toDay = "";
      break;
  }

  if (input.kind === "all") {
    return {
      kind: "all",
      fromMs: 0,
      toMs: Number.MAX_SAFE_INTEGER,
      fromDay: "",
      toDay: "",
      from: "",
      to: "",
      days: 0,
      tz,
      swapped: false,
    };
  }

  const fromMs = dayStartMs(fromDay, tz);
  const toMs = dayEndMs(toDay, tz);
  const spec: WindowSpec = {
    kind: input.kind,
    fromMs,
    toMs,
    fromDay,
    toDay,
    from: fromDay,
    to: toDay,
    days: civilDayDiff(fromDay, toDay) + 1,
    tz,
    swapped,
  };
  if (input.kind === "lastN") spec.n = input.n;
  return spec;
}

/** 8.3：紧邻等长前一窗口（用于环比）。 */
export function previousWindow(window: WindowSpec, weekStart: WeekStart): WindowSpec {
  if (window.kind === "all") return window;
  const prevTo = addCivilDays(window.fromDay, -1);
  const prevFrom = addCivilDays(prevTo, -(window.days - 1));
  void weekStart;
  return {
    ...window,
    fromDay: prevFrom,
    toDay: prevTo,
    from: prevFrom,
    to: prevTo,
    fromMs: dayStartMs(prevFrom, window.tz),
    toMs: dayEndMs(prevTo, window.tz),
  };
}

/** 8.4：热力图网格需要的最早/最晚日键（53 周 × 7 天）。 */
export function heatmapRange(day: string, weekStart: WeekStart, weeks = 53): { startDay: string; endDay: string } {
  const endDay = addCivilDays(weekStartDay(day, weekStart), 6);
  const startDay = addCivilDays(endDay, -(weeks * 7 - 1));
  return { startDay, endDay };
}
