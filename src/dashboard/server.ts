/**
 * dashboard/server.ts — HTTP 服务、鉴权、路由、生命周期。
 * 需求：FR-6（AC-6.1~AC-6.9）、FR-8、FR-14（FR-14.3/14.4 鉴权与掩码）、10.2（API 契约）、
 *       10.3（安全响应头 / 资产内联 / 鉴权）、AC-8.6（ETag 304）
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { dictionaries } from "../i18n.ts";
import type { DashboardRuntimeInfo, Locale } from "../types.ts";
import {
  applyConfigUpdate,
  buildBreakdown,
  buildConfigResponse,
  buildDaily,
  buildDedupeResponse,
  buildExport,
  buildHealthResponse,
  buildRecords,
  buildSummary,
  type MonitorContext,
  type QueryOptions,
} from "./api.ts";
import { renderDashboardHtml } from "./assets.ts";

export interface DashboardServerOptions {
  token?: string;
  port: number;
  portRange: number;
  allowLan: boolean;
  locale: Locale;
  context: () => MonitorContext;
}

/** 10.3：安全响应头。 */
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
  "connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'";

const MAX_BODY_BYTES = 1_048_576;

/** FR-14.3：32 位十六进制 token。 */
export function createToken(): string {
  return randomBytes(16).toString("hex");
}

/** FR-14.3：恒定时间比较。 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...extraHeaders,
  });
  res.end(body);
}

export class DashboardServer {
  private readonly options: DashboardServerOptions;
  private server: http.Server | null = null;
  private runtime: DashboardRuntimeInfo | null = null;
  private readonly token: string;

  constructor(options: DashboardServerOptions) {
    this.options = options;
    this.token = options.token ?? createToken();
  }

  get running(): boolean {
    return this.server !== null && this.server.listening;
  }

  get info(): DashboardRuntimeInfo | null {
    return this.runtime;
  }

  /** FR-14.3：健康面板只允许展示 token 前 4 位掩码。 */
  get tokenMask(): string {
    return `${this.token.slice(0, 4)}${"*".repeat(Math.max(0, this.token.length - 4))}`;
  }

  get url(): string | null {
    return this.runtime?.url ?? null;
  }

  /**
   * FR-6.4：`dashboard.port` → 顺序试到 `dashboard.port + dashboard.portRange` →
   * 回退系统分配的空闲端口（端口 0）。
   */
  async start(): Promise<DashboardRuntimeInfo> {
    if (this.server !== null) return this.runtime as DashboardRuntimeInfo;

    const host = this.options.allowLan ? "0.0.0.0" : "127.0.0.1";
    const candidates: number[] = [];
    for (let offset = 0; offset <= Math.max(0, this.options.portRange); offset += 1) {
      candidates.push(this.options.port + offset);
    }
    candidates.push(0);

    let lastError: Error | null = null;
    for (const candidate of candidates) {
      const server = http.createServer((req, res) => this.handle(req, res));
      try {
        const port = await new Promise<number>((resolve, reject) => {
          server.once("error", (error: Error) => reject(error));
          server.listen({ host, port: candidate }, () => {
            const address = server.address() as AddressInfo | null;
            resolve(address === null ? candidate : address.port);
          });
        });
        this.server = server;
        this.runtime = {
          url: `http://127.0.0.1:${port}/?t=${this.token}`,
          port,
          startedAt: new Date().toISOString(),
          pid: process.pid,
          token: this.token,
          allowLan: this.options.allowLan,
        };
        return this.runtime;
      } catch (error) {
        lastError = error as Error;
        server.close();
        if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") break;
      }
    }
    throw lastError ?? new Error("无法绑定任何端口");
  }

  /** FR-6.10：`session_shutdown` 时按 `dashboard.stopOnExit` 关闭服务。 */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.runtime = null;
    if (server === null) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // 强制关闭 keep-alive 连接，避免 shutdown 挂住。
      server.closeAllConnections?.();
      setTimeout(resolve, 1500);
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    try {
      this.route(req, res);
    } catch (error) {
      // NFR-5 / 9.2：永不展示堆栈；给出一句话原因。
      req.resume();
      sendJson(res, 500, { error: (error as Error).message ?? "internal error" });
    }
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname !== "/" && !pathname.startsWith("/api/")) {
      req.resume();
      sendJson(res, 404, { error: "not found" });
      return;
    }

    // FR-14.4 / 10.3：token 鉴权（`?t=` 或 `X-Pi-Monitor-Token`），失败一律 401。
    if (!this.authorized(req, url)) {
      req.resume();
      res.writeHead(401, {
        "Content-Type": "application/json; charset=utf-8",
        "WWW-Authenticate": "Pi-Monitor-Token",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end('{"error":"unauthorized"}\n');
      return;
    }

    if (pathname === "/") {
      if (method !== "GET" && method !== "HEAD") {
        req.resume();
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      this.serveHtml(req, res);
      return;
    }

    const query = queryOptions(url.searchParams);

    switch (pathname) {
      case "/api/health":
        sendJson(res, 200, buildHealthResponse(this.options.context()));
        return;
      case "/api/config":
        if (method === "GET") {
          sendJson(res, 200, buildConfigResponse(this.options.context()));
          return;
        }
        if (method === "PUT") {
          this.handleConfigPut(req, res);
          return;
        }
        req.resume();
        sendJson(res, 405, { error: "method not allowed" });
        return;
      case "/api/summary":
        this.sendCached(res, req, query, () => buildSummary(this.options.context(), query));
        return;
      case "/api/daily":
        this.sendCached(res, req, query, () => buildDaily(this.options.context(), query));
        return;
      case "/api/breakdown":
        this.sendCached(res, req, query, () => buildBreakdown(this.options.context(), query));
        return;
      case "/api/records":
        this.sendCached(res, req, query, () => buildRecords(this.options.context(), query));
        return;
      case "/api/export":
        this.sendCached(res, req, query, () => buildExport(this.options.context(), query));
        return;
      case "/api/dedupe":
        this.sendCached(res, req, query, () => buildDedupeResponse(this.options.context()));
        return;
      case "/api/rescan":
        if (method !== "POST") {
          req.resume();
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        req.resume();
        this.handleRescan(res);
        return;
      case "/api/rebuild":
        if (method !== "POST") {
          req.resume();
          sendJson(res, 405, { error: "method not allowed" });
          return;
        }
        this.handleRebuild(req, res);
        return;
      default:
        req.resume();
        sendJson(res, 404, { error: "not found" });
    }
  }

  private authorized(req: http.IncomingMessage, url: URL): boolean {
    const headerToken = req.headers["x-pi-monitor-token"];
    const fromHeader = Array.isArray(headerToken) ? headerToken[0] : headerToken;
    if (typeof fromHeader === "string" && safeEqual(fromHeader, this.token)) return true;
    const queryToken = url.searchParams.get("t");
    if (queryToken !== null && safeEqual(queryToken, this.token)) return true;
    return false;
  }

  private serveHtml(req: http.IncomingMessage, res: http.ServerResponse): void {
    const context = this.options.context();
    const config = buildConfigResponse(context);
    // AC-6.1 / FR-14.5：页面不含任何外部请求目标。
    const html = renderDashboardHtml({
      locale: this.options.locale,
      i18n: dictionaries,
      token: this.token,
      config: {
        defaultWindow: config.defaultWindow,
        theme: config.theme,
        locale: config.locale,
        tableLimit: config.tableLimit,
        currency: config.currency,
      },
    });
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : html);
  }

  /** AC-8.6：`ETag`/`If-None-Match` 命中返回 304。 */
  private sendCached(
    res: http.ServerResponse,
    req: http.IncomingMessage,
    query: QueryOptions,
    build: () => unknown,
  ): void {
    const context = this.options.context();
    const payload = build();
    const revision = context.engine.meta.revision;
    const etag = `"${etagFor(revision, context.engine.config.currency.rate, query)}"`;
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && inm.split(",").some((value) => value.trim() === etag)) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "no-cache" });
      res.end();
      return;
    }
    sendJson(res, 200, payload, { ETag: etag, "Cache-Control": "no-cache" });
  }

  private handleConfigPut(req: http.IncomingMessage, res: http.ServerResponse): void {
    readBody(req)
      .then((body) => {
        let patch: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(body.length === 0 ? "{}" : body);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            sendJson(res, 400, { ok: false, error: "body must be a JSON object" });
            return;
          }
          patch = parsed as Record<string, unknown>;
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const outcome = applyConfigUpdate(this.options.context(), patch);
        if (!outcome.ok) {
          // AC-11.5：写非白名单键返回 403。
          sendJson(res, 403, { ok: false, rejected: outcome.rejected, error: "key not writable" });
          return;
        }
        sendJson(res, 200, { ok: true, warnings: outcome.warnings, unknownKeys: outcome.unknownKeys });
      })
      .catch(() => {
        sendJson(res, 400, { ok: false, error: "cannot read body" });
      });
  }

  private handleRescan(res: http.ServerResponse): void {
    const context = this.options.context();
    context.engine
      .rescan()
      .then((summary) => {
        sendJson(res, 200, {
          revision: summary.revision,
          scanned: summary.scanned,
          durationMs: summary.durationMs,
          readOnly: summary.readOnly,
        });
      })
      .catch((error: Error) => sendJson(res, 500, { error: error.message }));
  }

  /** FR-12.4 / AC-12.4：必须携带 `confirm: "REBUILD"`，否则 400 且不修改任何文件。 */
  private handleRebuild(req: http.IncomingMessage, res: http.ServerResponse): void {
    readBody(req)
      .then((body) => {
        let confirm: unknown;
        try {
          const parsed: unknown = JSON.parse(body.length === 0 ? "{}" : body);
          confirm =
            parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)["confirm"]
              : undefined;
        } catch {
          confirm = undefined;
        }
        if (confirm !== "REBUILD") {
          sendJson(res, 400, { error: 'confirm must be "REBUILD"' });
          return;
        }
        const context = this.options.context();
        if (context.readOnly || context.engine.readOnly) {
          sendJson(res, 409, { error: "index is read-only" });
          return;
        }
        context.engine
          .rebuild()
          .then((summary) => {
            sendJson(res, 200, {
              revision: summary.revision,
              records: summary.records,
              files: summary.files,
              durationMs: summary.durationMs,
            });
          })
          .catch((error: Error) => sendJson(res, 500, { error: error.message }));
      })
      .catch(() => sendJson(res, 400, { error: "cannot read body" }));
  }
}

function etagFor(revision: number, rate: number, query: QueryOptions): string {
  // 汇率变更必须绕开 304（¥5：汇率变更立即生效），因此纳入 ETag 组成。
  const material = `${revision}|${rate}|${JSON.stringify(query)}`;
  return createHash("sha1").update(material).digest("hex").slice(0, 16);
}

function queryOptions(search: URLSearchParams): QueryOptions {
  const out: QueryOptions = {};
  const keys: Array<keyof QueryOptions> = [
    "window",
    "tz",
    "from",
    "to",
    "project",
    "provider",
    "model",
    "source",
    "sessionId",
    "metric",
    "dim",
    "limit",
    "cursor",
  ];
  for (const key of keys) {
    const value = search.get(key);
    if (value !== null && value.length > 0) out[key] = value;
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
