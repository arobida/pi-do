import { type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, mkdirSync, watch, type FSWatcher, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkName, type Task } from "./todo.ts";
import { home } from "./util.ts";
import { migrate, setScope, settings, storeFile } from "./store.ts";
import { runFile } from "./tasks.ts";
import { dexAdapter, dexWatchDirs } from "./adapters/dex/index.ts";
import { sync, type Adapter } from "./adapters/sync.ts";
import { saveThingsToken, thingsAdapter } from "./adapters/things/index.ts";

export default function taskPanel(pi: ExtensionAPI) {
	let tasks: Task[] = [];
	let collapsed = false;
	// Tasks this Pi session created/started/completed/edited; saved as session entries so resume restores them.
	const mine = new Set<string>();
	function track(id: string) {
		if (mine.has(id)) return;
		mine.add(id);
		pi.appendEntry("dex-current", { id });
	}
	function restore(ctx: ExtensionContext) {
		mine.clear();
		for (const e of ctx.sessionManager.getEntries() as any[]) if (e.type === "custom" && e.customType === "dex-current" && e.data?.id) mine.add(e.data.id);
	}
	const views = ["current", "project", "completed"] as const;
	let view: (typeof views)[number] = "current";
	let tui: TUI | undefined;
	async function run(ctx: ExtensionContext, args: string[], signal?: AbortSignal, global = false): Promise<string> {
		const s = settings(ctx, global), file = storeFile(ctx, s);
		if (args[0] === "list") await syncAll(ctx, global);
		const out = await runFile(file, args);
		if (!["list", "export"].includes(args[0])) await syncAll(ctx, global);
		return out;
	}
	// Adapters with sync on mirror the pi-do store; runs are chained so two syncs never interleave.
	let syncing: Promise<void> = Promise.resolve();
	function syncAll(ctx: ExtensionContext, global = false): Promise<void> {
		const s = settings(ctx, global);
		const make: Record<string, () => Adapter> = { dex: () => dexAdapter(pi, ctx), things: () => thingsAdapter(pi, s.name) };
		const file = storeFile(ctx, s);
		for (const name of Object.keys(s.adapters).filter((n) => s.adapters[n].sync)) {
			syncing = syncing.catch(() => {}).then(() => sync(file, s.base, make[name]())).catch((error) => { if (ctx.hasUI) ctx.ui.notify(`Tasks: ${name} sync failed: ${error}`, "error"); });
		}
		return syncing;
	}

	function shown(): Task[] {
		if (view === "completed") return tasks.filter((t) => t.completed);
		// Current = tasks this session touched plus their subtasks from anywhere (e.g. `dex create --parent` by another agent); unrelated new tasks stay in Project.
		if (view === "current") { const byId = new Map(tasks.map((t) => [t.id, t])); const memo = new Map<string, boolean>(); const current = (t: Task | undefined, depth = 0): boolean => { if (!t || depth >= 50) return false; if (!memo.has(t.id)) memo.set(t.id, mine.has(t.id) || current(t.parent ? byId.get(t.parent) : undefined, depth + 1)); return memo.get(t.id)!; }; return tasks.filter((t) => current(t)); }
		return tasks.filter((t) => !t.completed);
	}

	function render(theme: Theme, width: number): string[] {
		const list = shown();
		const done = list.filter((task) => task.completed).length;
		const title = { current: "Current", project: "Project", completed: "Completed" }[view];
		const lines = [`${theme.fg("accent", "●")} ${theme.fg("accent", `${title} tasks (${view === "project" ? `${list.length} open` : view === "completed" ? list.length : `${done}/${list.length}`})`)} ${theme.fg("dim", "ctrl+shift+v: view")}`];
		if (collapsed) lines.push(theme.fg("dim", "  ctrl+shift+t to expand"));
		else if (!list.length) lines.push(theme.fg("dim", view === "current" ? "  No tasks worked on in this session yet" : "  None"));
		else {
			for (const task of list.slice(0, 11)) {
				const glyph = task.completed ? theme.fg("success", "✓") : task.started_at ? theme.fg("warning", "◐") : theme.fg("dim", "○");
				const name = task.name.replace(/\s+/g, " ").trim();
				lines.push(`  ${glyph} ${theme.fg("dim", `#${task.id}`)} ${task.completed ? theme.strikethrough(theme.fg("muted", name)) : name}`);
			}
			if (list.length > 11) lines.push(theme.fg("dim", `  +${list.length - 11} more`));
		}
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	async function refresh(ctx: ExtensionContext) {
		// The panel reads the store as-is: mutations already synced, and remote edits arrive via explicit list or watchers.
		const data = JSON.parse(await runFile(storeFile(ctx, settings(ctx)), ["list", "--all", "--json"]));
		if (!Array.isArray(data)) throw new Error("Invalid task list");
		tasks = data;
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("dex-panel", (t, theme) => {
			tui = t;
			return { render: (width: number) => render(theme, width), invalidate() {} };
		}, { placement: "aboveEditor" });
	}

	pi.registerTool({
		name: "todo_task",
		label: "Tasks",
		description: "Manage tasks with list, create, start, complete, or edit. Storage defaults to a temporary session file; Dex can sync via the adapters config.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("start"), Type.Literal("complete"), Type.Literal("edit")]),
			id: Type.Optional(Type.String({ description: "Task ID for start, complete, or edit" })),
			name: Type.Optional(Type.String({ description: "Task name for create or edit" })),
			description: Type.Optional(Type.String({ description: "Task details for create or edit" })),
			parent: Type.Optional(Type.String({ description: "ID of an existing task to nest under (not free text)" })),
			result: Type.Optional(Type.String({ description: "Completion result" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { action, id, name, description, parent, result } = params;
			if (action === "create" && !name?.trim()) throw new Error("create requires a name");
			if (["start", "complete", "edit"].includes(action) && !id?.trim()) throw new Error(`${action} requires an id`);
			if (action === "edit" && name === undefined && description === undefined) throw new Error("edit requires a name or description");
			if (name !== undefined && (action === "create" || action === "edit")) checkName(name);
			let args: string[];
			if (action === "list") args = ["list", "--all", "--json"];
			else if (action === "create") args = ["create", name!, ...(description !== undefined ? ["--description", description] : []), ...(parent ? ["--parent", parent] : [])];
			else if (action === "edit") args = ["edit", id!, ...(name !== undefined ? ["--name", name] : []), ...(description !== undefined ? ["--description", description] : [])];
			else if (action === "complete") args = ["complete", id!, "--result", result || "Completed", "--no-commit"];
			else args = ["start", id!];
			const output = await run(ctx, args, signal);
			if (id) track(id);
			else if (action === "create" && parent && mine.has(parent)) { const m = output.match(/Created task (\S+)/); if (m) track(m[1]); }
			// The change is already saved; a failed reload must not make the agent retry it.
			try { await refresh(ctx); } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Tasks: ${error}`, "error"); }
			return { content: [{ type: "text", text: output }], details: {} };
		},
	});

	pi.registerCommand("todos", {
		description: "Show tasks or move todo.txt: /todos [current|project|completed|export <path>|import <path>|migrate .pi-do|.agents/pi-do|scope project|global|connect things <token>] [--global]", 
		async handler(args, ctx) {
			try {
				let want = String(args ?? "").trim();
				const global = /\s--global$/.test(want);
				if (global) want = want.slice(0, -9).trim();
				const conn = want.match(/^connect\s+things\s+(\S+)$/);
				if (conn) { ctx.ui.notify(saveThingsToken(conn[1]), "info"); await refresh(ctx); return; }
				const mig = want.match(/^migrate\s+(\.pi-do|\.agents\/pi-do)$/);
				const sc = want.match(/^scope\s+(project|global)$/);
				if (mig || sc) { ctx.ui.notify(mig ? migrate(ctx, mig[1]) : setScope(ctx, sc![1]), "info"); void watchStore(ctx); await refresh(ctx); return; }
				const io = want.match(/^(export|import)\s+(.+)$/);
				if (io) {
					const path = resolve(ctx.cwd, home(io[2].trim()));
					if (io[1] === "import") { ctx.ui.notify(await run(ctx, ["import", readFileSync(path, "utf8")], undefined, global), "info"); await refresh(ctx); return; }
					const { text, skipped } = JSON.parse(await run(ctx, ["export"], undefined, global));
					writeFileSync(path, text, { flag: "wx" });
					ctx.ui.notify(`Exported tasks to ${path}`, "info");
					if (skipped.length) ctx.ui.notify(`Not exported, todo.txt would misread these names (they start like a marker: x, (A), or a date). Rename them or give them a created date, then export again:\n${skipped.join("\n")}`, "warning");
					return;
				}
				if ((views as readonly string[]).includes(want)) view = want as typeof view;
				await refresh(ctx);
				const list = shown();
				ctx.ui.notify(list.length ? list.map((t) => `${t.completed ? "✓" : t.started_at ? "◐" : "○"} #${t.id} ${t.name}`).join("\n") : "No todos yet. Ask the agent to add some!", "info");
			} catch (error) { ctx.ui.notify(`Tasks: ${error}`, "error"); }
		},
	});
	pi.registerShortcut("ctrl+shift+t", { description: "Toggle tasks", handler: async () => { collapsed = !collapsed; tui?.requestRender(); } });
	pi.registerShortcut("ctrl+shift+v", { description: "Cycle task view (current/project/completed)", handler: async () => { view = views[(views.indexOf(view) + 1) % views.length]; tui?.requestRender(); } });
	// Live panel: reload when the task storage changes, so tasks other agents add show up right away.
	let watchers: FSWatcher[] = [];
	const unwatch = () => { for (const w of watchers) w.close(); watchers = []; };
	async function watchStore(ctx: ExtensionContext) {
		unwatch();
		try {
			const s = settings(ctx);
			const file = storeFile(ctx, s);
			const dir = dirname(file); mkdirSync(dir, { recursive: true });
			let timer: ReturnType<typeof setTimeout> | undefined;
			const later = (fn: () => Promise<unknown>) => { clearTimeout(timer); timer = setTimeout(() => { fn().catch(() => {}); }, 200); };
			// Watch the folder, not the file: saves replace the file by rename.
			const watchDir = (d: string, recursive: boolean, onChange: (name: string | null) => void) => {
				if (!d || !existsSync(d)) return;
				const w = watch(d, { recursive }, (_e, name) => onChange(name));
				w.on("error", () => w.close());
				watchers.push(w);
			};
			watchDir(dir, false, (name) => { if (name === file.slice(dir.length + 1)) later(() => refresh(ctx)); });
			// Dex edits from other agents pull in through sync, which then rewrites the store and refreshes.
			if (s.adapters.dex?.sync) for (const d of (await dexWatchDirs(pi, ctx)) ?? []) watchDir(d, true, () => later(() => syncAll(ctx)));
		} catch {}
	}
	pi.on("session_shutdown", async () => unwatch());
	pi.on("session_start", async (_event, ctx) => { void watchStore(ctx); restore(ctx); try { await refresh(ctx); } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Tasks: ${error}`, "error"); } });
	pi.on("session_switch", async (_event, ctx) => { void watchStore(ctx); restore(ctx); try { await refresh(ctx); } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Tasks: ${error}`, "error"); } });
	// Pick up tasks other agents added through Dex before each prompt.
	pi.on("before_agent_start", async (_event, ctx) => { try { await refresh(ctx); } catch {} });
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		try { if (!settings(ctx).adapters.dex?.sync) return; } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Tasks: ${error}`, "error"); return; }
		// Only todo_task calls mark tasks as this session's; shell text can't prove what ran, so bash dex calls just refresh.
		const command = event.toolName === "bash" ? String(event.input?.command ?? "") : "";
		if (/\bdex\b/.test(command) || /dex/i.test(event.toolName)) {
			try { await refresh(ctx); } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Tasks: ${error}`, "error"); }
		}
	});
}
