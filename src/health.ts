/**
 * health.ts — 健康面板数据与诊断（含 NFR-6 日志轮转）。
 * 需求：FR-12.7（健康面板字段清单）、NFR-6（日志目录 / 保留 7 天 / 单文件 ≤ 5 MiB）、
 *       FR-14.6（错误日志不得包含会话正文，只允许字段名、路径、行号）、13 章
 *
 * 隐私约束：本模块写出的日志只接受结构化字段（字符串/数字/布尔/字符串数组），
 * 调用方不得把消息正文、提示词或工具输出传入。
 */

import fs from "node:fs";
import path from "node:path";
import { redactHome } from "./paths.ts";
import type { Logger, LogLevel, MetaInfo } from "./types.ts";

export interface HealthReport {
  status: "ok" | "readonly";
  schemaVersion: number;
  revision: number;
  startedAt: string;
  pid: number;
  scanning: boolean;
  progress: number;
  files: number;
  records: number;
  dedupeSkipped: number;
  corruptLines: number;
  invalidSessions: number;
  inconsistencyCount: number;
  corruptDuplicateIds: number;
  corruptCost: number;
  corruptUsage: number;
  skippedFiles: number;
  ledgerRepaired: number;
  configWarnings: string[];
  unknownKeys: string[];
  tz: string;
  tzChanged: boolean;
  lastScanMs: number;
  lastScanAt: string | null;
  indexSizeBytes: number;
  dataDir: string;
  logPath: string | null;
  lockTimeout: boolean;
  dedupeDisabled: boolean;
}

export interface HealthInput {
  meta: MetaInfo;
  indexSizeBytes: number;
  dataDir: string;
  logPath: string | null;
  readOnly: boolean;
  lockTimeout: boolean;
  dedupeDisabled: boolean;
}

/** FR-12.7：健康面板字段。数据目录已脱敏（FR-14.3 同类要求）。 */
export function buildHealthReport(input: HealthInput): HealthReport {
  const { meta } = input;
  return {
    status: input.readOnly ? "readonly" : "ok",
    schemaVersion: meta.schemaVersion,
    revision: meta.revision,
    startedAt: meta.startedAt,
    pid: meta.pid,
    scanning: meta.scanning,
    progress: meta.progress,
    files: meta.files,
    records: meta.records,
    dedupeSkipped: meta.dedupeSkipped,
    corruptLines: meta.corruptLines,
    invalidSessions: meta.invalidSessions,
    inconsistencyCount: meta.inconsistencyCount,
    corruptDuplicateIds: meta.corruptDuplicateIds,
    corruptCost: meta.corruptCost,
    corruptUsage: meta.corruptUsage,
    skippedFiles: meta.skippedFiles,
    ledgerRepaired: meta.ledgerRepaired,
    configWarnings: meta.configWarnings,
    unknownKeys: meta.unknownKeys,
    tz: meta.tz,
    tzChanged: meta.tzChanged,
    lastScanMs: meta.lastScanMs,
    lastScanAt: meta.lastScanAt,
    indexSizeBytes: input.indexSizeBytes,
    dataDir: redactHome(input.dataDir),
    logPath: input.logPath === null ? null : redactHome(input.logPath),
    lockTimeout: input.lockTimeout,
    dedupeDisabled: input.dedupeDisabled,
  };
}

/** 索引占用字节数（账本 + 游标 + meta）。 */
export function measureIndexSize(files: readonly string[]): number {
  let total = 0;
  for (const file of files) {
    try {
      total += fs.statSync(file).size;
    } catch {
      /* 文件不存在视为 0 */
    }
  }
  return total;
}

export interface LoggerOptions {
  logsDir: string;
  level: LogLevel;
  maxFiles: number;
  maxBytes: number;
}

const LEVEL_ORDER: Record<LogLevel, number> = { off: 0, error: 1, info: 2, debug: 3 };

/**
 * NFR-6：可观测性 —— 可选日志（`<agentDir>/pi-monitor/logs/`，保留 `maxFiles` 份、单文件 ≤ `maxBytes`）。
 * 任何写入失败都不得影响主流程（NFR-5）。
 */
export function createLogger(options: LoggerOptions): Logger {
  const logPath = path.join(options.logsDir, "pi-monitor.log");

  const write = (level: Exclude<LogLevel, "off">, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[options.level] < LEVEL_ORDER[level]) return;
    try {
      fs.mkdirSync(options.logsDir, { recursive: true });
      rotateIfNeeded(logPath, options.maxBytes, options.maxFiles);
      const line = `${new Date().toISOString()} ${level.toUpperCase()} ${sanitize(message)}${fields === undefined ? "" : ` ${sanitizeFields(fields)}`}\n`;
      fs.appendFileSync(logPath, line, "utf8");
    } catch {
      // 日志失败不影响主流程。
    }
  };

  return {
    error: (message, fields) => write("error", message, fields),
    info: (message, fields) => write("info", message, fields),
    debug: (message, fields) => write("debug", message, fields),
  };
}

/** 空日志器（用于测试与 `logging.level: "off"`）。 */
export function createNullLogger(): Logger {
  return { error: () => {}, info: () => {}, debug: () => {} };
}

function rotateIfNeeded(logPath: string, maxBytes: number, maxFiles: number): void {
  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return;
  }
  if (size < maxBytes) return;
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const from = index === 1 ? logPath : `${logPath}.${index - 1}`;
    const to = `${logPath}.${index}`;
    try {
      fs.renameSync(from, to);
    } catch {
      /* 不存在则跳过 */
    }
  }
  try {
    fs.unlinkSync(`${logPath}.${maxFiles}`);
  } catch {
    /* 超出保留份数 */
  }
}

/** FR-14.6：日志中禁止出现会话正文；只保留短字段名与路径。 */
function sanitize(message: string): string {
  return message.replace(/\s+/g, " ").slice(0, 500);
}

function sanitizeFields(fields: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      out[key] = sanitize(value);
      continue;
    }
    if (Array.isArray(value)) {
      out[key] = value.filter((item) => typeof item === "string" || typeof item === "number").slice(0, 20);
    }
  }
  return JSON.stringify(out);
}
