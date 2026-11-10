import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

interface Task {
	id: string;
	name: string;
	completed: boolean;
	started_at: string | null;
	description?: string;
	parent?: string;
	result?: string;
}

function parseTodo(line: string, index: number): Task {
	const meta: Record<string, string> = {};
	const body = line.replace(/(?:^|\s)(piid|pistart|pidesc|piparent|piresult):([^\s:]+)/g, (match, key, value) => {
		try { meta[key] = decodeURIComponent(value); return ""; } catch { return match; }
	}).trim();
	const completed = /^x\s/.test(body);
	return { id: meta.piid || `line-${index + 1}-${createHash("sha256").update(line).digest("hex").slice(0, 12)}`, name: completed ? body.replace(/^x\s+(?:\d{4}-\d{2}-\d{2}\s+)?/, "") : body, completed, started_at: meta.pistart || null, description: meta.pidesc, parent: meta.piparent, result: meta.piresult };
}

function dexTodo(task: any): string {
	if (typeof task.id !== "string" || typeof task.name !== "string" || typeof task.completed !== "boolean") throw new Error("Invalid Dex task");
	let name = task.name.replace(/[\r\n]+/g, " ").trim();
	if (!name) throw new Error(`Dex task ${task.id} has no name`);
	if (task.completed && /^\([A-Z]\)\s/.test(name)) name = name.replace(/^\(([A-Z])\)\s+/, "") + ` pri:${name[1]}`;
	const metadata = Object.entries({ piid: task.id, pistart: task.started_at, pidesc: task.description, piparent: task.parent_id, piresult: task.result })
		.filter(([, value]) => typeof value === "string" && value !== "").map(([key, value]) => `${key}:${encodeURIComponent(value as string)}`);
	const date = typeof task.completed_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(task.completed_at) ? task.completed_at.slice(0, 10) : undefined;
	if (task.completed && !date) throw new Error(`Dex task ${task.id} has no completion date`);
	return `${task.completed ? `x ${date} ` : ""}${name} ${metadata.join(" ")}`;
}

function settings(ctx: ExtensionContext): { backend: string; file?: string } {
	function readSettings(path: string): { backend?: string; file?: string } {
		let data: any;
		try { data = JSON.parse(readFileSync(path, "utf8")); }
		catch (error: any) { if (error.code === "ENOENT") return {}; throw new Error(`Cannot read pi-do settings from ${path}: ${error.message}`); }
		const config = data?.piDo;
		if (config === undefined) return {};
		if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`Invalid piDo settings in ${path}`);
		if (config.backend !== undefined && config.backend !== "file" && config.backend !== "dex") throw new Error(`Invalid piDo.backend in ${path}`);
		if (config.file !== undefined && (typeof config.file !== "string" || !config.file.trim())) throw new Error(`Invalid piDo.file in ${path}`);
		return { ...(config.backend !== undefined ? { backend: config.backend } : {}), ...(config.file !== undefined ? { file: config.file } : {}) };
	}
	const config = { ...readSettings(join(getAgentDir(), "settings.json")), ...(ctx.isProjectTrusted() ? readSettings(join(ctx.cwd, ".pi", "settings.json")) : {}) };
	return { backend: process.env.PI_DO_BACKEND || config.backend || "file", file: process.env.PI_DO_FILE || config.file };
}

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

	function configured(cwd: string): boolean {
		let dir = resolve(cwd);
		while (true) {
			if (existsSync(join(dir, ".dex", "config.toml"))) return true;
			const parent = dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		return existsSync(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "dex", "dex.toml"));
	}

	function storageArgs(ctx: ExtensionContext): string[] {
		if (configured(ctx.cwd)) return [];
		const id = createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex");
		return ["--storage-path", join(tmpdir(), "pi-dex", id)];
	}

	async function dex(ctx: ExtensionContext, args: string[], signal?: AbortSignal): Promise<string> {
		const result = await pi.exec("dex", [...storageArgs(ctx), ...args], { cwd: ctx.cwd, signal });
		if (result.code !== 0) throw new Error(result.stderr || result.stdout || `dex exited ${result.code}`);
		return result.stdout;
	}

	async function run(ctx: ExtensionContext, args: string[], signal?: AbortSignal): Promise<string> {
		const { backend, file: configuredFile } = settings(ctx);
		if (backend === "dex") {
			if (args[0] !== "list" && args[0] !== "export") return dex(ctx, args, signal);
			const data = JSON.parse(await dex(ctx, ["list", "--all", "--json"], signal));
			if (!Array.isArray(data)) throw new Error("Invalid Dex task list");
			const lines = data.map(dexTodo);
			return args[0] === "export" ? (lines.length ? lines.join("\n") + "\n" : "") : JSON.stringify(lines.map(parseTodo));
		}
		if (backend !== "file") throw new Error(`Unknown pi-do backend: ${backend}`);
		const id = createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex");
		const file = configuredFile ? resolve(ctx.cwd, configuredFile === "~" ? homedir() : configuredFile.startsWith("~/") ? join(homedir(), configuredFile.slice(2)) : configuredFile) : join(tmpdir(), "pi-do", `${id}.jsonl`);
		let lines: string[] = [];
		try {
			const data = readFileSync(file, "utf8");
			lines = data ? data.split("\n") : [];
			if (lines.at(-1) === "") lines.pop();
			lines = lines.map((line, index) => {
				let record: any;
				try { record = JSON.parse(line); } catch { throw new Error(`Invalid pi-do JSONL record on line ${index + 1}`); }
				if (!record || typeof record !== "object" || Array.isArray(record) || Object.keys(record).length !== 1 || typeof record.todo !== "string" || !record.todo.trim() || /[\r\n]/.test(record.todo)) throw new Error(`Invalid pi-do JSONL record on line ${index + 1}`);
				return record.todo;
			});
		} catch (error: any) { if (error.code !== "ENOENT") throw error; }
		if (args[0] === "export") return lines.length ? lines.join("\n") + "\n" : "";
		const items = lines.map(parseTodo);
		const [action, value] = args;
		if (action === "list") return JSON.stringify(items.filter(Boolean));
		const option = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
		let task: Task;
		let index = items.length;
		if (action === "create") {
			const parent = option("--parent");
			if (parent && !items.some((item) => item?.id === parent)) throw new Error(`Task not found: ${parent}`);
			task = { id: randomUUID(), name: value, completed: false, started_at: null, description: option("--description"), parent };
		} else {
			index = items.findIndex((item) => item?.id === value);
			const found = items[index];
			if (!found) throw new Error(`Task not found: ${value}`);
			task = found;
			if (action === "start") task.started_at = new Date().toISOString();
			else if (action === "complete") { task.completed = true; task.result = option("--result"); }
			else if (action === "edit") { if (option("--name") !== undefined) task.name = option("--name")!; if (option("--description") !== undefined) task.description = option("--description"); }
			else throw new Error(`Unknown action: ${action}`);
		}
		if (/[\r\n]/.test(task.name) || !task.name.trim()) throw new Error("Task name must be a non-empty single line");
		const metadata = Object.entries({ piid: task.id, pistart: task.started_at, pidesc: task.description, piparent: task.parent, piresult: task.result })
			.filter(([, value]) => value != null && value !== "").map(([key, value]) => `${key}:${encodeURIComponent(value!)}`);
		let name = task.name.trim();
		if (task.completed && /^\([A-Z]\)\s/.test(name)) name = name.replace(/^\(([A-Z])\)\s+/, "") + ` pri:${name[1]}`;
		const completionDate = action === "complete" ? new Date().toISOString().slice(0, 10) : lines[index]?.match(/^x\s+(\d{4}-\d{2}-\d{2})\s/)?.[1] || new Date().toISOString().slice(0, 10);
		lines[index] = `${task.completed ? `x ${completionDate} ` : ""}${name} ${metadata.join(" ")}`;
		mkdirSync(dirname(file), { recursive: true });
		const temp = `${file}.${randomUUID()}.tmp`;
		writeFileSync(temp, lines.map((todo) => JSON.stringify({ todo })).join("\n") + "\n", { mode: 0o600 });
		renameSync(temp, file);
		return action === "create" ? `Created task ${task.id}` : `${action}: ${task.id}`;
	}

	function shown(): Task[] {
		if (view === "completed") return tasks.filter((t) => t.completed);
		if (view === "current") return tasks.filter((t) => mine.has(t.id));
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
			const tasks = list;
			for (const task of tasks.slice(0, 11)) {
				const glyph = task.completed ? theme.fg("success", "✓") : task.started_at ? theme.fg("warning", "◐") : theme.fg("dim", "○");
				const name = task.name.replace(/\s+/g, " ").trim();
				lines.push(`  ${glyph} ${theme.fg("dim", `#${task.id}`)} ${task.completed ? theme.strikethrough(theme.fg("muted", name)) : name}`);
			}
			if (tasks.length > 11) lines.push(theme.fg("dim", `  +${tasks.length - 11} more`));
		}
		return lines.map((line) => truncateToWidth(line, width, "…"));
	}

	async function refresh(ctx: ExtensionContext) {
		const data = JSON.parse(await run(ctx, ["list", "--all", "--json"]));
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
		description: "Manage tasks with list, create, start, complete, or edit. Storage defaults to a temporary session file; persistent file and Dex backends are configurable.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("list"), Type.Literal("create"), Type.Literal("start"), Type.Literal("complete"), Type.Literal("edit")]),
			id: Type.Optional(Type.String({ description: "Task ID for start, complete, or edit" })),
			name: Type.Optional(Type.String({ description: "Task name for create or edit" })),
			description: Type.Optional(Type.String()),
			parent: Type.Optional(Type.String({ description: "Parent task ID when creating" })),
			result: Type.Optional(Type.String({ description: "Completion result" })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			const { action, id, name, description, parent, result } = params;
			if (action === "create" && !name?.trim()) throw new Error("create requires a name");
			if (["start", "complete", "edit"].includes(action) && !id?.trim()) throw new Error(`${action} requires an id`);
			if (action === "edit" && name === undefined && description === undefined) throw new Error("edit requires a name or description");
			let args: string[];
			if (action === "list") args = ["list", "--all", "--json"];
			else if (action === "create") args = ["create", name!, ...(description !== undefined ? ["--description", description] : []), ...(parent ? ["--parent", parent] : [])];
			else if (action === "edit") args = ["edit", id!, ...(name !== undefined ? ["--name", name] : []), ...(description !== undefined ? ["--description", description] : [])];
			else if (action === "complete") args = ["complete", id!, "--result", result || "Completed", "--no-commit"];
			else args = ["start", id!];
			const output = await run(ctx, args, signal);
			if (id) track(id);
			else if (action === "create" && parent && mine.has(parent)) { const m = output.match(/Created task (\S+)/); if (m) track(m[1]); }
			await refresh(ctx);
			return { content: [{ type: "text", text: output }], details: {} };
		},
	});

	pi.registerCommand("todos", {
		description: "Show tasks or export todo.txt: /todos [current|project|completed|export <path>]", 
		async handler(args, ctx) {
			try {
				const want = String(args ?? "").trim();
				if (want.startsWith("export ")) {
					const path = resolve(ctx.cwd, want.slice(7).trim());
					const output = await run(ctx, ["export"]);
					writeFileSync(path, output, { flag: "wx" });
					ctx.ui.notify(`Exported tasks to ${path}`, "info");
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
	pi.on("session_start", async (_event, ctx) => { restore(ctx); try { await refresh(ctx); } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Tasks: ${error}`, "error"); } });
	pi.on("session_switch", async (_event, ctx) => { restore(ctx); try { await refresh(ctx); } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Tasks: ${error}`, "error"); } });
	pi.on("tool_result", async (event, ctx) => {
		if (event.isError) return;
		try { if (settings(ctx).backend !== "dex") return; } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Tasks: ${error}`, "error"); return; }
		const command = event.toolName === "bash" ? String(event.input?.command ?? "") : "";
		for (const m of command.matchAll(/\bdex\s+(?:start|complete|edit)\s+([\w-]+)/g)) track(m[1]);
		// bash creates count only as subtasks of a current task; top-level creates are backlog until started.
		const parent = command.match(/\bdex\s+create\b.*--parent[\s=]+["']?([\w-]+)/)?.[1];
		if (parent && mine.has(parent) && !event.isError) {
			const text = (event.content ?? []).map((c: any) => c.text ?? "").join("\n");
			for (const m of text.matchAll(/Created task (\S+)/g)) track(m[1]);
		}
		if (/\bdex\b/.test(command) || /dex/i.test(event.toolName)) {
			try { await refresh(ctx); } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Tasks: ${error}`, "error"); }
		}
	});
}
