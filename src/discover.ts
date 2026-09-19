/**
 * discover.ts — 会话文件发现（FR-1.1、FR-1.2）。
 * 需求：FR-1.1（多扫描根 + 去重）、FR-1.2（只处理 .jsonl，跳过符号链接目录 / *.tmp /
 *       *.part / 以 . 开头的文件）、13 章（无权限跳过并计数）、NFR-8、NFR-13
 */

import fs from "node:fs";
import path from "node:path";
import { pathKey } from "./paths.ts";

export interface DiscoveredFile {
  path: string;
  root: string;
}

export interface DiscoveryResult {
  files: DiscoveredFile[];
  /** 13 章：不存在的根 / 无权限目录 / 读取失败的条目。 */
  skippedFiles: number;
  /** 不存在的扫描根（健康面板可见）。 */
  missingRoots: string[];
  errors: string[];
}

function isCandidateFile(name: string): boolean {
  if (name.startsWith(".")) return false;
  if (name.endsWith(".tmp") || name.endsWith(".part")) return false;
  return name.endsWith(".jsonl");
}

/**
 * 递归发现 `.jsonl` 会话文件。
 * - 符号链接目录一律跳过（FR-1.2），避免循环与越界。
 * - 结果按路径字典序排序，保证扫描顺序可复现（D-2 的裁决顺序依赖此点）。
 */
export async function discoverSessionFiles(roots: readonly string[]): Promise<DiscoveryResult> {
  const files: DiscoveredFile[] = [];
  const seen = new Set<string>();
  const missingRoots: string[] = [];
  const errors: string[] = [];
  let skippedFiles = 0;

  for (const root of roots) {
    let rootStat: fs.Stats;
    try {
      rootStat = await fs.promises.lstat(root);
    } catch {
      missingRoots.push(root);
      continue;
    }
    if (!rootStat.isDirectory()) {
      missingRoots.push(root);
      continue;
    }
    await walk(root, root);
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skippedFiles, missingRoots, errors };

  async function walk(dir: string, root: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      skippedFiles += 1;
      errors.push(`readdir ${dir}: ${(error as Error).message}`);
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.name.startsWith(".")) continue;

      if (entry.isSymbolicLink()) {
        // FR-1.2：跳过符号链接（目录与文件）——避免循环与重复。
        skippedFiles += 1;
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full, root);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isCandidateFile(entry.name)) continue;

      const key = pathKey(full);
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ path: full, root });
    }
  }
}
