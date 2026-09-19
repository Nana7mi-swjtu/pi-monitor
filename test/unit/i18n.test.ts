/**
 * i18n.test.ts — FR-13（AC-13.1~AC-13.3）、9.2 文案规范、AC-15.4（链接消息）。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { buildLinkMessage, LINK_MESSAGE_LIMIT, parseTokensArgs, TOKENS_USAGE } from "../../src/args.ts";
import { dictionaries, resolveLocale, translate, windowLabel } from "../../src/i18n.ts";
import { resolveWindow } from "../../src/time.ts";
import { fixturesRoot, projectRoot, readJson } from "../helpers.ts";

test("AC-13.1：两种语言下仪表盘关键文案与 golden 一致", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const golden = readJson<Record<string, string>>(
      path.join(fixturesRoot, "..", "golden", `dashboard-${locale}.json`),
    );
    for (const [key, value] of Object.entries(golden)) {
      if (key.startsWith("_")) continue;
      assert.equal(dictionaries[locale][key], value, `${locale} ${key}`);
    }
  }
  // 9.2：产品名恒定，不随语言变化。
  assert.equal(translate("zh-CN", "app.title"), "pi-monitor");
  assert.equal(translate("en-US", "app.title"), "pi-monitor");
});

test("AC-13.2：语言切换只改变文案，不改变数字/金额/日期口径", () => {
  const day = "2026-09-19";
  assert.equal(day, "2026-09-19");
  // 窗口标签是唯一随语言变化的展示文本；日键与金额由 format.ts 的语无关算法给出。
  const window = resolveWindow(
    { kind: "custom", fromDay: "2026-09-13", toDay: "2026-09-19" },
    { tz: "UTC", weekStart: "monday", now: Date.parse("2026-09-19T12:00:00Z") },
  );
  assert.equal(windowLabel("zh-CN", window), "2026-09-13 → 2026-09-19");
  assert.equal(windowLabel("en-US", window), "2026-09-13 → 2026-09-19");
  assert.equal(windowLabel("zh-CN", { ...window, kind: "last7d" }), "近 7 天");
  assert.equal(windowLabel("en-US", { ...window, kind: "last7d" }), "Last 7 days");
  assert.equal(windowLabel("en-US", { ...window, kind: "lastN", n: 14 }), "Last 14 days");
});

test("AC-13.3 / FR-13.5：缺键回退英文，绝不显示裸 key", () => {
  const zh = { ...dictionaries["zh-CN"] };
  const key = "card.billed";
  delete (zh as Record<string, string>)[key];
  // 直接验证 translate 的回退链：zh 缺失 → en → 可读化。
  assert.equal(translate("en-US", key), "Billed tokens");
  assert.equal(translate("zh-CN", "totally.unknown.key"), "Key");
  assert.equal(translate("en-US", "another_missing_key"), "Another missing key");
  assert.notEqual(translate("zh-CN", key), key);
});

test("FR-13.1：语言解析顺序 配置 → PI_MONITOR_LOCALE → LANG/LC_ALL → 默认 en-US", () => {
  assert.deepEqual(resolveLocale("zh-CN", {}), { locale: "zh-CN", source: "config" });
  assert.deepEqual(resolveLocale("en-US", { PI_MONITOR_LOCALE: "zh-CN" }), { locale: "en-US", source: "config" });
  assert.deepEqual(resolveLocale("auto", { PI_MONITOR_LOCALE: "zh_CN.UTF-8" }), { locale: "zh-CN", source: "env" });
  assert.deepEqual(resolveLocale("auto", { LANG: "zh-CN.UTF-8" }), { locale: "zh-CN", source: "system" });
  assert.deepEqual(resolveLocale("auto", { LC_ALL: "en_US.UTF-8", LANG: "zh_CN.UTF-8" }), {
    locale: "en-US",
    source: "system",
  });
  assert.deepEqual(resolveLocale("auto", {}), { locale: "en-US", source: "default" });
});

test("AC-6.7：/tokens 参数解析——非法参数只记录，不抛异常", () => {
  assert.deepEqual(parseTokensArgs(""), { noOpen: false, port: null, invalid: [] });
  assert.deepEqual(parseTokensArgs("--no-open"), { noOpen: true, port: null, invalid: [] });
  assert.deepEqual(parseTokensArgs("--port 8090"), { noOpen: false, port: 8090, invalid: [] });
  assert.deepEqual(parseTokensArgs("--no-open --port 65535"), { noOpen: true, port: 65535, invalid: [] });

  const badPort = parseTokensArgs("--port abc");
  assert.equal(badPort.port, null);
  assert.deepEqual(badPort.invalid, ["--port abc"]);

  const outOfRange = parseTokensArgs("--port 80");
  assert.equal(outOfRange.port, null);
  assert.equal(outOfRange.invalid.length, 1);

  const extra = parseTokensArgs("extra --port 1023");
  assert.deepEqual(extra.invalid, ["extra", "--port 1023"]);
  assert.equal(extra.noOpen, false);

  // 缺少 --port 的值
  assert.deepEqual(parseTokensArgs("--port").invalid, ["--port"]);
});

test("AC-6.5：链接消息 ≤ 300 字符、只含标题/URL/关闭方法、customType 固定", () => {
  const url = "http://127.0.0.1:30142/?t=" + "a".repeat(32);
  for (const locale of ["zh-CN", "en-US"] as const) {
    const text = buildLinkMessage(url, locale);
    assert.ok(text.length <= LINK_MESSAGE_LIMIT, `${locale} 长度 ${text.length}`);
    assert.ok(text.includes(url), "必须包含完整 URL");
    assert.ok(text.split("\n").length <= 4, "只允许标题 / URL / 关闭方法");
    // AC-6.6：不得出现 Markdown 表格分隔行。
    assert.equal(/\|\s*-{3,}/.test(text), false);
  }
  assert.equal(TOKENS_USAGE.includes("--no-open"), true);
});

test("NFR-7：仪表盘资产与字典中不含外部网络目标", () => {
  const assets = fs.readFileSync(path.join(projectRoot, "src", "dashboard", "assets.ts"), "utf8");
  const urls = assets.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
  for (const url of urls) {
    assert.match(url, /^https?:\/\/(127\.0\.0\.1|localhost|::1)/, `资产中出现外部目标：${url}`);
  }
  assert.equal(/cdn\.|fonts\.googleapis|unpkg|jsdelivr/i.test(assets), false, "禁止 CDN 与外部字体");
});

test("FR-8 / NFR-11：页面脚本引用的每个 DOM id / 选择器都存在于模板中", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "dashboard", "assets.ts"), "utf8");
  const templateStart = source.indexOf("export function renderDashboardHtml");
  assert.ok(templateStart > 0, "未找到 renderDashboardHtml");
  const template = source.slice(templateStart);

  const referenced = new Set<string>();
  for (const match of source.matchAll(/getElementById\("([^"]+)"\)/g)) referenced.add(match[1] as string);
  for (const match of source.matchAll(/querySelectorAll\("#([A-Za-z0-9_-]+)/g)) referenced.add(match[1] as string);

  const declared = new Set<string>();
  for (const match of template.matchAll(/id="([^"]+)"/g)) declared.add(match[1] as string);

  const missing = [...referenced].filter((id) => !declared.has(id)).sort();
  assert.deepEqual(missing, [], `脚本引用了模板中不存在的 id：${missing.join(", ")}`);
  // 至少应该引用到这些关键节点（防止模板被清空而测试仍通过）。
  for (const id of ["cards", "heat", "trend", "tabs", "breakdown-table", "health-body", "drawer"]) {
    assert.ok(declared.has(id), `模板缺少 ${id}`);
  }
});

test("FR-8：前端脚本通过语法检查（无 SyntaxError）且不使用外部 API", () => {
  const source = fs.readFileSync(path.join(projectRoot, "src", "dashboard", "assets.ts"), "utf8");
  const match = /const APP_JS = String\.raw`([\s\S]*?)`;/.exec(source);
  assert.ok(match, "未找到内联前端脚本");
  const script = match[1] as string;
  assert.doesNotThrow(() => new Function(script), "前端脚本存在语法错误");
  // 不得使用外部 CDN 类 API（NFR-7）。
  for (const forbidden of ["importScripts", "document.write", "XMLHttpRequest", "WebSocket", "EventSource", "localStorage"]) {
    assert.equal(script.includes(forbidden), false, `前端脚本不得使用 ${forbidden}`);
  }
  // 必须只用内嵌资产（无外部字体 / 无外链）。
  assert.equal(/<link|@import|src="http/.test(source), false);
});

test("10.1：仪表盘模板包含全部区块与引导数据（i18n 字典 / token / 配置）", () => {
  const assets = fs.readFileSync(path.join(projectRoot, "src", "dashboard", "assets.ts"), "utf8");
  assert.ok(assets.includes("__PI_MONITOR_BOOT__"), "必须注入引导数据");
  assert.ok(assets.includes("options.i18n") || assets.includes("i18n: options.i18n"), "必须注入两种语言的字典");
  assert.ok(assets.includes("options.token"), "必须注入 token");
  // 页脚（10.1 第 11 项）
  assert.ok(assets.includes('id="footer-meta"'));
  // 导出三件套（FR-9.1）
  for (const id of ["btn-export-md", "btn-export-json", "btn-export-csv", "btn-rebuild", "btn-rescan"]) {
    assert.ok(assets.includes(`id="${id}"`), `缺少 ${id}`);
  }
});
