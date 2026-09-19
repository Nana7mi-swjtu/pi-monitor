/**
 * helpers.ts — 测试公共工具。
 * 需求：16.1（测试层次）、16.2（fixture 会话）
 *
 * 注意（P-4）：测试不得替换 `aggregate` / `dedupe` / `parser` / `money` 的实现；
 * 本文件只负责读取 fixture（输入数据）与构造临时目录。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emptyPricingTable, type PricingTable } from "../src/pricing.ts";
import { parseSessionFile } from "../src/scanner.ts";
import type { ParsedSession } from "../src/parser.ts";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixturesRoot = path.join(projectRoot, "test", "fixtures");
export const sessionsDir = path.join(fixturesRoot, "sessions", "--D--fixtures--");

export function fixturePath(name: string): string {
  return path.join(sessionsDir, name);
}

export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export interface ExpectedRecord {
  entryId: string;
  kind: string;
  toolName: string | null;
  ts: string;
  tsSource: string;
  provider: string | null;
  model: string | null;
  api: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  billed: number;
  costUsd: number | null;
  costUsdEst: number | null;
  day: string;
}

export interface ExpectedFile {
  sessionId: string;
  cwd: string | null;
  source: string;
  stats: {
    corruptLines: number;
    invalidSessions: number;
    corruptUsage: number;
    corruptDuplicateIds: number;
    inconsistencyCount: number;
    corruptCost: number;
  };
  records: ExpectedRecord[];
}

export interface ExpectedFixture {
  tz: string;
  files: Record<string, ExpectedFile>;
}

export function loadExpected(): ExpectedFixture {
  return readJson<ExpectedFixture>(path.join(fixturesRoot, "expected-records.json"));
}

export async function parseFixture(name: string, pricing: PricingTable = emptyPricingTable()): Promise<ParsedSession> {
  return parseSessionFile(fixturePath(name), pricing);
}

/** 临时 agentDir（模拟 `<agentDir>/pi-monitor/` 目录布局）。 */
export function makeTempAgentDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-monitor-test-"));
  return dir;
}

export function makeTempSessionDir(agentDir: string, name: string): string {
  const dir = path.join(agentDir, "sessions", name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
}

/** 写入一个会话文件（测试用最小 fixture 构造器，输入数据，不作为期望来源）。 */
export function writeSessionFile(
  dir: string,
  name: string,
  entries: unknown[],
  options: { header?: Record<string, unknown>; trailingNewline?: boolean } = {},
): string {
  const header = options.header ?? {
    type: "session",
    version: 3,
    id: "sess-temp",
    timestamp: "2026-09-19T00:00:00.000Z",
    cwd: "D:\\temp",
  };
  const body = [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n");
  const text = options.trailingNewline === false ? body : `${body}\n`;
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, "utf8");
  return file;
}

/** 构造一条 assistant usage entry（测试输入）。 */
export function assistantEntry(options: {
  id: string;
  iso: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  costTotal?: number | null;
  provider?: string;
  model?: string;
}): Record<string, unknown> {
  const usage: Record<string, unknown> = {
    input: options.input,
    output: options.output,
    cacheRead: options.cacheRead ?? 0,
    cacheWrite: options.cacheWrite ?? 0,
    reasoning: 0,
    totalTokens: options.input + options.output + (options.cacheRead ?? 0) + (options.cacheWrite ?? 0),
  };
  if (options.costTotal !== undefined && options.costTotal !== null) {
    usage["cost"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: options.costTotal };
  }
  return {
    type: "message",
    id: options.id,
    parentId: null,
    timestamp: options.iso,
    message: {
      role: "assistant",
      api: "openai-completions",
      provider: options.provider ?? "acme",
      model: options.model ?? "acme-1",
      usage,
      stopReason: "stop",
      timestamp: Date.parse(options.iso),
    },
  };
}
