/**
 * opener.ts — 跨平台打开浏览器。
 * 需求：FR-6.3（Windows `cmd /c start ""`、macOS `open`、Linux `xdg-open`，经 `pi.exec`）、
 *       AC-6.3（打开失败不得报错，改为提示 URL）、13 章（浏览器打不开降级）
 *
 * 本模块不直接 import 宿主包：由调用方（`extensions/pi-monitor/index.ts`）注入 `pi.exec`，
 * 从而保持 `src/**` 可被纯 Node 测试（11 章依赖方向）。
 */

export interface ExecResultLike {
  code?: number | null;
  stdout?: string;
  stderr?: string;
}

export type ExecFn = (command: string, args: string[], options?: { timeout?: number }) => Promise<ExecResultLike>;

export interface BrowserCommand {
  command: string;
  args: string[];
}

/** FR-6.3：按平台选择打开命令。 */
export function browserCommand(url: string, platform: NodeJS.Platform = process.platform): BrowserCommand {
  if (platform === "win32") {
    // `start` 是 cmd 内建命令；第一个空参数是 start 的窗口标题占位。
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

/**
 * FR-6.3 / AC-6.3：打开浏览器。任何失败都返回 false，永不抛出。
 * 调用方在失败时只需提示完整 URL。
 */
export async function openBrowser(url: string, exec: ExecFn, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const { command, args } = browserCommand(url, platform);
  try {
    const result = await exec(command, args, { timeout: 5000 });
    return result.code === 0 || result.code === undefined || result.code === null;
  } catch {
    return false;
  }
}
