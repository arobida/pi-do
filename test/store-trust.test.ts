import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("--global is refused for untrusted projects without writing into them", async () => {
 const previousHome = process.env.PI_DO_HOME;
 const home = mkdtempSync(join(tmpdir(), "pi-do-home-"));
 const cwd = mkdtempSync(join(tmpdir(), "pi-do-cwd-"));
 process.env.PI_DO_HOME = home;
 try {
  const { settings } = await import("../src/store.ts");
  const ctx = { cwd, hasUI: false, isProjectTrusted: () => false, ui: { notify() {} }, sessionManager: { getSessionId: () => "s" } };
  expect(() => settings(ctx as any, true)).toThrow("requires a trusted project");
  expect(existsSync(join(cwd, ".pi-do"))).toBe(false);
 } finally {
  if (previousHome === undefined) delete process.env.PI_DO_HOME;
  else process.env.PI_DO_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
 }
});
