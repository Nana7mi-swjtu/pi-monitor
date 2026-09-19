/**
 * opener.test.ts — FR-6.3（AC-6.3）、13 章（浏览器打不开的降级）。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { browserCommand, openBrowser, type ExecFn } from "../../src/opener.ts";

const URL = "http://127.0.0.1:30142/?t=abcdef";

test("FR-6.3：按平台选择打开命令", () => {
  assert.deepEqual(browserCommand(URL, "win32"), { command: "cmd", args: ["/c", "start", "", URL] });
  assert.deepEqual(browserCommand(URL, "darwin"), { command: "open", args: [URL] });
  assert.deepEqual(browserCommand(URL, "linux"), { command: "xdg-open", args: [URL] });
  assert.deepEqual(browserCommand(URL, "freebsd"), { command: "xdg-open", args: [URL] });
});

test("AC-6.3：openBrowser 成功时返回 true 并传入完整 URL", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const exec: ExecFn = async (command, args) => {
    calls.push({ command, args });
    return { code: 0, stdout: "", stderr: "" };
  };
  assert.equal(await openBrowser(URL, exec, "linux"), true);
  assert.deepEqual(calls, [{ command: "xdg-open", args: [URL] }]);
});

test("AC-6.3：命令不存在 / 非零退出 / 抛错一律返回 false，绝不抛出", async () => {
  const notFound: ExecFn = async () => {
    throw new Error("spawn xdg-open ENOENT");
  };
  assert.equal(await openBrowser(URL, notFound, "linux"), false);

  const nonZero: ExecFn = async () => ({ code: 3, stdout: "", stderr: "no display" });
  assert.equal(await openBrowser(URL, nonZero, "linux"), false);

  const noCode: ExecFn = async () => ({ stdout: "", stderr: "" });
  assert.equal(await openBrowser(URL, noCode, "win32"), true, "缺少 code 视为成功");
});
