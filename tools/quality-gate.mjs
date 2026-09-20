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
 *   9) 纯逻辑测试不 import 宿主包（NFR-1）
 *  10) 可发布性：npm 元数据 + pi manifest + `npm pack` 产物覆盖扩展入口的全部相对依赖（G-6 / NFR-9）
 *
 * 用法：node tools/quality-gate.mjs
 */

import { execSync } from "node:child_process";
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

/** ¥8：唯一允许的出站主机白名单（除回环地址以外）。 */
const RATE_HOST_ALLOWLIST = new Set(["open.er-api.com", "api.frankfurter.dev", "api.exchangerate-api.com"]);

// 3) NFR-7：除回环地址与汇率接口外，零出站目标
await check("NFR-7 出站目标只允许回环地址与汇率接口", () => {
  const offenders = [];
  for (const file of productionFiles) {
    const body = fs.readFileSync(file, "utf8");
    for (const url of body.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
      // 本机仪表盘地址（127.0.0.1 / localhost / ::1）始终允许。
      if (/^https?:\/\/(127\.0\.0\.1|localhost|::1)/.test(url)) continue;
      // ¥8：汇率接口只能出现在 src/rates.ts，且主机必须在白名单内。
      if (rel(file) !== "src/rates.ts") {
        offenders.push(`${rel(file)}: ${url}`);
        continue;
      }
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        host = "";
      }
      if (!RATE_HOST_ALLOWLIST.has(host)) offenders.push(`src/rates.ts: ${url}（主机不在白名单）`);
      if (!url.startsWith("https://")) offenders.push(`src/rates.ts: ${url}（必须 https）`);
    }
  }
  return offenders.length === 0 ? true : offenders.join("; ");
});

// 3b) ¥8：联网必须由配置开关把关，且不是除了 rates.ts 还有别的出口
await check("¥8 汇率联网由 currency.autoRate 把关且出口唯一", () => {
  const rates = fs.readFileSync(path.join(root, "src", "rates.ts"), "utf8");
  for (const token of ["RATE_PROVIDERS", "fetchUsdCnyRate", "pickCnyRate", "isRateStale", "AUTO_RATE_TTL_MS"]) {
    if (!rates.includes(token)) return `src/rates.ts 缺少 ${token}`;
  }
  const api = fs.readFileSync(path.join(root, "src", "dashboard", "api.ts"), "utf8");
  if (!/currency\.autoRate/.test(api)) return "api.ts 未按 currency.autoRate 把关";
  if (!/force/.test(api)) return "api.ts 缺少显式手动更新通道（force）";
  // 服务端不得绕过 rates.ts 自行调用 fetch（assets.ts 是浏览器侧同源请求，不算）。
  const offenders = productionFiles
    .filter((file) => rel(file) !== "src/rates.ts" && rel(file) !== "src/dashboard/assets.ts")
    .filter((file) => /\bfetch\s*\(/.test(stripComments(fs.readFileSync(file, "utf8"))));
  return offenders.length === 0 ? true : offenders.map(rel).join(", ");
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

// 6) AC-8.9 / AC-8.2：图表几何回归（ADR-0003 的根因防护）
await check("AC-8.9 / AC-8.2 图表几何与指标控件", () => {
  const assets = fs.readFileSync(path.join(root, "src", "dashboard", "assets.ts"), "utf8");
  const rule = /\.trend \.bar \{([^}]*)\}/.exec(assets);
  if (rule === null) return "未找到 .trend .bar 规则";
  // ADR-0003：纵向容器上的 flex 简写会覆盖行内 height 并把柱宽留成 0，导致柱子完全不可见。
  if (/\bflex\b/.test(rule[1] ?? "")) return ".trend .bar 不得出现 flex 简写";
  if (!assets.includes('style=\\"width:" + layout.barWidth')) return "柱宽必须来自 trendLayout().barWidth";
  if (!assets.includes('class=\\"col\\" style=\\"width:" + layout.step')) return "列宽必须来自 trendLayout().step";
  // D-3：不再有任何指标切换控件。
  if (/id="metric"/.test(assets)) return "页面不得包含指标切换控件";
  if (/state\.metric/.test(assets)) return "前端不得持有指标状态";
  // FR-4：内存实时计数器已删除（跨进程/跨会话不可靠）；不得以任何形式回归。
  if (/card\.live|summary\.live/.test(assets)) return "页面不得再渲染「本会话（实时）」卡片";
  const engine = fs.readFileSync(path.join(root, "src", "scanner.ts"), "utf8");
  if (/recordLiveUsage|getLiveTotals|resetLive/.test(engine)) return "引擎不得再持有内存实时计数器";
  const types = fs.readFileSync(path.join(root, "src", "types.ts"), "utf8");
  if (/^\s+live\?:/m.test(types)) return "7.5 已删除 live 字段，不得回归";
  return true;
});

// 7) P-13：不硬编码汇率 / 不使用 $ 作为面向用户金额符号
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

/**
 * 10) G-6 / NFR-9：可发布性。
 *
 * 安装方式从「本地路径 / 复制」改成一般方式后，发布产物本身就是交付物：
 * 缺字段、`private`、`files` 白名单漏目录、`pi.extensions` 指向不存在的文件，
 * 都会让 `pi install npm:<pkg>` / `npm install` 在用户机器上失败，而本地跑测试发现不了。
 */
function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
}

await check("G-6 可发布性：npm 元数据与 pi manifest 完整", () => {
  const pkg = readPackageJson();
  // npm 上 `pi-monitor` 已被他人占用（miclivs，macOS 后台进程扩展），发布会被 403 拒绝。
  if (pkg.name === "pi-monitor") return "npm 上 pi-monitor 已被他人占用，请改用 scoped 名（@scope/pi-monitor）或其它未占用名";
  if (typeof pkg.name !== "string" || pkg.name.trim() === "") return "package.json 缺少 name";
  if (pkg.private === true) return "package.json 仍是 private，无法发布到 npm";
  if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+/.test(pkg.version)) return "package.json 的 version 不是 semver";
  if (typeof pkg.license !== "string") return "package.json 未声明 license";
  if (typeof pkg.repository?.url !== "string") return "package.json 缺少 repository.url";
  if (typeof pkg.homepage !== "string") return "package.json 缺少 homepage";
  if (!Array.isArray(pkg.keywords) || !pkg.keywords.includes("pi-package")) return "keywords 缺少 pi-package（pi 包画廊按该标签收录）";
  if (pkg.engines?.node === undefined) return "package.json 缺少 engines.node";
  if (pkg.publishConfig?.access !== "public") return "package.json 缺少 publishConfig.access = public";
  if (typeof pkg.scripts?.prepack !== "string") return "package.json 缺少 prepack 脚本（发布前必须跑 npm run check）";

  const manifest = pkg.pi?.extensions;
  if (!Array.isArray(manifest) || manifest.length === 0) return "pi.extensions 为空";
  for (const entry of manifest) {
    if (!fs.existsSync(path.join(root, entry))) return `pi.extensions 指向不存在的路径：${entry}`;
  }

  const files = pkg.files;
  if (!Array.isArray(files) || files.length === 0) return "缺少 files 白名单（否则会把 test/node_modules 一起发出去）";
  const normalized = files.map((item) => String(item).replace(/^\.[/\\]/, "").replace(/[/\\]+$/, ""));
  for (const required of ["extensions", "src"]) {
    if (!normalized.includes(required)) return `files 白名单缺少 ${required}（运行时必需）`;
  }
  return true;
});

/** 从源码里收集相对 import 目标（本级相对 specifier）。 */
function relativeImportSpecifiers(fileRel) {
  const body = fs.readFileSync(path.join(root, fileRel), "utf8");
  const patterns = [
    /\bfrom\s*["'](\.[^"']+)["']/g,
    /\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g,
    /^\s*import\s*["'](\.[^"']+)["']/gm,
  ];
  const specifiers = new Set();
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

/** npm pack --dry-run 的产物文件清单（相对包根，POSIX 分隔符）。 */
function packedFileList() {
  // --ignore-scripts：避免 prepack 再次触发本质量门（递归）。
  const stdout = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(stdout);
  const files = Array.isArray(parsed) ? parsed[0]?.files : undefined;
  if (!Array.isArray(files)) throw new Error("npm pack --dry-run --json 输出中缺少 files");
  return new Set(files.map((file) => String(file.path).replace(/\\/g, "/")));
}

await check("G-6 打包产物覆盖扩展入口及其全部相对依赖", () => {
  const pkg = readPackageJson();
  let packed;
  try {
    packed = packedFileList();
  } catch (error) {
    return `npm pack --dry-run 失败：${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
  }

  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!packed.has(required)) return `打包产物缺少 ${required}`;
  }

  // 从每个 pi manifest 入口出发做一次传递闭包：入口与它 import 到的每个仓库内文件都必须进包。
  const entries = pkg.pi?.extensions ?? [];
  const seen = new Set();
  const queue = entries.map((entry) => String(entry).replace(/^\.\//, "").replace(/\\/g, "/"));
  while (queue.length > 0) {
    const fileRel = queue.shift();
    if (seen.has(fileRel)) continue;
    seen.add(fileRel);
    if (!packed.has(fileRel)) return `打包产物缺少 ${fileRel}（由 ${entries.join(", ")} 依赖）`;
    for (const specifier of relativeImportSpecifiers(fileRel)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(fileRel), specifier));
      if (!target.startsWith("..")) queue.push(target);
    }
  }

  // 交付面收敛（NFR-9 + 仓库卫生）：只允许扩展入口与 src，外加 npm 恒包含的元数据文件。
  // 本机非公开的开发记录（PRD.md / docs/ / CHANGELOG.md）绝不能随包发出。
  const alwaysIncluded = new Set(["package.json", "README.md", "LICENSE"]);
  for (const file of packed) {
    if (alwaysIncluded.has(file)) continue;
    if (file.startsWith("extensions/") || file.startsWith("src/")) continue;
    return `打包产物不应包含 ${file}`;
  }
  return true;
});

for (const line of checks) process.stdout.write(`${line}\n`);
if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} 项质量门失败：\n`);
  for (const line of failures) process.stdout.write(`${line}\n`);
  process.exit(1);
}
process.stdout.write(`\n质量门通过（${checks.length} 项）。\n`);
