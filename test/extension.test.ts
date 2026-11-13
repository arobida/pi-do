import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-tui", () => ({ truncateToWidth: (text: string) => text, Text: class { t = ""; setText(t: string) { this.t = t; } render() { return [this.t]; } } }));
mock.module("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => process.env.PI_CODING_AGENT_DIR || `${process.env.HOME}/.pi/agent` }));
process.env.PI_DO_HOME = (await import("node:fs")).mkdtempSync(`${(await import("node:os")).tmpdir()}/pi-do-home-`);
const { default: extension } = await import("../src/index.ts");

const regTools: Record<string, any> = {};
const toolFor: Record<string, [string, any?]> = { list: ["todo_list"], ready: ["todo_list", { ready: true }], create: ["todo_create"], edit: ["todo_edit"], start: ["todo_status", { status: "started" }], complete: ["todo_status", { status: "completed" }], link: ["todo_link"], resolve: ["todo_resolve"] };
// Test shim: old {action} calls dispatch to the six tools.
function shimTool(t: any) {
 regTools[t.name] = t;
 return { execute: (c: string, { action, ...p }: any, s: any, u: any, ctx: any) => {
  const [name, extra] = toolFor[action];
  if (typeof p.blocked_by === "string") p.blocked_by = p.blocked_by.split(",").filter(Boolean);
  return regTools[name].execute(c, { ...p, ...extra }, s, u, ctx);
 } };
}

test("registers the existing tool, command, shortcuts, and lifecycle hooks", () => {
 const tools: any[] = [], commands: string[] = [], shortcuts: string[] = [], events: string[] = [];
 extension({
  registerTool: (tool: any) => tools.push(tool),
  registerCommand: (name: string) => commands.push(name),
  registerShortcut: (key: string) => shortcuts.push(key),
  on: (event: string) => events.push(event),
 } as any);
 expect(tools.map(t => t.name)).toEqual(["todo_list", "todo_create", "todo_edit", "todo_status", "todo_link", "todo_resolve"]);
 expect(commands).toEqual(["todos"]);
 expect(shortcuts).toEqual(["ctrl+shift+t", "ctrl+shift+v"]);
 expect(events).toEqual(["session_shutdown", "session_start", "before_agent_start", "tool_result"]);
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
 const previous = { file: process.env.PI_DO_FILE };
 process.env.PI_DO_FILE = join(dir, "tasks.jsonl");
 try {
  let tool: any, command: any;
  extension({ registerTool: (t: any) => tool = shimTool(t), registerCommand: (_name: string, c: any) => command = c, registerShortcut() {}, on() {}, appendEntry() {}, exec() { throw new Error("Dex must not run"); } } as any);
  const notifications: string[] = [];
  const ctx = { cwd: dir, hasUI: false, isProjectTrusted: () => true, ui: { notify: (message: string) => notifications.push(message) }, sessionManager: { getSessionId: () => "session" } };
  const run = async (params: any) => (await tool.execute("call", params, undefined, undefined, ctx)).content[0].text;
  const { readFileSync, writeFileSync } = await import("node:fs");
  writeFileSync(process.env.PI_DO_FILE!, [{ id: "a", name: "Call Mom +Family @phone", completed: false, priority: "A", created: "2024-01-01", started_at: null }, { id: "b", name: "Other task", completed: false, started_at: null }].map(t => JSON.stringify(t)).join("\n") + "\n");
  const imported = JSON.parse(await run({ action: "list" }));
  expect(imported[0]).toMatchObject({ name: "Call Mom +Family @phone", priority: "A", created: "2024-01-01", completed: false });
  await run({ action: "complete", id: imported[0].id });
  const records = readFileSync(process.env.PI_DO_FILE!, "utf8").trimEnd().split("\n").map(line => JSON.parse(line));
  expect(records[0]).toMatchObject({ name: "Call Mom +Family @phone", priority: "A", created: "2024-01-01", completed: true, completed_date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  expect(records[1]).toEqual({ id: imported[1].id, name: "Other task", completed: false, started_at: null });
  const id = (await run({ action: "create", name: "one", description: "details" })).match(/Created task (\S+)/)![1];
  await run({ action: "start", id });
  await run({ action: "edit", id, name: "updated" });
  await run({ action: "complete", id, result: "done" });
  const tasks = JSON.parse(await run({ action: "list" }));
  expect(tasks).toHaveLength(3);
  expect(tasks[2]).toMatchObject({ id, name: "updated", description: "details", completed: true, result: "done" });
  expect(tasks[2].started_at).toBeTruthy();
  expect(JSON.parse(readFileSync(process.env.PI_DO_FILE!, "utf8").trimEnd().split("\n")[2])).toMatchObject({ id, name: "updated", description: "details", result: "done" });
  await command.handler("export todo.txt", ctx);
  const exported = readFileSync(join(dir, "todo.txt"), "utf8");
  expect(exported.split("\n")[0]).toMatch(/^x \d{4}-\d{2}-\d{2} 2024-01-01 Call Mom \+Family @phone pri:A piid:/);
  await command.handler("export todo.txt", ctx);
  expect(notifications.at(-1)).toContain("EEXIST");
  expect(readFileSync(join(dir, "todo.txt"), "utf8")).toBe(exported);
  await expect(run({ action: "start", id: "missing" })).rejects.toThrow("Task not found");
  writeFileSync(process.env.PI_DO_FILE!, "old todo.txt line\n");
  await expect(run({ action: "create", name: "new" })).rejects.toThrow("Invalid pi-do JSONL record");
  expect(readFileSync(process.env.PI_DO_FILE!, "utf8")).toBe("old todo.txt line\n");
 } finally {
  if (previous.file === undefined) delete process.env.PI_DO_FILE; else process.env.PI_DO_FILE = previous.file;
  rmSync(dir, { recursive: true, force: true });
 }
});

test.skipIf(!Bun.which("dex"))("Dex adapter syncs both ways", async () => {
 const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = mkdtempSync(join(tmpdir(), "pi-do-dex-test-")), store = join(dir, "store");
 const prev = { home: process.env.PI_DO_HOME, file: process.env.PI_DO_FILE };
 process.env.PI_DO_HOME = join(dir, "home"); process.env.PI_DO_FILE = join(dir, "tasks.jsonl");
 (await import("node:fs")).mkdirSync(process.env.PI_DO_HOME, { recursive: true });
 writeFileSync(join(process.env.PI_DO_HOME, "config.json"), JSON.stringify({ adapters: { dex: { sync: true } } }) + "\n");
 const dex = async (args: string[]) => { const p = Bun.spawn(["dex", "--storage-path", store, ...args], { stdout: "pipe", stderr: "pipe" }); const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { stdout, stderr, code }; };
 try {
  let tool: any;
  extension({ registerTool: (t: any) => tool = shimTool(t), registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {}, exec: async (_cmd: string, args: string[]) => dex(args[0] === "--storage-path" ? args.slice(2) : args) } as any);
  const ctx = { cwd: dir, hasUI: false, isProjectTrusted: () => false, ui: { notify(m: string) { throw new Error(m); } }, sessionManager: { getSessionId: () => "dex-sync" } };
  const run = async (params: any) => (await tool.execute("call", params, undefined, undefined, ctx)).content[0].text;
  const remote = async () => JSON.parse((await dex(["list", "--all", "--json"])).stdout);
  const id = (await run({ action: "create", name: "(A) Call +Family @phone", description: "details" })).match(/Created task (\S+)/)![1];
  let [r] = await remote();
  expect(r).toMatchObject({ name: "(A) Call +Family @phone", description: "details", completed: false });
  await dex(["edit", r.id, "--name", "Renamed in dex"]);
  await dex(["create", "From dex"]);
  let tasks = JSON.parse(await run({ action: "list" }));
  expect(tasks.map((t: any) => t.name)).toEqual(["Renamed in dex", "From dex"]);
  expect(tasks[0].id).toBe(id);
  await dex(["edit", r.id, "--name", "edited in dex"]);
  await run({ action: "complete", id, result: "done" });
  [r] = (await remote()).filter((t: any) => t.id === r.id);
  expect(r).toMatchObject({ name: "edited in dex", completed: true, result: "done" });
  expect(JSON.parse(await run({ action: "list" }))).toHaveLength(2);
 } finally {
  for (const [k, v] of Object.entries({ PI_DO_HOME: prev.home, PI_DO_FILE: prev.file })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(dir, { recursive: true, force: true });
 }
});


test("config.json layers: global < project < env, scope picks storage", async () => {
 const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = mkdtempSync(join(tmpdir(), "pi-do-settings-")), cwd = join(dir, "proj"), root = join(dir, "home");
 const env = { home: process.env.PI_DO_HOME, file: process.env.PI_DO_FILE, scope: process.env.PI_DO_SCOPE };
 process.env.PI_DO_HOME = root; delete process.env.PI_DO_FILE; delete process.env.PI_DO_SCOPE;
 try {
  mkdirSync(cwd); mkdirSync(root);
  let tool: any, command: any; let trusted = true; let dexCalls = 0;
  extension({ registerTool: (t: any) => tool = shimTool(t), registerCommand: (_n: string, c: any) => command = c, registerShortcut() {}, on() {}, appendEntry() {}, exec: async () => { dexCalls++; return { code: 0, stdout: "[]", stderr: "" }; } } as any);
  const notes: string[] = [];
  const ctx = { cwd, hasUI: false, isProjectTrusted: () => trusted, ui: { notify: (m: string) => notes.push(m) }, sessionManager: { getSessionId: () => "session" } };
  const list = async () => JSON.parse((await tool.execute("call", { action: "list" }, undefined, undefined, ctx)).content[0].text);
  // Trusted project without .agents: .pi-do with config, list index and Hello World.
  expect((await list()).map((t: any) => t.name)).toEqual(["Hello World"]);
  expect(existsSync(join(cwd, ".pi-do", "config.json"))).toBe(true);
  expect(existsSync(join(root, "config.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(root, "projects", "projects.jsonl"), "utf8"))).toMatchObject({ name: "proj", path: cwd, scope: "project" });
  expect(existsSync(join(cwd, ".pi-do", "todos", "proj.todos.jsonl"))).toBe(true);
  expect(JSON.parse(readFileSync(join(cwd, ".pi-do", "todos", "lists.jsonl"), "utf8"))).toMatchObject({ name: "proj", file: "proj.todos.jsonl", id: expect.any(String), created: expect.any(String) });
  // .agents alone does not switch stores; /todos migrate moves .pi-do into .agents/pi-do with its todos.
  mkdirSync(join(cwd, ".agents")); await list(); expect(existsSync(join(cwd, ".agents", "pi-do"))).toBe(false);
  const names = async () => (await list()).map((t: any) => t.name);
  await command.handler("migrate .agents/pi-do", ctx);
  expect(existsSync(join(cwd, ".pi-do"))).toBe(false); expect(await names()).toEqual(["Hello World"]);
  expect(existsSync(join(cwd, ".agents", "pi-do", "todos", "proj.todos.jsonl"))).toBe(true);
  await command.handler("migrate .agents/pi-do", ctx); expect(notes.at(-1)).toContain("Already stored");
  await command.handler("migrate .pi-do", ctx); expect(await names()).toEqual(["Hello World"]);
  // Every project is registered with its scope; project scope creates no global dir.
  const reg = () => JSON.parse(readFileSync(join(root, "projects", "projects.jsonl"), "utf8"));
  const project = reg();
  const pid = project.id, pdir = join(root, "projects", `proj.${pid}`);
  expect(project).toMatchObject({ name: "proj", path: cwd, scope: "project", id: expect.any(String) });
  expect(existsSync(pdir)).toBe(false);
  // Scope switch moves todos to the global <name>.<id> dir; the local config keeps the id that links them.
  expect(JSON.parse(readFileSync(join(cwd, ".pi-do", "config.json"), "utf8"))).toMatchObject({ id: pid });
  await tool.execute("c", { action: "create", name: "carried" }, undefined, undefined, ctx);
  await command.handler("scope global", ctx);
  expect(reg()).toMatchObject({ id: pid, scope: "global" });
  expect(existsSync(join(cwd, ".pi-do", "todos"))).toBe(false);
  expect(existsSync(join(cwd, ".pi-do", "config.json"))).toBe(true);
  expect(existsSync(join(pdir, "todos", "proj.todos.jsonl"))).toBe(true);
  expect(existsSync(join(pdir, "config.json"))).toBe(true);
  expect(await names()).toEqual(["Hello World", "carried"]);
  // Matched by id, not path: a renamed project folder finds the same record.
  const { renameSync } = await import("node:fs");
  const moved = join(dir, "renamed"); renameSync(cwd, moved); (ctx as any).cwd = moved;
  expect(await names()).toEqual(["Hello World", "carried"]);
  renameSync(moved, cwd); (ctx as any).cwd = cwd;
  await command.handler("scope project", ctx);
  expect(existsSync(pdir)).toBe(false); expect(reg().scope).toBe("project");
  expect(await names()).toEqual(["Hello World", "carried"]);
  await command.handler("scope global", ctx);
  await command.handler("migrate .agents/pi-do", ctx); expect(notes.at(-1)).toContain("use /todos scope");
  trusted = false; await command.handler("scope project", ctx); expect(notes.at(-1)).toContain("trusted"); trusted = true;
  const { createHash } = await import("node:crypto");
  const tmpRoot0 = () => join(tmpdir(), "pi-do", createHash("sha256").update("session").digest("hex"));
  // Untrusted: temp store with the same layout, nothing written into the project or registry.
  const other = join(dir, "untrusted"); mkdirSync(other); (ctx as any).cwd = other; trusted = false;
  rmSync(tmpRoot0(), { recursive: true, force: true });
  const before = readFileSync(join(root, "projects", "projects.jsonl"), "utf8");
  expect(await names()).toEqual([]);
  expect(existsSync(join(other, ".pi-do"))).toBe(false);
  expect(readFileSync(join(root, "projects", "projects.jsonl"), "utf8")).toBe(before);
  const tmpRoot = tmpRoot0();
  for (const f of ["config.json", "todos/lists.jsonl", "todos/untrusted.todos.jsonl"]) expect(existsSync(join(tmpRoot, ".pi-do", f))).toBe(true);
  // First run ever (no ~/.pi-do) onboards even a temp store.
  const { renameSync: mv } = await import("node:fs");
  rmSync(tmpRoot, { recursive: true }); mv(root, `${root}.bak`);
  expect(await names()).toEqual(["Hello World"]); expect(existsSync(join(root, "config.json"))).toBe(true);
  rmSync(root, { recursive: true }); mv(`${root}.bak`, root);
  rmSync(tmpRoot, { recursive: true }); (ctx as any).cwd = cwd; trusted = true;
  // Project config overrides global config; env overrides both.
  writeFileSync(join(root, "config.json"), JSON.stringify({ adapters: { dex: { sync: true } } }) + "\n");
  writeFileSync(join(pdir, "config.json"), JSON.stringify({ adapters: { dex: { sync: false } } }) + "\n");
  await list(); expect(dexCalls).toBe(0);
  writeFileSync(join(pdir, "config.json"), "");
  await list(); expect(dexCalls).toBeGreaterThan(0);
  writeFileSync(join(root, "config.json"), "");
  // --global export/import targets the global store explicitly.
  await command.handler("export out.txt --global", ctx);
  expect(readFileSync(join(cwd, "out.txt"), "utf8")).toMatch(/^\d{4}-\d{2}-\d{2} Hello World piid:/);
  writeFileSync(join(root, "config.json"), JSON.stringify({ backend: "dex" }) + "\n");
  await expect(list()).rejects.toThrow("replaced by");
  writeFileSync(join(root, "config.json"), JSON.stringify({ adapters: { nope: {} } }) + "\n");
  await expect(list()).rejects.toThrow("Invalid adapters");
 } finally {
  for (const [key, value] of Object.entries({ PI_DO_HOME: env.home, PI_DO_FILE: env.file, PI_DO_SCOPE: env.scope })) {
   if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
 }
});

test("todo.txt import/export round-trips through structured records", async () => {
 const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = mkdtempSync(join(tmpdir(), "pi-do-map-"));
 const prev = process.env.PI_DO_FILE;
 try {
  let command: any;
  extension({ registerTool() {}, registerCommand: (_n: string, c: any) => command = c, registerShortcut() {}, on() {}, appendEntry() {} } as any);
  const ctx = { cwd: dir, hasUI: false, isProjectTrusted: () => true, ui: { notify() {} }, sessionManager: { getSessionId: () => "s" } };
  writeFileSync(join(dir, "in.txt"), ["(A) 2024-01-01 Call Mom +Family @phone due:2024-02-01", "x 2024-01-03 2024-01-01 Done thing pri:B piid:abc", "Plain task with spaces  and ünïcödé"].join("\n") + "\n");
  process.env.PI_DO_FILE = join(dir, "a.jsonl");
  await command.handler("import in.txt", ctx);
  const records = readFileSync(join(dir, "a.jsonl"), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  expect(records[0]).toMatchObject({ name: "Call Mom +Family @phone due:2024-02-01", priority: "A", created: "2024-01-01", completed: false });
  expect(records[1]).toEqual({ id: "abc", name: "Done thing", completed: true, priority: "B", created: "2024-01-01", completed_date: "2024-01-03", started_at: null });
  expect(records[2].name).toBe("Plain task with spaces  and ünïcödé");
  await command.handler("export out.txt", ctx);
  expect(readFileSync(join(dir, "out.txt"), "utf8").split("\n")[1]).toBe("x 2024-01-03 2024-01-01 Done thing pri:B piid:abc");
  await command.handler("import out.txt", ctx); // re-import is a no-op: every line carries its piid
  expect(readFileSync(join(dir, "a.jsonl"), "utf8").trimEnd().split("\n")).toHaveLength(3);
  process.env.PI_DO_FILE = join(dir, "b.jsonl");
  await command.handler("import out.txt", ctx);
  expect(readFileSync(join(dir, "b.jsonl"), "utf8")).toBe(readFileSync(join(dir, "a.jsonl"), "utf8"));
 } finally {
  if (prev === undefined) delete process.env.PI_DO_FILE; else process.env.PI_DO_FILE = prev;
  rmSync(dir, { recursive: true, force: true });
 }
});

test("audit regressions: names, options, dates, refresh, export ~", async () => {
 const { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } = await import("node:fs");
 const { tmpdir, homedir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = mkdtempSync(join(tmpdir(), "pi-do-audit-"));
 const previous = { file: process.env.PI_DO_FILE };
 process.env.PI_DO_FILE = join(dir, "tasks.jsonl");
 try {
  let tool: any;
  extension({ registerTool: (t: any) => tool = shimTool(t), registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} } as any);
  let failWidget = false;
  const ctx = { cwd: dir, hasUI: true, isProjectTrusted: () => true, ui: { notify() {}, setWidget() { if (failWidget) throw new Error("boom"); } }, sessionManager: { getSessionId: () => "s" } };
  const run = async (params: any) => (await tool.execute("call", params, undefined, undefined, ctx)).content[0].text;
  for (const name of ["review piid:foo now", "x investigate bug", "--help", "-v", "a pistart:1"]) await expect(run({ action: "create", name })).rejects.toThrow("Task name must");
  const id = (await run({ action: "create", name: "description", description: "--name" })).match(/Created task (\S+)/)![1];
  expect(JSON.parse(await run({ action: "list" }))[0]).toMatchObject({ name: "description", description: "--name" });
  await run({ action: "complete", id });
  writeFileSync(process.env.PI_DO_FILE!, readFileSync(process.env.PI_DO_FILE!, "utf8").replace(/"completed_date":"[^"]+"/, '"completed_date":"2020-01-01"'));
  await run({ action: "complete", id });
  expect(readFileSync(process.env.PI_DO_FILE!, "utf8")).toContain('"completed_date":"2020-01-01"');
  failWidget = true;
  expect(await run({ action: "create", name: "survives refresh" })).toContain("Created task");
  expect(existsSync(`${process.env.PI_DO_FILE}.lock`)).toBe(false);
 } finally {
  if (previous.file === undefined) delete process.env.PI_DO_FILE; else process.env.PI_DO_FILE = previous.file;
  rmSync(dir, { recursive: true, force: true });
 }
});

test("current view shows subtasks of session tasks but not unrelated new tasks", async () => {
 let start: any, widget: any, tool: any;
 const tasks = [{ id: "a", name: "mine", completed: false, started_at: "t" }, { id: "b", name: "sub", completed: false, started_at: null, parent_id: "a" }, { id: "c", name: "subsub", completed: false, started_at: null, parent_id: "b" }, { id: "d", name: "unrelated", completed: false, started_at: null }];
 const { mkdtempSync, writeFileSync } = await import("node:fs");
 const prev = process.env.PI_DO_FILE; process.env.PI_DO_FILE = `${mkdtempSync(`${(await import("node:os")).tmpdir()}/pi-do-view-`)}/t.jsonl`;
 writeFileSync(process.env.PI_DO_FILE, tasks.map((t: any) => JSON.stringify({ ...t, parent_id: undefined, parent: t.parent_id })).join("\n") + "\n");
 try {
  extension({ registerTool: (t: any) => tool = shimTool(t), registerCommand() {}, registerShortcut() {}, appendEntry() {}, on: (e: string, h: any) => { if (e === "session_start") start = h; } } as any);
  const ctx = { cwd: process.cwd(), hasUI: true, isProjectTrusted: () => false, ui: { setWidget: (_k: string, f: any) => widget = f, notify() {} }, sessionManager: { getSessionId: () => "s", getEntries: () => [{ type: "custom", customType: "dex-current", data: { id: "a" } }] } };
  await start({}, ctx);
  const out = widget({ requestRender() {} }, { fg: (_c: string, x: string) => x, strikethrough: (x: string) => x }).render(200).join("\n");
  expect(out).toContain("subsub"); expect(out).toContain("sub"); expect(out).not.toContain("unrelated");
 } finally { if (prev === undefined) delete process.env.PI_DO_FILE; else process.env.PI_DO_FILE = prev; }
});

test("sync: 3-way per field, pi-do wins conflicts, deletions never propagate", async () => {
 const { mkdtempSync, rmSync } = await import("node:fs");
 const { sync } = await import("../src/adapters/sync.ts");
 const { runFile } = await import("../src/tasks.ts");
 const dir = mkdtempSync(`${(await import("node:os")).tmpdir()}/pi-do-sync-`), file = `${dir}/t.jsonl`;
 const remote = new Map<string, any>(); let n = 0;
 const adapter = { name: "fake", list: async () => [...remote.values()].map((t) => ({ ...t })), create: async (t: any) => { const id = `r${n++}`; remote.set(id, { ...t, id }); return id; }, update: async (id: string, p: any) => { remote.set(id, { ...remote.get(id), ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) }); } };
 try {
  const id = (await runFile(file, ["create", "a", "--description", "d"]) as string).match(/Created task (\S+)/)![1];
  await sync(file, dir, adapter);
  const list = async () => JSON.parse(await runFile(file, ["list"]) as string);
  await runFile(file, ["edit", id, "--name", "local"]);
  remote.set("r0", { ...remote.get("r0"), name: "remote", description: "remote desc" });
  await sync(file, dir, adapter);
  expect((await list())[0]).toMatchObject({ name: "local", description: "remote desc" });
  expect(remote.get("r0")).toMatchObject({ name: "local", description: "remote desc" });
  remote.delete("r0"); await sync(file, dir, adapter);
  expect(await list()).toHaveLength(1); expect(remote.size).toBe(0);
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test.skipIf(process.platform !== "darwin")("Things adapter: writes via URL scheme with the saved token, reads via JXA", async () => {
 const { thingsAdapter, saveThingsToken } = await import("../src/adapters/things/index.ts");
 const todos: any[] = [], urls: string[] = []; let project = false;
 const exec = async (cmd: string, args: string[]) => {
  if (cmd === "osascript") { expect(args.at(-1)).toBe("proj"); return { code: 0, stdout: project ? JSON.stringify(todos) : "null", stderr: "" }; }
  const url = new URL(args[1]); urls.push(args[1]);
  const p = Object.fromEntries(url.searchParams);
  if (url.pathname === "/json") { const [{ type, attributes: a }] = JSON.parse(p.data); expect([type, a.title]).toEqual(["project", "proj"]); project = true; const t = a.items[0].attributes; todos.push({ id: "T1", name: t.title, notes: t.notes, status: "open" }); }
  else if (url.pathname === "/add") expect(p.list).toBe("proj"), todos.push({ id: "T1", name: p.title, notes: p.notes, status: p.completed === "true" ? "completed" : "open" });
  else { const t = todos.find((x) => x.id === p.id); if (p["auth-token"] !== "tok") throw new Error("bad token"); if (p.notes !== undefined) t.notes = p.notes; if (p.completed) t.status = p.completed === "true" ? "completed" : "open"; }
  return { code: 0, stdout: "", stderr: "" };
 };
 const prev = process.env.PI_DO_THINGS_TOKEN; delete process.env.PI_DO_THINGS_TOKEN;
 try {
  const a = thingsAdapter({ exec } as any, "proj");
  await expect(a.create({ id: "x", name: "a b&c", description: "d", completed: false, started_at: null })).rejects.toThrow("token missing");
  saveThingsToken("tok");
  const { statSync } = await import("node:fs");
  expect(statSync(`${process.env.PI_DO_HOME}/adapters/things.json`).mode & 0o777).toBe(0o600);
  expect(todos).toHaveLength(0);
  expect(await a.create({ id: "x", name: "a b&c", description: "d", completed: false, started_at: null })).toBe("T1");
  expect(urls[0]).toContain("things:///json?");
  await a.update("T1", { completed: true });
  expect(await a.list()).toEqual([{ id: "T1", name: "a b&c", description: "d", completed: true, started_at: null }]);
 } finally { if (prev !== undefined) process.env.PI_DO_THINGS_TOKEN = prev; }
});

test("config.json is JSONC, keeps $schema on this version", async () => {
 const { mkdtempSync, writeFileSync, readFileSync, readdirSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const { readConfig, schemaUrl } = await import("../src/store.ts");
 const dir = mkdtempSync(join(tmpdir(), "pi-do-jsonc-"));
 expect(schemaUrl).toEndWith(`/v${JSON.parse(readFileSync("package.json", "utf8")).version}/schema.json`);
 // Comments, trailing commas and "//" inside strings; an old $schema is bumped without losing comments.
 writeFileSync(join(dir, "config.json"), '{\n  "$schema": "https://x/v0.0.1/schema.json", // old\n  /* note */ "file": "~/a//b.jsonl",\n}\n');
 expect(readConfig(dir)).toMatchObject({ file: "~/a//b.jsonl" });
 const text = readFileSync(join(dir, "config.json"), "utf8");
 expect(text).toContain(schemaUrl); expect(text).toContain("// old");
 writeFileSync(join(dir, "config.json"), "{ nope }");
 expect(() => readConfig(dir)).toThrow("Invalid JSON");
 // Every adapter has a schema and every $ref resolves.
 const schema = JSON.parse(readFileSync("schema.json", "utf8"));
 const refs = Object.values(schema.properties.adapters.properties).map((p: any) => p.$ref);
 expect(refs.sort()).toEqual(readdirSync("src/adapters", { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `src/adapters/${d.name}/${d.name}.schema.json`).sort());
 for (const ref of refs) expect(JSON.parse(readFileSync(ref, "utf8")).type).toBe("object");
});

test("store records are validated; bad imports write nothing", async () => {
 const { mkdtempSync, readFileSync, writeFileSync, rmSync } = await import("node:fs");
 const { runFile } = await import("../src/tasks.ts");
 const dir = mkdtempSync(`${(await import("node:os")).tmpdir()}/pi-do-schema-`), file = `${dir}/t.jsonl`;
 try {
  for (const [bad, why] of [["[]", "not an object"], ['{"id":"a","name":"a","completed":false,"started_at":null,"priority":"a"}', "bad priority"], ['{"id":"a","name":"a","completed":false,"started_at":null,"due":"x"}', "unknown key due"], ['{"id":"a","name":"","completed":false,"started_at":null}', "bad name"]]) {
   writeFileSync(file, bad + "\n");
   expect(() => runFile(file, ["list"])).toThrow(`line 1: ${why}`);
  }
  const first = { id: "t1", name: "first +p", completed: false, priority: "B", created: "2024-01-01", started_at: null };
  writeFileSync(file, JSON.stringify(first) + "\n\n");
  const before = readFileSync(file, "utf8");
  await expect(runFile(file, ["import", "fine\npiid:only"])).rejects.toThrow("Invalid todo.txt line 2");
  expect(readFileSync(file, "utf8")).toBe(before);
  await runFile(file, ["import", "same\nsame"]);
  expect(await runFile(file, ["import", "same"])).toBe("Imported 0 tasks");
  const records = readFileSync(file, "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  expect(records).toHaveLength(2);
  expect(records[0]).toEqual(first);
  await runFile(file, ["put", JSON.stringify({ id: first.id, name: "renamed", completed: true })]);
  expect(JSON.parse(runFile(file, ["list"]) as string)[0]).toMatchObject({ name: "renamed", priority: "B", created: "2024-01-01", completed_date: expect.any(String), started_at: null });
  await expect(runFile(file, ["put", JSON.stringify({ id: "z", name: "z", completed: false, junk: 1 })])).rejects.toThrow("unknown key junk");
 } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("session_shutdown releases claims; force overrides a live claim; link and resolve work", async () => {
 const { mkdtempSync, rmSync } = await import("node:fs");
 const { tmpdir } = await import("node:os");
 const { join } = await import("node:path");
 const dir = mkdtempSync(join(tmpdir(), "pi-do-claims-")), cwd = join(dir, "proj"), root = join(dir, "home");
 const env = { home: process.env.PI_DO_HOME, file: process.env.PI_DO_FILE, scope: process.env.PI_DO_SCOPE };
 process.env.PI_DO_HOME = root; delete process.env.PI_DO_FILE; delete process.env.PI_DO_SCOPE;
 try {
  require("node:fs").mkdirSync(cwd);
  let tool: any; const handlers: any = {};
  extension({ registerTool: (t: any) => tool = shimTool(t), registerCommand() {}, registerShortcut() {}, on: (e: string, h: any) => handlers[e] = h, appendEntry() {}, exec() { throw new Error("no dex"); } } as any);
  const ctxFor = (id: string) => ({ cwd, hasUI: false, isProjectTrusted: () => true, ui: { notify() {} }, sessionManager: { getSessionId: () => id } });
  const [a, b] = [ctxFor("A"), ctxFor("B")];
  const run = async (ctx: any, params: any) => (await tool.execute("call", params, undefined, undefined, ctx)).content[0].text;
  const id = (await run(a, { action: "create", name: "shared" })).match(/Created task (\S+)/)![1];
  await run(a, { action: "start", id });
  await expect(run(b, { action: "start", id })).rejects.toThrow("pass force to override");
  await run(b, { action: "start", id, force: true });
  await handlers.session_shutdown({}, a);
  await expect(run(a, { action: "start", id })).rejects.toThrow("claimed by");
  await handlers.session_shutdown({}, b);
  await run(a, { action: "start", id });
  const ready = JSON.parse(await run(b, { action: "ready" }));
  expect(ready.map((t: any) => t.id)).not.toContain(id);
  await handlers.session_shutdown({}, a);
  expect(JSON.parse(await run(b, { action: "ready" })).map((t: any) => t.id)).toContain(id);
  const md = await run(a, { action: "link", id });
  expect(md).toMatch(/^\[shared\]\(pido:\/\//);
  expect(await run(a, { action: "resolve", url: md.match(/\((pido:[^)]+)\)/)![1] })).toContain("shared");
  await expect(run(a, { action: "edit", id, name: "", url: null })).rejects.toThrow("todo_edit needs at least one of");
  await expect(run(a, { action: "start", id, result: "x" })).rejects.toThrow("result is only for status completed");
  expect(regTools.todo_status.renderCall({ id, status: "started" }, { fg: (_: string, x: string) => x, bold: (x: string) => x }, {}).render(80)[0]).toContain(`todo › status ${id} → started`);
  expect(await run(a, { action: "start", id, force: "" })).toBe(`Started task ${id} "shared"; claimed by this session`);
  expect(await run(a, { action: "edit", id, description: "d" })).toBe(`Updated task ${id} "shared"; changed description; description: "d"`);
  expect(await run(a, { action: "edit", id, description: "d" })).toBe(`No change to task ${id} "shared"; values already set; description: "d"`);
  expect(await run(a, { action: "complete", id, result: "ok" })).toBe(`Completed task ${id} "shared"; result: ok`);
 } finally {
  for (const [k, v] of [["PI_DO_HOME", env.home], ["PI_DO_FILE", env.file], ["PI_DO_SCOPE", env.scope]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  rmSync(dir, { recursive: true, force: true });
 }
});
