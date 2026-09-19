/**
 * paths.ts — agentDir / sessionDir / Windows 路径规范化（NFR-8、FR-1.1、FR-1.6）。
 * 需求：4.1（路径解析顺序）、FR-1.1、FR-1.6、1.2（防御未确认根因）、NFR-8
 *
 * 本模块只做纯字符串/路径运算与 node:path / node:os 调用，不 import 任何宿主包。
 */

import { homedir } from "node:os";
import path from "node:path";

/** 4.1：agentDir 解析顺序 `PI_CODING_AGENT_DIR` → `~/.pi/agent`。 */
export function resolveAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["PI_CODING_AGENT_DIR"];
  if (fromEnv && fromEnv.trim().length > 0) return normalizePath(fromEnv.trim());
  return path.join(homedir(), ".pi", "agent");
}

/** 4.1 / FR-1.1：会话根目录解析顺序 `extraSessionDirs[]` + `PI_CODING_AGENT_SESSION_DIR` + `<agentDir>/sessions`。
 *  结果按平台上“路径键”去重（Windows 大小写不敏感）。 */
export function resolveSessionRoots(
  agentDir: string,
  extraSessionDirs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const candidates: string[] = [];
  for (const dir of extraSessionDirs) {
    if (typeof dir === "string" && dir.trim().length > 0) candidates.push(dir.trim());
  }
  const fromEnv = env["PI_CODING_AGENT_SESSION_DIR"];
  if (fromEnv && fromEnv.trim().length > 0) candidates.push(fromEnv.trim());
  candidates.push(path.join(agentDir, "sessions"));

  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const abs = normalizePath(candidate);
    const key = pathKey(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

/** pi-monitor 数据目录：`<agentDir>/pi-monitor/`（7.1）。 */
export function resolveDataDir(agentDir: string): string {
  return path.join(agentDir, "pi-monitor");
}

/** 统一为规范化绝对路径；Windows 上保留盘符与 UNC（NFR-8）。 */
export function normalizePath(input: string): string {
  let value = input.trim();
  if (value.length === 0) return value;
  if (value.startsWith("~")) {
    value = path.join(homedir(), value.slice(1));
  }
  const normalized = path.normalize(value);
  if (path.isAbsolute(normalized)) return normalized;
  return path.resolve(normalized);
}

/** 用于路径比较的键：Windows / macOS 大小写不敏感（FR-1.1）。 */
export function pathKey(input: string): string {
  const normalized = path.normalize(input);
  if (process.platform === "win32" || process.platform === "darwin") {
    return normalized.toLowerCase();
  }
  return normalized;
}

/**
 * FR-1.6：`project` 缺失时回退解码目录名。
 * pi 把项目路径里的 `/` 与 `:` 替换成 `-`，例如项目目录 `acme/app` 会被编码为 `--acme-app--`；
 * 本函数按当前平台的路径分隔符把它解回原路径。
 */
export function decodeProjectFromDirName(dirName: string): string | null {
  const trimmed = dirName.replace(/^-+/, "").replace(/-+$/, "");
  if (trimmed.length === 0) return null;
  const parts = trimmed.split("-").filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  if (process.platform === "win32") {
    return parts.join("\\");
  }
  return `/${parts.join("/")}`;
}

/** FR-1.6 / 7.3：项目路径规范化，缺失时回退 `"(unknown)"`。 */
export function normalizeProject(cwd: string | null | undefined, sessionFile: string): string {
  if (typeof cwd === "string" && cwd.trim().length > 0) {
    return normalizePath(cwd);
  }
  const decoded = decodeProjectFromDirName(path.basename(path.dirname(sessionFile)));
  return decoded ?? "(unknown)";
}

/** 隐私（FR-14.3 / 10.1 页脚）：数据目录脱敏 —— 只保留 home 前缀为 `~`。 */
export function redactHome(input: string): string {
  const home = homedir();
  if (home.length > 0 && pathKey(input).startsWith(pathKey(home))) {
    return `~${input.slice(home.length)}`;
  }
  return input;
}

/** 12 章：配置文件路径 `<agentDir>/pi-monitor/config.json`（FR-11.1）。 */
export function resolveConfigPath(agentDir: string): string {
  return path.join(resolveDataDir(agentDir), "config.json");
}
