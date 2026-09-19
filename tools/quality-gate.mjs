/**
 * quality-gate.mjs — 16.3 的元测试：验证「实现没有为过测试而实现」。
 *
 * 检查项（与 PRD 16.3 第 4 项一一对应）：
 *   1) dependencies 为空（NFR-1）
 *   2) src/** 无 @earendil-works/* import；index.ts 无 pi-tui / ctx.ui.custom / setStatus / setWidget / setFooter（AC-15.1）
 *   3) 无外网目标（NFR-7）
 *   4) 无 P-1 特征（fixtures/、NODE_ENV、isTest、PI_MONITOR_TEST）
 *   5) 无 CLI 痕迹（无 bin 字段、无 process.argv 解析、无 stdout 报表输出）
 *   6) 无 '7.2' 硬编码汇率常量、无面向用户的 '$' 金额符号（P-13）
 *   7) 无 skip/todo 测试（P-5）
 *   8) 账本字段集合与 PRD 7.3 完全一致（AC-14.1）
 *
 * 用法：node tools/quality-gate.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const checks = [];

async function check(name, fn) {
  const result = await fn();
  if (result === true) {
    checks.push(`✔ ${name}`);
    return;
  }
  failures.push(`✘ ${name}：${result}`);
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function stripCommentsAndStrings(source) {
  return stripComments(source)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/`(?:[^`\\]|\\.)*`/g, "``");
}

function walk(dir, predicate = () => true) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...walk(full, predicate));
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (file) => path.relative(root, file).replace(/\\/g, "/");

const srcFiles = walk(path.join(root, "src"), (file) => file.endsWith(".ts"));
const extensionFiles = walk(path.join(root, "extensions"), (file) => file.endsWith(".ts"));
const productionFiles = [...srcFiles, ...extensionFiles];
const testFiles = walk(path.join(root, "test"), (file) => /\.(ts|mjs)$/.test(file));

// 1) NFR-1：零第三方运行时依赖
await check("NFR-1 dependencies 字段存在且为空", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  // 注意：`npm install --save-dev` 会默默删掉空的 `dependencies` 对象，因此必须同时
  // 断言字段存在（PRD 11 章的 package.json 要点要求显式写 `"dependencies": {}`）。
  if (!("dependencies" in pkg)) return "package.json 缺少 dependencies 字段";
  const deps = pkg.dependencies ?? {};
  return Object.keys(deps).length === 0 ? true : `dependencies = ${JSON.stringify(deps)}`;
});

await check("package.json 的 license 与 LICENSE 文件一致", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const licensePath = path.join(root, "LICENSE");
  if (!fs.existsSync(licensePath)) return "缺少 LICENSE 文件";
  const body = fs.readFileSync(licensePath, "utf8");
  if (pkg.license === "MIT" && !/^MIT License/m.test(body)) return "LICENSE 不是 MIT 文本";
  if (pkg.license === undefined) return "package.json 未声明 license";
  return true;
});

// 2) AC-15.1：依赖方向 + TUI 禁用项
await check("AC-15.1 src/** 不 import 宿主包", () => {
  const offenders = srcFiles.filter((file) => /@earendil-works\//.test(stripComments(fs.readFileSync(file, "utf8"))));
  return offenders.length === 0 ? true : offenders.map(rel).join(", ");
});

await check("AC-15.1 index.ts 无 TUI 专属 API", () => {
  const entry = path.join(root, "extensions", "pi-monitor", "index.ts");
  const body = stripComments(fs.readFileSync(entry, "utf8"));
  const forbidden = ["ctx.ui.custom", "setStatus", "setWidget", "setFooter", "pi-tui", "registerEntryRenderer", "registerMessageRenderer"];
  const hits = forbidden.filter((token) => body.includes(token));
  return hits.length === 0 ? true : hits.join(", ");
});

// 3) NFR-7：零出站请求
await check("NFR-7 无外网目标", () => {
  const offenders = [];
  for (const file of productionFiles) {
    const body = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
    const urls = body.match(/https?:\/\/[^\s"'`)]+/g) ?? [];
    // 生产代码里不应出现任何 URL（打开浏览器的 URL 由运行时拼装）。
    if (urls.length > 0) offenders.push(`${rel(file)}: ${urls.join(" ")}`);
  }
  const assets = fs.readFileSync(path.join(root, "src", "dashboard", "assets.ts"), "utf8");
  for (const url of assets.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
    if (!/^https?:\/\/(127\.0\.0\.1|localhost|::1)/.test(url)) offenders.push(`assets.ts: ${url}`);
  }
  return offenders.length === 0 ? true : offenders.join("; ");
});

// 4) P-1：不得针对测试/fixture 特判
await check("P-1 无测试特判特征", () => {
  const patterns = [/fixtures\//, /\bNODE_ENV\b/, /\bisTest\b/, /PI_MONITOR_TEST/];
  const offenders = [];
  for (const file of productionFiles) {
    const body = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
    for (const pattern of patterns) {
      if (pattern.test(body)) offenders.push(`${rel(file)}: ${pattern}`);
    }
  }
  return offenders.length === 0 ? true : offenders.join("; ");
});

// 5) NG-5：不提供 CLI
await check("NG-5 无 CLI 痕迹", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (pkg.bin !== undefined) return "package.json 存在 bin 字段";
  const offenders = [];
  for (const file of productionFiles) {
    const body = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
    if (/process\.argv/.test(body)) offenders.push(`${rel(file)}: process.argv`);
    if (/process\.stdout\.write/.test(body)) offenders.push(`${rel(file)}: process.stdout.write`);
    if (/console\.log\(/.test(body)) offenders.push(`${rel(file)}: console.log`);
  }
  return offenders.length === 0 ? true : offenders.join("; ");
});

// 6) P-13：不硬编码汇率 / 不使用 $ 作为面向用户金额符号
await check("P-13 汇率不是硬编码常量", () => {
  const offenders = [];
  for (const file of productionFiles) {
    if (rel(file) === "src/config.ts") continue; // DEFAULT_RATE 是 PRD ¥3 规定的默认值
    const body = stripCommentsAndStrings(fs.readFileSync(file, "utf8"));
    if (/\b7\.20?\b/.test(body)) offenders.push(rel(file));
  }
  return offenders.length === 0 ? true : offenders.join(", ");
});

await check("P-13 i18n 字典不含 $ 金额符号", async () => {
  const i18n = await import(pathToFileURL(path.join(root, "src", "i18n.ts")).href);
  const offenders = [];
  for (const [locale, dict] of Object.entries(i18n.dictionaries)) {
    for (const [key, value] of Object.entries(dict)) {
      if (/\$\s*\d/.test(value)) offenders.push(`${locale}.${key} = ${value}`);
    }
  }
  if (offenders.length > 0) return offenders.join("; ");
  // ¥1：面向用户的金额必须使用人民币符号。
  const zhRate = i18n.dictionaries["zh-CN"]["rate.line"];
  return typeof zhRate === "string" && zhRate.includes("USD") ? true : "缺少汇率标注文案";
});

// 7) P-5：不得跳过/待办测试
await check("P-5 无 skip/todo 测试", () => {
  const offenders = [];
  for (const file of testFiles) {
    const body = fs.readFileSync(file, "utf8");
    if (/test\.skip\(|test\.todo\(|describe\.skip\(|\bit\.skip\(/.test(body)) offenders.push(rel(file));
  }
  return offenders.length === 0 ? true : offenders.join(", ");
});

// 8) AC-14.1：账本字段集合封闭
await check("AC-14.1 账本字段集合与 PRD 7.3 一致", () => {
  const expected = [
    "v",
    "fp",
    "ts",
    "tsSource",
    "day",
    "tz",
    "provider",
    "model",
    "api",
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
    "sessionId",
    "sessionFile",
    "entryId",
    "cwd",
    "project",
    "source",
    "ephemeral",
  ];
  const body = fs.readFileSync(path.join(root, "src", "types.ts"), "utf8");
  const match = /export const LEDGER_FIELDS[\s\S]*?=\s*\[([\s\S]*?)\]\s*as const;/.exec(body);
  if (match === null) return "未找到 LEDGER_FIELDS";
  const actual = [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((item) => item[1]);
  const same = actual.length === expected.length && actual.every((field, index) => field === expected[index]);
  return same ? true : `实际 ${actual.join(",")}`;
});

// 9) NFR-1：可测性 —— 纯逻辑测试不得依赖 node_modules
await check("NFR-1 单元测试不 import 宿主包", () => {
  const offenders = [];
  for (const file of walk(path.join(root, "test"), (item) => item.endsWith(".ts"))) {
    if (rel(file).startsWith("test/contract/")) continue; // 契约测试必须加载扩展入口
    const body = fs.readFileSync(file, "utf8");
    if (/"@earendil-works\//.test(body) || /"typebox"/.test(body)) offenders.push(rel(file));
  }
  return offenders.length === 0 ? true : offenders.join(", ");
});

for (const line of checks) process.stdout.write(`${line}\n`);
if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} 项质量门失败：\n`);
  for (const line of failures) process.stdout.write(`${line}\n`);
  process.exit(1);
}
process.stdout.write(`\n质量门通过（${checks.length} 项）。\n`);
