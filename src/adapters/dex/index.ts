import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { type Task } from "../../todo.ts";
import type { Adapter } from "../sync.ts";
import { home } from "../../util.ts";

// Validates a Dex task record; todo.txt rendering is left to export so names it cannot carry don't break listing.
export function checkDex(task: any) {
	if (typeof task.id !== "string" || typeof task.name !== "string" || typeof task.completed !== "boolean") throw new Error("Invalid Dex task");
	const name = task.name.replace(/[\r\n]+/g, " ").trim();
	if (!name) throw new Error(`Dex task ${task.id} has no name`);
	const date = typeof task.completed_at === "string" && /^\d{4}-\d{2}-\d{2}/.test(task.completed_at) ? task.completed_at.slice(0, 10) : undefined;
	if (task.completed && !date) throw new Error(`Dex task ${task.id} has no completion date`);
}

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

async function dex(pi: ExtensionAPI, ctx: ExtensionContext, args: string[], signal?: AbortSignal): Promise<string> {
	const result = await pi.exec("dex", [...storageArgs(ctx), ...args], { cwd: ctx.cwd, signal });
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || `dex exited ${result.code}`);
	return result.stdout;
}

const fromDex = (t: any): Task => { checkDex(t); return { id: t.id, name: t.name, completed: t.completed, started_at: t.started_at ?? null, description: t.description ?? undefined, parent: t.parent_id ?? undefined, result: t.result ?? undefined }; };

export function dexAdapter(pi: ExtensionAPI, ctx: ExtensionContext): Adapter {
	const run = (args: string[]) => dex(pi, ctx, args);
	return {
		name: "dex",
		async list() {
			const data = JSON.parse(await run(["list", "--all", "--json"]));
			if (!Array.isArray(data)) throw new Error("Invalid Dex task list");
			return data.map(fromDex);
		},
		async create(task) {
			const out = await run(["create", task.name, ...(task.description ? ["--description", task.description] : []), ...(task.parent ? ["--parent", task.parent] : [])]);
			const id = out.match(/Created task (\S+)/)?.[1];
			if (!id) throw new Error(`Unexpected dex create output: ${out}`);
			if (task.started_at || task.completed) await this.update(id, { started_at: task.started_at, completed: task.completed, result: task.result });
			return id;
		},
		// shortcut: Dex has no uncomplete/unstart or result edit on completed tasks; those changes stay local.
		async update(id, patch) {
			if (patch.name !== undefined || patch.description !== undefined || patch.parent !== undefined) await run(["edit", id, ...(patch.name !== undefined ? ["--name", patch.name] : []), ...(patch.description !== undefined ? ["--description", patch.description ?? ""] : []), ...(patch.parent ? ["--parent", patch.parent] : [])]);
			if (patch.started_at && !patch.completed) await run(["start", id, "--force"]);
			if (patch.completed) await run(["complete", id, "--result", patch.result || "done", "--no-commit", "--force"]);
		},
	};
}

// Folders holding Dex's task storage, or undefined when the engine has nothing local to watch.
export async function dexWatchDirs(pi: ExtensionAPI, ctx: ExtensionContext): Promise<string[] | undefined> {
	const custom = storageArgs(ctx)[1];
	if (custom) { mkdirSync(custom, { recursive: true }); return [custom]; }
	// Ask Dex for its effective config: `dex dir` ignores storage.file.path and centralized mode.
	const get = async (key: string) => { const v = (await pi.exec("dex", ["config", key], { cwd: ctx.cwd })).stdout.trim(); return v && v !== "(not set)" ? v : undefined; };
	const engine = await get("storage.engine");
	if (engine && engine !== "file") return; // non-file engines have nothing local to watch; panel keeps its event-based reloads
	const path = await get("storage.file.path");
	if (path) return [resolve(ctx.cwd, home(path))];
	// shortcut: watches every project's centralized store (slug comes from the git remote), so other projects' edits also trigger a reload.
	if ((await get("storage.file.mode")) === "centralized") return [join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "dex", "projects")];
	return [(await pi.exec("dex", ["dir"], { cwd: ctx.cwd })).stdout.trim()];
}
