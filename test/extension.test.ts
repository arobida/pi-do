import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-tui", () => ({ truncateToWidth: (text: string) => text }));
mock.module("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => process.env.PI_CODING_AGENT_DIR || `${process.env.HOME}/.pi/agent` }));
const { default: extension } = await import("../src/index.ts");

test("registers the existing tool, command, shortcuts, and lifecycle hooks", () => {
 const tools: any[] = [], commands: string[] = [], shortcuts: string[] = [], events: string[] = [];
 extension({
  registerTool: (tool: any) => tools.push(tool),
  registerCommand: (name: string) => commands.push(name),
  registerShortcut: (key: string) => shortcuts.push(key),
  on: (event: string) => events.push(event),
 } as any);
 expect(tools.map(t => t.name)).toEqual(["todo_task"]);
 expect(commands).toEqual(["todos"]);
 expect(shortcuts).toEqual(["ctrl+shift+t", "ctrl+shift+v"]);
 expect(events).toEqual(["session_shutdown", "session_start", "session_switch", "before_agent_start", "tool_result"]);
});

test("shows the above-editor task panel even when there are no tasks", async () => {
 let start: any, widget: any, placement: any;
 extension({ registerTool() {}, registerCommand() {}, registerShortcut() {}, on: (event: string, handler: any) => { if (event === "session_start") start = handler; } } as any);
 const ctx = { cwd: process.cwd(), hasUI: true, isProjectTrusted: () => false, ui: { setWidget: (_key: string, factory: any, options: any) => { widget = factory; placement = options.placement; }, notify() {} }, sessionManager: { getSessionId: () => `empty-${crypto.randomUUID()}`, getEntries: () => [] } };
 await start({}, ctx);
 const theme = { fg: (_color: string, text: string) => text, strikethrough: (text: string) => text };
 expect(placement).toBe("aboveEditor");
 expect(widget({ requestRender() {} }, theme).render(80).join("\n")).toContain("No tasks worked on in this session yet");
});

test("manifest exposes the source and host packages remain peers", async () => {
 const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
 expect(pkg.pi.extensions).toEqual(["./src/index.ts"]);
 expect(pkg.keywords).toContain("pi-package");
 expect(pkg.dependencies).toBeUndefined();
 expect(await Bun.file(new URL("../src/index.ts", import.meta.url)).exists()).toBe(true);
});


test("file backend persists task operations without Dex", async () => {
 const { mkdtempSync, rmSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = mkdtempSync(join(tmpdir(), "pi-do-test-"));
 const previous = { file: process.env.PI_DO_FILE, backend: process.env.PI_DO_BACKEND };
 process.env.PI_DO_FILE = join(dir, "tasks.jsonl"); delete process.env.PI_DO_BACKEND;
 try {
  let tool: any, command: any;
  extension({ registerTool: (t: any) => tool = t, registerCommand: (_name: string, c: any) => command = c, registerShortcut() {}, on() {}, appendEntry() {}, exec() { throw new Error("Dex must not run"); } } as any);
  const notifications: string[] = [];
  const ctx = { cwd: dir, hasUI: false, isProjectTrusted: () => true, ui: { notify: (message: string) => notifications.push(message) }, sessionManager: { getSessionId: () => "session" } };
  const run = async (params: any) => (await tool.execute("call", params, undefined, undefined, ctx)).content[0].text;
  const { readFileSync, writeFileSync } = await import("node:fs");
  writeFileSync(process.env.PI_DO_FILE!, ["(A) 2024-01-01 Call Mom +Family @phone", "Other task"].map(todo => JSON.stringify({ todo })).join("\n") + "\n");
  const imported = JSON.parse(await run({ action: "list" }));
  expect(imported[0].name).toBe("(A) 2024-01-01 Call Mom +Family @phone");
  await run({ action: "complete", id: imported[0].id });
  const records = readFileSync(process.env.PI_DO_FILE!, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  expect(records[0].todo).toMatch(/^x \d{4}-\d{2}-\d{2} 2024-01-01 Call Mom \+Family @phone pri:A /);
  expect(records[1]).toEqual({ todo: "Other task" });
  const id = (await run({ action: "create", name: "one", description: "details" })).split(" ").pop();
  await run({ action: "start", id });
  await run({ action: "edit", id, name: "updated" });
  await run({ action: "complete", id, result: "done" });
  const tasks = JSON.parse(await run({ action: "list" }));
  expect(tasks).toHaveLength(3);
  expect(tasks[2]).toMatchObject({ id, name: "updated", description: "details", completed: true, result: "done" });
  expect(tasks[2].started_at).toBeTruthy();
  expect(readFileSync(process.env.PI_DO_FILE!, "utf8")).toContain("updated piid:");
  await command.handler("export todo.txt", ctx);
  const exported = readFileSync(join(dir, "todo.txt"), "utf8");
  expect(exported).toBe(readFileSync(process.env.PI_DO_FILE!, "utf8").trimEnd().split("\n").map(line => JSON.parse(line).todo).join("\n") + "\n");
  await command.handler("export todo.txt", ctx);
  expect(notifications.at(-1)).toContain("EEXIST");
  expect(readFileSync(join(dir, "todo.txt"), "utf8")).toBe(exported);
  await expect(run({ action: "start", id: "missing" })).rejects.toThrow("Task not found");
  writeFileSync(process.env.PI_DO_FILE!, "old todo.txt line\n");
  await expect(run({ action: "create", name: "new" })).rejects.toThrow("Invalid pi-do JSONL record");
  expect(readFileSync(process.env.PI_DO_FILE!, "utf8")).toBe("old todo.txt line\n");
 } finally {
  if (previous.file === undefined) delete process.env.PI_DO_FILE; else process.env.PI_DO_FILE = previous.file;
  if (previous.backend === undefined) delete process.env.PI_DO_BACKEND; else process.env.PI_DO_BACKEND = previous.backend;
  rmSync(dir, { recursive: true, force: true });
 }
});

test.skipIf(!Bun.which("dex"))("Dex backend translates tasks and exports todo.txt", async () => {
 const previous = process.env.PI_DO_BACKEND; process.env.PI_DO_BACKEND = "dex";
 try {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pi-do-dex-test-"));
  try {
   let tool: any, command: any;
   extension({ registerTool: (t: any) => tool = t, registerCommand: (_name: string, c: any) => command = c, registerShortcut() {}, on() {}, appendEntry() {}, exec: async (_cmd: string, args: string[]) => {
    const action = args.findIndex((arg: string) => ["list", "create", "start", "edit", "complete"].includes(arg));
    const proc = Bun.spawn(["dex", "--storage-path", join(dir, "store"), ...args.slice(action)], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, code };
   } } as any);
   const ctx = { cwd: dir, hasUI: false, isProjectTrusted: () => true, ui: { notify() {} }, sessionManager: { getSessionId: () => "session" } };
   const run = async (params: any) => (await tool.execute("call", params, undefined, undefined, ctx)).content[0].text;
   const id = (await run({ action: "create", name: "(A) Call +Family @phone", description: "details" })).match(/Created task (\S+)/)[1];
   await run({ action: "start", id });
   await run({ action: "edit", id, name: "(A) Updated +Family @phone" });
   let tasks = JSON.parse(await run({ action: "list" }));
   expect(tasks[0]).toMatchObject({ id, name: "(A) Updated +Family @phone", description: "details", completed: false });
   expect(tasks[0].started_at).toBeTruthy();
   await run({ action: "complete", id, result: "done" });
   tasks = JSON.parse(await run({ action: "list" }));
   expect(tasks[0]).toMatchObject({ id, completed: true, result: "done" });
   await command.handler("export todo.txt", ctx);
   expect(readFileSync(join(dir, "todo.txt"), "utf8")).toMatch(/^x \d{4}-\d{2}-\d{2} Updated \+Family @phone pri:A piid:/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
 } finally { if (previous === undefined) delete process.env.PI_DO_BACKEND; else process.env.PI_DO_BACKEND = previous; }
});


test("user and trusted project settings merge with environment overrides", async () => {
 const { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = mkdtempSync(join(tmpdir(), "pi-do-settings-"));
 const env = { agent: process.env.PI_CODING_AGENT_DIR, backend: process.env.PI_DO_BACKEND, file: process.env.PI_DO_FILE };
 process.env.PI_CODING_AGENT_DIR = join(dir, "agent"); delete process.env.PI_DO_BACKEND; delete process.env.PI_DO_FILE;
 try {
  mkdirSync(join(dir, "agent")); mkdirSync(join(dir, ".pi"));
  writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ piDo: { backend: "file", file: "user.jsonl" } }));
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ piDo: { file: "project.jsonl" } }));
  let tool: any; let trusted = true; let dexCalls = 0;
  extension({ registerTool: (t: any) => tool = t, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {}, exec: async () => { dexCalls++; return { code: 0, stdout: "[]", stderr: "" }; } } as any);
  const ctx = { cwd: dir, hasUI: false, isProjectTrusted: () => trusted, sessionManager: { getSessionId: () => "session" } };
  const create = () => tool.execute("call", { action: "create", name: "task" }, undefined, undefined, ctx);
  await create(); expect(existsSync(join(dir, "project.jsonl"))).toBe(true);
  trusted = false; await create(); expect(existsSync(join(dir, "user.jsonl"))).toBe(true);
  trusted = true; process.env.PI_DO_FILE = "env.jsonl"; await create(); expect(existsSync(join(dir, "env.jsonl"))).toBe(true);
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ piDo: { backend: "dex" } }));
  await tool.execute("call", { action: "list" }, undefined, undefined, ctx); expect(dexCalls).toBeGreaterThan(0);
  process.env.PI_DO_BACKEND = "file"; const calls = dexCalls;
  await tool.execute("call", { action: "list" }, undefined, undefined, ctx); expect(dexCalls).toBe(calls);
  writeFileSync(join(dir, ".pi", "settings.json"), JSON.stringify({ piDo: { backend: "invalid" } }));
  await expect(create()).rejects.toThrow("Invalid piDo.backend");
 } finally {
  for (const [key, value] of Object.entries({ PI_CODING_AGENT_DIR: env.agent, PI_DO_BACKEND: env.backend, PI_DO_FILE: env.file })) {
   if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
 }
});

test("audit regressions: names, options, dates, refresh, export ~", async () => {
 const { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } = await import("node:fs");
 const { tmpdir, homedir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = mkdtempSync(join(tmpdir(), "pi-do-audit-"));
 const previous = { file: process.env.PI_DO_FILE, backend: process.env.PI_DO_BACKEND };
 process.env.PI_DO_FILE = join(dir, "tasks.jsonl"); delete process.env.PI_DO_BACKEND;
 try {
  let tool: any;
  extension({ registerTool: (t: any) => tool = t, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} } as any);
  let failWidget = false;
  const ctx = { cwd: dir, hasUI: true, isProjectTrusted: () => true, ui: { notify() {}, setWidget() { if (failWidget) throw new Error("boom"); } }, sessionManager: { getSessionId: () => "s" } };
  const run = async (params: any) => (await tool.execute("call", params, undefined, undefined, ctx)).content[0].text;
  for (const name of ["review piid:foo now", "x investigate bug", "--help", "-v", "a pistart:1"]) await expect(run({ action: "create", name })).rejects.toThrow("Task name must");
  const id = (await run({ action: "create", name: "description", description: "--name" })).split(" ").pop();
  expect(JSON.parse(await run({ action: "list" }))[0]).toMatchObject({ name: "description", description: "--name" });
  await run({ action: "complete", id });
  const old = readFileSync(process.env.PI_DO_FILE!, "utf8").replace(/x \d{4}-\d{2}-\d{2}/, "x 2020-01-01");
  writeFileSync(process.env.PI_DO_FILE!, JSON.stringify({ todo: JSON.parse(old).todo }) + "\n");
  await run({ action: "complete", id });
  expect(readFileSync(process.env.PI_DO_FILE!, "utf8")).toContain("x 2020-01-01");
  failWidget = true;
  expect(await run({ action: "create", name: "survives refresh" })).toContain("Created task");
  expect(existsSync(`${process.env.PI_DO_FILE}.lock`)).toBe(false);
 } finally {
  if (previous.file === undefined) delete process.env.PI_DO_FILE; else process.env.PI_DO_FILE = previous.file;
  if (previous.backend === undefined) delete process.env.PI_DO_BACKEND; else process.env.PI_DO_BACKEND = previous.backend;
  rmSync(dir, { recursive: true, force: true });
 }
});

test("current view shows subtasks of session tasks but not unrelated new tasks", async () => {
 let start: any, widget: any, tool: any;
 const tasks = [{ id: "a", name: "mine", completed: false, started_at: "t" }, { id: "b", name: "sub", completed: false, started_at: null, parent_id: "a" }, { id: "c", name: "subsub", completed: false, started_at: null, parent_id: "b" }, { id: "d", name: "unrelated", completed: false, started_at: null }];
 const prev = process.env.PI_DO_BACKEND; process.env.PI_DO_BACKEND = "dex";
 try {
  extension({ registerTool: (t: any) => tool = t, registerCommand() {}, registerShortcut() {}, appendEntry() {}, exec: async () => ({ code: 0, stdout: JSON.stringify(tasks), stderr: "" }), on: (e: string, h: any) => { if (e === "session_start") start = h; } } as any);
  const ctx = { cwd: process.cwd(), hasUI: true, isProjectTrusted: () => false, ui: { setWidget: (_k: string, f: any) => widget = f, notify() {} }, sessionManager: { getSessionId: () => "s", getEntries: () => [{ type: "custom", customType: "dex-current", data: { id: "a" } }] } };
  await start({}, ctx);
  const out = widget({ requestRender() {} }, { fg: (_c: string, x: string) => x, strikethrough: (x: string) => x }).render(200).join("\n");
  expect(out).toContain("subsub"); expect(out).toContain("sub"); expect(out).not.toContain("unrelated");
 } finally { if (prev === undefined) delete process.env.PI_DO_BACKEND; else process.env.PI_DO_BACKEND = prev; }
});
