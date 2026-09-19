/**
 * time.test.ts — 4.5（T-1~T-6）、8.2（窗口边界）、AC-5.3、AC-5.5。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  addCivilDays,
  civilDayDiff,
  dayKey,
  dayEndMs,
  dayStartMs,
  isValidTimezone,
  monthStartDay,
  nextMonthStartDay,
  parseWindowInput,
  previousWindow,
  resolveTimezone,
  resolveWindow,
  weekStartDay,
  weekdayOf,
} from "../../src/time.ts";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");

test("AC-5.3：日界在 UTC 与 Asia/Shanghai 下的两套断言", () => {
  // 2026-09-18T15:59:59.999Z = Asia/Shanghai 2026-09-18 23:59:59.999
  assert.equal(dayKey(1789747199999, "Asia/Shanghai"), "2026-09-18");
  // 2026-09-18T16:00:00.000Z = Asia/Shanghai 2026-09-19 00:00:00.000
  assert.equal(dayKey(1789747200000, "Asia/Shanghai"), "2026-09-19");
  // UTC 下两者都仍是 2026-09-18
  assert.equal(dayKey(1789747199999, "UTC"), "2026-09-18");
  assert.equal(dayKey(1789747200000, "UTC"), "2026-09-18");
});

test("T-2：dayStartMs/dayEndMs 与 dayKey 互为逆运算", () => {
  for (const tz of ["UTC", "Asia/Shanghai", "America/New_York"]) {
    const day = "2026-09-19";
    const start = dayStartMs(day, tz);
    const end = dayEndMs(day, tz);
    assert.equal(dayKey(start, tz), day, `${tz} 起点`);
    assert.equal(dayKey(end, tz), day, `${tz} 终点`);
    assert.equal(end - start, 86_400_000 - 1, `${tz} 当日跨度`);
  }
});

test("T-1：时区解析合法值 / 非法值回退 + 告警", () => {
  assert.equal(resolveTimezone("local").kind, "local");
  assert.equal(resolveTimezone("utc").tz, "UTC");
  assert.equal(resolveTimezone("utc").kind, "utc");
  assert.equal(resolveTimezone("Asia/Shanghai").tz, "Asia/Shanghai");
  const bogus = resolveTimezone("Mars/Olympus");
  assert.equal(bogus.kind, "local");
  assert.ok(bogus.warning && bogus.warning.includes("Mars/Olympus"));
  assert.equal(isValidTimezone("Asia/Shanghai"), true);
  assert.equal(isValidTimezone("Mars/Olympus"), false);
});

test("8.2：today / yesterday / week / month / last7d / last30d 边界（UTC）", () => {
  const base = { tz: "UTC", weekStart: "monday" as const, now: NOW };

  const today = resolveWindow({ kind: "today" }, base);
  assert.equal(today.fromDay, "2026-09-19");
  assert.equal(today.toDay, "2026-09-19");
  assert.equal(today.days, 1);
  assert.equal(today.fromMs, Date.UTC(2026, 8, 19));
  assert.equal(today.toMs, Date.UTC(2026, 8, 20) - 1);

  const yesterday = resolveWindow({ kind: "yesterday" }, base);
  assert.equal(yesterday.fromDay, "2026-09-18");
  assert.equal(yesterday.days, 1);

  // 2026-09-19 是周六 → 本周（周一起）为 2026-09-14 .. 2026-09-20
  const week = resolveWindow({ kind: "week" }, base);
  assert.equal(week.fromDay, "2026-09-14");
  assert.equal(week.toDay, "2026-09-20");
  assert.equal(week.days, 7);

  const month = resolveWindow({ kind: "month" }, base);
  assert.equal(month.fromDay, "2026-09-01");
  assert.equal(month.toDay, "2026-09-30");
  assert.equal(month.days, 30);

  const last7d = resolveWindow({ kind: "last7d" }, base);
  assert.equal(last7d.fromDay, "2026-09-13");
  assert.equal(last7d.toDay, "2026-09-19");
  assert.equal(last7d.days, 7);

  const last30d = resolveWindow({ kind: "last30d" }, base);
  assert.equal(last30d.fromDay, "2026-08-21");
  assert.equal(last30d.toDay, "2026-09-19");
  assert.equal(last30d.days, 30);

  const lastN = resolveWindow({ kind: "lastN", n: 3 }, base);
  assert.equal(lastN.fromDay, "2026-09-17");
  assert.equal(lastN.days, 3);
});

test("8.2：Asia/Shanghai 下 today 的半开区间换算回 UTC", () => {
  const window = resolveWindow({ kind: "today" }, { tz: "Asia/Shanghai", weekStart: "monday", now: NOW });
  assert.equal(window.fromDay, "2026-09-19");
  assert.equal(window.fromMs, Date.parse("2026-09-18T16:00:00.000Z"));
  assert.equal(window.toMs, Date.parse("2026-09-19T15:59:59.999Z"));
});

test("T-3：weekStart 可配（monday / sunday）", () => {
  assert.equal(weekStartDay("2026-09-19", "monday"), "2026-09-14");
  assert.equal(weekStartDay("2026-09-19", "sunday"), "2026-09-13");
  assert.equal(weekdayOf("2026-09-19"), 6, "2026-09-19 是周六");
  assert.equal(weekdayOf("2026-09-20"), 0, "2026-09-20 是周日");
});

test("T-4：月份边界与自然日运算", () => {
  assert.equal(monthStartDay("2026-09-19"), "2026-09-01");
  assert.equal(nextMonthStartDay("2026-12-31"), "2027-01-01");
  assert.equal(addCivilDays("2026-09-19", -29), "2026-08-21");
  assert.equal(civilDayDiff("2026-08-21", "2026-09-19"), 29);
});

test("AC-5.5：反向窗口自动交换并置 window.swapped", () => {
  const window = resolveWindow(
    { kind: "custom", fromDay: "2026-09-19", toDay: "2026-09-01" },
    { tz: "UTC", weekStart: "monday", now: NOW },
  );
  assert.equal(window.swapped, true);
  assert.equal(window.fromDay, "2026-09-01");
  assert.equal(window.toDay, "2026-09-19");
  assert.equal(window.days, 19);
});

test("8.3：previousWindow 是紧邻等长前一窗口", () => {
  const window = resolveWindow({ kind: "last7d" }, { tz: "UTC", weekStart: "monday", now: NOW });
  const previous = previousWindow(window, "monday");
  assert.equal(previous.toDay, "2026-09-12");
  assert.equal(previous.fromDay, "2026-09-06");
  assert.equal(previous.days, 7);
  assert.equal(previous.toMs, dayStartMs("2026-09-12", "UTC") + 86_400_000 - 1);
});

test("FR-5.1：窗口参数解析（名称 / 最近 N 天 / 自定义区间）", () => {
  assert.deepEqual(parseWindowInput("last7d"), { kind: "last7d" });
  assert.deepEqual(parseWindowInput("14"), { kind: "lastN", n: 14 });
  assert.deepEqual(parseWindowInput(30), { kind: "lastN", n: 30 });
  assert.deepEqual(parseWindowInput("2026-09-01..2026-09-19"), {
    kind: "custom",
    fromDay: "2026-09-01",
    toDay: "2026-09-19",
  });
  assert.deepEqual(parseWindowInput("nonsense", { kind: "today" }), { kind: "today" });
  // 反向区间由 resolveWindow 交换（AC-5.5）。
  assert.deepEqual(parseWindowInput("2026-09-19..2026-09-01"), {
    kind: "custom",
    fromDay: "2026-09-19",
    toDay: "2026-09-01",
  });
});

test("all 窗口的边界由聚合层回填（此处只校验哨兵值）", () => {
  const window = resolveWindow({ kind: "all" }, { tz: "UTC", weekStart: "monday", now: NOW });
  assert.equal(window.fromMs, 0);
  assert.equal(window.toMs, Number.MAX_SAFE_INTEGER);
  assert.equal(window.fromDay, "");
});
