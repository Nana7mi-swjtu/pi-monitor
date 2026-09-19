/**
 * config.ts — 配置读取 / 校验 / 原子写回。
 * 需求：FR-11（含 AC-11.1~AC-11.5）、第 12 章配置项清单、FR-13.1、¥3、NFR-8
 *
 * 规则要点：
 *  - FR-11.2：缺失时使用默认值，**不自动创建**文件。
 *  - FR-11.4：未知键保留（不删除）；类型非法回退默认并计入 configWarnings。
 *  - FR-11.5：写入必须原子（临时文件 + rename）。
 *  - FR-11.6：仪表盘只能写白名单键。
 */

import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_SCHEMA_VERSION,
  type DedupeMode,
  type LocaleSetting,
  type LogLevel,
  type PiMonitorConfig,
  type ThemeMode,
  type WeekStart,
} from "./types.ts";

export interface LoadedConfig {
  config: PiMonitorConfig;
  /** FR-11.4 / 7.4：非法值产生的告警。 */
  warnings: string[];
  /** FR-11.4 / 7.4：已保留的未知键路径。 */
  unknownKeys: string[];
  /** 原始 JSON（保留未知键，FR-11.4 / AC-11.4）。 */
  raw: Record<string, unknown>;
  /** 配置文件是否存在。 */
  exists: boolean;
}

/** ¥3：汇率默认值 7.20，范围 0.01..100.00。 */
export const DEFAULT_RATE = 7.2;
export const DEFAULT_PORT = 30142;
export const DEFAULT_PORT_RANGE = 18;

/** 第 12 章默认配置。 */
export function defaultConfig(): PiMonitorConfig {
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    locale: "auto",
    timezone: "local",
    weekStart: "monday",
    extraSessionDirs: [],
    dedupe: "fingerprint",
    ephemeralCapture: true,
    defaultWindow: "last7d",
    tableLimit: 20,
    tool: { enabled: true },
    currency: { code: "CNY", rate: DEFAULT_RATE },
    dashboard: {
      enabled: true,
      port: DEFAULT_PORT,
      portRange: DEFAULT_PORT_RANGE,
      allowLan: false,
      stopOnExit: true,
      linkMessage: true,
      theme: "auto",
    },
    budget: {
      enabled: false,
      dailyCNY: null,
      monthlyCNY: null,
      warnAt: [0.5, 0.8, 1.0],
      includeEstimated: false,
      injectMessage: false,
    },
    logging: { level: "error", maxFiles: 7, maxBytes: 5_242_880 },
  };
}

/** FR-11.6：仪表盘可写字段白名单（其余键返回 403，AC-11.5）。 */
export const WRITABLE_CONFIG_PATHS: readonly string[] = [
  "currency.rate",
  "dashboard.theme",
  "dashboard.allowLan",
  "locale",
  "budget.enabled",
  "budget.dailyCNY",
  "budget.monthlyCNY",
  "budget.warnAt",
  "budget.includeEstimated",
  "budget.injectMessage",
];

type TypeKind = "string" | "number" | "boolean" | "array" | "object" | "nullable-number";

interface LeafRule {
  kind: TypeKind;
  test?: (value: unknown) => boolean;
  describe: string;
}

/** 已知键的形状表（用于校验 + 未知键检测）。 */
const SHAPE: Record<string, LeafRule | Record<string, unknown>> = {
  schemaVersion: { kind: "number", test: isPositiveInt, describe: "正整数" },
  locale: { kind: "string", test: (v: unknown) => v === "zh-CN" || v === "en-US" || v === "auto", describe: "zh-CN | en-US | auto" },
  timezone: { kind: "string", test: (v: unknown) => typeof v === "string" && v.length > 0, describe: "local | utc | IANA" },
  weekStart: { kind: "string", test: (v: unknown) => v === "monday" || v === "sunday", describe: "monday | sunday" },
  extraSessionDirs: { kind: "array", test: (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string"), describe: "string[]" },
  dedupe: { kind: "string", test: (v: unknown) => v === "fingerprint" || v === "off", describe: "fingerprint | off" },
  ephemeralCapture: { kind: "boolean", describe: "boolean" },
  defaultWindow: { kind: "string", test: (v: unknown) => typeof v === "string" || typeof v === "number", describe: "string | number" },
  tableLimit: { kind: "number", test: (v: unknown) => isPositiveInt(v) && (v as number) >= 1 && (v as number) <= 200, describe: "1..200" },
  tool: {
    enabled: { kind: "boolean", describe: "boolean" },
  },
  currency: {
    code: { kind: "string", test: (v: unknown) => v === "CNY", describe: "CNY" },
    rate: { kind: "number", test: isRate, describe: "0.01..100.00" },
  },
  dashboard: {
    enabled: { kind: "boolean", describe: "boolean" },
    port: { kind: "number", test: (v: unknown) => isPositiveInt(v) && (v as number) >= 1024 && (v as number) <= 65535, describe: "1024..65535" },
    portRange: { kind: "number", test: (v: unknown) => isPositiveInt(v) && (v as number) >= 0 && (v as number) <= 1000, describe: "0..1000" },
    allowLan: { kind: "boolean", describe: "boolean" },
    stopOnExit: { kind: "boolean", describe: "boolean" },
    linkMessage: { kind: "boolean", describe: "boolean" },
    theme: { kind: "string", test: (v: unknown) => v === "auto" || v === "light" || v === "dark", describe: "auto | light | dark" },
  },
  budget: {
    enabled: { kind: "boolean", describe: "boolean" },
    dailyCNY: { kind: "nullable-number", test: (v: unknown) => v === null || isNonNegativeNumber(v), describe: "number | null" },
    monthlyCNY: { kind: "nullable-number", test: (v: unknown) => v === null || isNonNegativeNumber(v), describe: "number | null" },
    warnAt: { kind: "array", test: (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "number" && x > 0 && x <= 1), describe: "number[] 且 0 < w ≤ 1" },
    includeEstimated: { kind: "boolean", describe: "boolean" },
    injectMessage: { kind: "boolean", describe: "boolean" },
  },
  logging: {
    level: { kind: "string", test: (v: unknown) => v === "off" || v === "error" || v === "info" || v === "debug", describe: "off | error | info | debug" },
    maxFiles: { kind: "number", test: (v: unknown) => isPositiveInt(v) && (v as number) >= 1, describe: "正整数" },
    maxBytes: { kind: "number", test: (v: unknown) => isPositiveInt(v) && (v as number) >= 1024, describe: "正整数" },
  },
};

function isPositiveInt(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** ¥3：汇率可配置范围 0.01..100.00，保留 2 位小数，存储为数值。 */
export function isRate(value: unknown): boolean {
  return isNonNegativeNumber(value) && (value as number) >= 0.01 && (value as number) <= 100;
}

/** ¥3：汇率统一保留 2 位小数（数值存储）。 */
export function normalizeRate(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 读取并校验配置。FR-11.2：文件不存在时返回默认值，不创建文件。 */
export function loadConfig(configPath: string): LoadedConfig {
  const warnings: string[] = [];
  const defaults = defaultConfig();
  let raw: Record<string, unknown> = {};
  let exists = false;

  try {
    const text = fs.readFileSync(configPath, "utf8");
    exists = true;
    const parsed: unknown = JSON.parse(stripBom(text));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    } else {
      warnings.push("config: 根节点不是对象，已回退默认值");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`config: 读取失败（${(error as Error).message}），已回退默认值`);
    }
    exists = false;
  }

  const unknownKeys: string[] = [];
  const config = applyShape(
    defaults as unknown as Record<string, unknown>,
    raw,
    "",
    warnings,
    unknownKeys,
    SHAPE,
  ) as unknown as PiMonitorConfig;
  // 汇率再次规范化，保证范围与精度（¥3）。
  const rawCurrency = raw["currency"];
  if (rawCurrency && typeof rawCurrency === "object" && !Array.isArray(rawCurrency)) {
    const rate = (rawCurrency as Record<string, unknown>)["rate"];
    if (isRate(rate)) config.currency.rate = normalizeRate(rate as number);
  }
  // 预算阈值必须升序（第 12 章）。
  config.budget.warnAt = [...config.budget.warnAt].filter((w) => w > 0 && w <= 1).sort((a, b) => a - b);
  if (config.budget.warnAt.length === 0) config.budget.warnAt = [...defaults.budget.warnAt];

  return { config, warnings, unknownKeys, raw, exists };
}

/** 递归按形状表应用用户值：非法值回退默认 + warning；未知键记录但保留。 */
function applyShape(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  prefix: string,
  warnings: string[],
  unknownKeys: string[],
  shape: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(source)) {
    const rule = shape[key];
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;

    if (rule === undefined) {
      unknownKeys.push(path);
      target[key] = value;
      continue;
    }

    if (isLeafRule(rule)) {
      if (rule.kind === "nullable-number") {
        // `budget.dailyCNY` / `budget.monthlyCNY`：允许 null 或非负数值。
        if (value === null) {
          target[key] = null;
          continue;
        }
        if (typeof value !== "number" || (rule.test !== undefined && !rule.test(value))) {
          warnings.push(`${path}: 值非法（期望 ${rule.describe}），已回退默认值`);
          continue;
        }
        target[key] = value;
        continue;
      }
      const expected = kindOf(value);
      if (expected !== rule.kind) {
        warnings.push(`${path}: 期望 ${rule.describe}，实际 ${expected}，已回退默认值`);
        continue;
      }
      if (rule.test && !rule.test(value)) {
        warnings.push(`${path}: 值非法（期望 ${rule.describe}），已回退默认值`);
        continue;
      }
      target[key] = value;
      continue;
    }

    const current = target[key];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      warnings.push(`${path}: 期望对象，实际 ${kindOf(value)}，已回退默认值`);
      continue;
    }
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      target[key] = structuredClone(value);
      continue;
    }
    target[key] = applyShape(
      current as Record<string, unknown>,
      value as Record<string, unknown>,
      path,
      warnings,
      unknownKeys,
      rule as Record<string, unknown>,
    );
  }
  return target;
}

function isLeafRule(value: unknown): value is LeafRule {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as LeafRule).kind === "string"
  );
}

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** FR-11.5：原子写回（临时文件 + rename），未知键保留（AC-11.4）。 */
export function writeConfig(configPath: string, raw: Record<string, unknown>): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.config.json.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, configPath);
}

export interface ConfigUpdateResult {
  ok: boolean;
  /** 非白名单键（AC-11.5：返回 403）。 */
  rejected: string[];
  config: PiMonitorConfig;
  warnings: string[];
  unknownKeys: string[];
}

/**
 * FR-11.6：只允许写白名单键。返回被拒绝的键；
 * 只要存在被拒绝的键就不落盘（AC-11.5）。
 */
export function updateConfigFile(
  configPath: string,
  patch: Record<string, unknown>,
  current: LoadedConfig,
): ConfigUpdateResult {
  const rejected: string[] = [];
  const flat = flatten(patch);
  for (const key of Object.keys(flat)) {
    if (!WRITABLE_CONFIG_PATHS.includes(key)) rejected.push(key);
  }
  if (rejected.length > 0) {
    return {
      ok: false,
      rejected,
      config: current.config,
      warnings: current.warnings,
      unknownKeys: current.unknownKeys,
    };
  }

  const merged = structuredClone(current.raw);
  for (const [key, value] of Object.entries(flat)) {
    setPath(merged, key, value);
  }

  const reloaded = loadConfigFromRaw(merged);
  writeConfig(configPath, merged);
  return {
    ok: true,
    rejected,
    config: reloaded.config,
    warnings: reloaded.warnings,
    unknownKeys: reloaded.unknownKeys,
  };
}

/** 从内存对象校验配置（不读盘）。 */
export function loadConfigFromRaw(raw: Record<string, unknown>): LoadedConfig {
  const warnings: string[] = [];
  const unknownKeys: string[] = [];
  const config = applyShape(
    defaultConfig() as unknown as Record<string, unknown>,
    raw,
    "",
    warnings,
    unknownKeys,
    SHAPE,
  ) as unknown as PiMonitorConfig;
  const rate = (raw["currency"] as Record<string, unknown> | undefined)?.["rate"];
  config.currency.rate = isRate(rate) ? normalizeRate(rate as number) : DEFAULT_RATE;
  config.budget.warnAt = [...config.budget.warnAt].filter((w) => w > 0 && w <= 1).sort((a, b) => a - b);
  if (config.budget.warnAt.length === 0) config.budget.warnAt = [0.5, 0.8, 1.0];
  return { config, warnings, unknownKeys, raw, exists: true };
}

/** 点号路径展平（只用于白名单校验与写入）。 */
export function flatten(input: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const path = prefix.length > 0 ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Record<string, unknown>, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

function setPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cursor: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i] as string;
    const next = cursor[part];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1] as string] = value;
}

/** 类型别名再导出，方便调用方只 import config.ts。 */
export type { DedupeMode, LocaleSetting, LogLevel, PiMonitorConfig, ThemeMode, WeekStart };
