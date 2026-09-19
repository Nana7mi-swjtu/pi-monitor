/**
 * args.ts — `/tokens` 参数解析与链接消息组装（纯函数，无 IO，无宿主依赖）。
 * 需求：FR-6.6（端口策略入参）、FR-6.8（AC-6.7 非法参数不抛异常）、FR-6.5（≤ 300 字符链接消息）
 *
 * 独立成模块的原因：`extensions/pi-monitor/index.ts` 会 import 宿主包（typebox / pi-ai），
 * 而 11 章的依赖方向要求 `src/**` 保持可被纯 Node 测试（NFR-1）。
 */

import type { Locale } from "./types.ts";

/** FR-6.5：链接消息上限 300 字符。 */
export const LINK_MESSAGE_LIMIT = 300;
/** FR-6.5：自定义消息类型。 */
export const LINK_MESSAGE_TYPE = "pi-monitor:link";

export interface TokensArgs {
  noOpen: boolean;
  port: number | null;
  /** 无法识别或非法的参数（原样回显给用户，不抛异常）。 */
  invalid: string[];
}

export const TOKENS_USAGE = "/tokens [--no-open] [--port <1024..65535>]";

/**
 * 解析 `/tokens` 参数。
 * AC-6.7：未知参数与非法端口只记录到 `invalid`，由调用方提示一行后继续执行默认行为。
 */
export function parseTokensArgs(raw: string): TokensArgs {
  const out: TokensArgs = { noOpen: false, port: null, invalid: [] };
  const tokens = raw.split(/\s+/).filter((token) => token.length > 0);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === "--no-open") {
      out.noOpen = true;
      continue;
    }
    if (token === "--port") {
      const value = tokens[index + 1];
      index += 1;
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) {
        out.invalid.push(`--port ${value ?? ""}`.trim());
        continue;
      }
      out.port = parsed;
      continue;
    }
    out.invalid.push(token);
  }
  return out;
}

/**
 * FR-6.5：链接消息只含标题、URL 与关闭方法，且 ≤ 300 字符。
 * 该消息会进入 LLM 上下文，因此严格限长（P-11）。
 */
export function buildLinkMessage(url: string, locale: Locale): string {
  const text =
    locale === "zh-CN"
      ? `pi-monitor 仪表盘已启动\n${url}\n关闭：服务随 pi 退出自动关闭；/tokens --no-open 只取 URL。`
      : `pi-monitor dashboard is running\n${url}\nClose: the server stops with pi; use /tokens --no-open for the URL only.`;
  return text.length > LINK_MESSAGE_LIMIT ? text.slice(0, LINK_MESSAGE_LIMIT) : text;
}
