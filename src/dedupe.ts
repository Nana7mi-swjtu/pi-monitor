/**
 * dedupe.ts — 指纹与去重（纯函数，无 IO）。
 * 需求：4.4（D-1~D-6）、FR-3、AC-3.1~AC-3.3、13 章（重复计数可审计，不静默）
 *
 * 事实依据：`SessionManager.forkFrom()` 会把源文件所有 entry **原样**复制到新文件
 * （保留 id / timestamp / usage），因此必须按指纹去重，否则 `/clone`、`pi --fork`
 * 与跨目录 `--session` 都会重复统计历史用量。
 */

import { createHash } from "node:crypto";
import type { DedupeMode, DedupeSkip } from "./types.ts";

export interface FingerprintParts {
  entryId: string;
  ts: number;
  provider: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * D-1：`fp = sha1(entryId | messageTimestamp | provider | model | input | output | cacheRead | cacheWrite)` 前 16 位十六进制。
 * D-4：指纹只覆盖用量字段，不覆盖消息正文。
 */
export function fingerprintOf(parts: FingerprintParts): string {
  const material = [
    parts.entryId,
    String(parts.ts),
    parts.provider ?? "",
    parts.model ?? "",
    String(parts.input),
    String(parts.output),
    String(parts.cacheRead),
    String(parts.cacheWrite),
  ].join("|");
  return createHash("sha1").update(material, "utf8").digest("hex").slice(0, 16);
}

export interface DedupeInput {
  fp: string;
  ts: number;
  entryId: string;
  sessionFile: string;
}

export interface DedupeResult<T extends DedupeInput> {
  records: T[];
  skipped: DedupeSkip[];
}

/**
 * D-2：`fp` 全量唯一，首见者胜（按 `ts` 升序，再按文件路径字典序）。
 * D-3：被跳过的重复记录全部返回，供健康面板展示（不静默）。
 * D-5：`dedupe: "off"` 时仅按原顺序返回，不做任何剔除（供诊断）。
 */
export function dedupeRecords<T extends DedupeInput>(records: readonly T[], mode: DedupeMode): DedupeResult<T> {
  if (mode === "off") {
    return { records: [...records], skipped: [] };
  }

  const ordered = [...records].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.sessionFile === b.sessionFile) return 0;
    return a.sessionFile < b.sessionFile ? -1 : 1;
  });

  const firstSeen = new Map<string, T>();
  const kept: T[] = [];
  const skipped: DedupeSkip[] = [];

  for (const record of ordered) {
    const existing = firstSeen.get(record.fp);
    if (existing === undefined) {
      firstSeen.set(record.fp, record);
      kept.push(record);
      continue;
    }
    skipped.push({
      fp: record.fp,
      entryId: record.entryId,
      ts: record.ts,
      keptFile: existing.sessionFile,
      skippedFile: record.sessionFile,
    });
  }

  return { records: kept, skipped };
}

/** 仅统计被跳过的数量（用于 meta.dedupeSkipped）。 */
export function countSkipped(skipped: readonly DedupeSkip[]): number {
  return skipped.length;
}
