import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";

interface Task {
	id: string;
	name: string;
	completed: boolean;
	started_at: string | null;
}

export default function dexPanel(pi: ExtensionAPI) {
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

	function shown(): Task[] {
		if (view === "completed") return tasks.filter((t) => t.completed);
		if (view === "current") return tasks.filter((t) => mine.has(t.id));
		return tasks.filter((t) => !t.completed);
	}

	function render(theme: Theme, width: number): string[] {
		if (!tasks.length) return [];
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
		const data = JSON.parse(await dex(ctx, ["list", "--all", "--json"]));
		if (!Array.isArray(data)) throw new Error("Invalid dex task list");
		tasks = data;
		if (!ctx.hasUI) return;
		if (!tasks.length) {
			ctx.ui.setWidget("dex-panel", undefined);
			tui = undefined;
			return;
		}
		ctx.ui.setWidget("dex-panel", (t, theme) => {
			tui = t;
			return { render: (width: number) => render(theme, width), invalidate() {} };
		}, { placement: "aboveEditor" });
	}

	pi.registerTool({
		name: "dex_task",
		label: "Dex tasks",
		description: "Manage persistent Dex tasks for this project. Use list, create, start, complete, or edit. If no Dex configuration exists, tasks are isolated to this Pi session.",
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
			const output = await dex(ctx, args, signal);
			if (id) track(id);
			else if (action === "create" && parent && mine.has(parent)) { const m = output.match(/Created task (\S+)/); if (m) track(m[1]); }
			await refresh(ctx);
			return { content: [{ type: "text", text: output }], details: {} };
		},
	});

	pi.registerCommand("todos", {
		description: "Show Dex tasks: /todos [current|project|completed]",
		async handler(args, ctx) {
			try {
				const want = String(args ?? "").trim();
				if ((views as readonly string[]).includes(want)) view = want as typeof view;
				await refresh(ctx);
				const list = shown();
				ctx.ui.notify(list.length ? list.map((t) => `${t.completed ? "✓" : t.started_at ? "◐" : "○"} #${t.id} ${t.name}`).join("\n") : "No todos yet. Ask the agent to add some!", "info");
			} catch (error) { ctx.ui.notify(`Dex: ${error}`, "error"); }
		},
	});
	pi.registerShortcut("ctrl+shift+t", { description: "Toggle Dex tasks", handler: async () => { collapsed = !collapsed; tui?.requestRender(); } });
	pi.registerShortcut("ctrl+shift+v", { description: "Cycle Dex view (current/project/completed)", handler: async () => { view = views[(views.indexOf(view) + 1) % views.length]; tui?.requestRender(); } });
	pi.on("session_start", async (_event, ctx) => { restore(ctx); try { await refresh(ctx); } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Dex: ${error}`, "error"); } });
	pi.on("session_switch", async (_event, ctx) => { restore(ctx); try { await refresh(ctx); } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Dex: ${error}`, "error"); } });
	pi.on("tool_result", async (event, ctx) => {
		const command = event.toolName === "bash" ? String(event.input?.command ?? "") : "";
		for (const m of command.matchAll(/\bdex\s+(?:start|complete|edit)\s+([\w-]+)/g)) track(m[1]);
		// bash creates count only as subtasks of a current task; top-level creates are backlog until started.
		const parent = command.match(/\bdex\s+create\b.*--parent[\s=]+["']?([\w-]+)/)?.[1];
		if (parent && mine.has(parent) && !event.isError) {
			const text = (event.content ?? []).map((c: any) => c.text ?? "").join("\n");
			for (const m of text.matchAll(/Created task (\S+)/g)) track(m[1]);
		}
		if (/\bdex\b/.test(command) || /dex/i.test(event.toolName)) {
			try { await refresh(ctx); } catch (error) { if (ctx.hasUI) ctx.ui.notify(`Dex: ${error}`, "error"); }
		}
	});
}
