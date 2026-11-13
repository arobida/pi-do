import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Task } from "../../todo.ts";
import type { Adapter } from "../sync.ts";
import { piDoHome } from "../../store.ts";

// The auth token is a secret: kept in ~/.pi-do/adapters/things.json (0600), never in a config.json that may be committed.
const tokenFile = () => join(piDoHome(), "adapters", "things.json");
export function saveThingsToken(token: string): string {
	if (!/^[\w-]+$/.test(token)) throw new Error("Invalid Things auth token");
	mkdirSync(join(piDoHome(), "adapters"), { recursive: true });
	writeFileSync(tokenFile(), JSON.stringify({ token }) + "\n", { mode: 0o600 });
	chmodSync(tokenFile(), 0o600);
	return `Saved Things auth token to ${tokenFile()}`;
}
function token(): string {
	if (process.env.PI_DO_THINGS_TOKEN) return process.env.PI_DO_THINGS_TOKEN;
	try { return JSON.parse(readFileSync(tokenFile(), "utf8")).token; }
	catch { throw new Error("Things auth token missing: run /todos connect things <token>"); }
}

// Marks a new to-do's notes so the next read can find its Things id (the URL scheme cannot return it to a CLI).
const marker = /\n*\[pi-do:([\w-]+)\]\s*$/;
// The URL scheme writes but cannot read, so reads go through Things' AppleScript dictionary (JXA).
// Each pi-do project syncs with the Things project of the same name; the name is passed as argv, never spliced into code.
const LIST = `function run([name]) { const p = Application("Things3").projects.whose({ name })(); return p.length ? JSON.stringify(p[0].toDos().map(t => ({ id: t.id(), name: t.name(), notes: t.notes(), status: t.status() }))) : "null"; }`;

export function thingsAdapter(pi: ExtensionAPI, project: string): Adapter {
	if (process.platform !== "darwin") throw new Error("Things adapter needs macOS");
	const open = async (command: string, params: Record<string, string | undefined>) => {
		const query = Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join("&");
		const r = await pi.exec("open", ["-g", `things:///${command}?${query}`]);
		if (r.code !== 0) throw new Error(r.stderr || `open exited ${r.code}`);
	};
	const read = async () => {
		const r = await pi.exec("osascript", ["-l", "JavaScript", "-e", LIST, project]);
		if (r.code !== 0) throw new Error(r.stderr || `osascript exited ${r.code}`);
		const data = JSON.parse(r.stdout);
		if (data === null) return null; // project not created yet
		if (!Array.isArray(data)) throw new Error("Invalid Things to-do list");
		return data as { id: string; name: string; notes: string; status: string }[];
	};
	return {
		name: "things",
		fields: ["name", "description", "completed"],
		async list() {
			return ((await read()) ?? []).filter((t) => t.status !== "canceled" && t.name.trim()).map((t) => ({ id: t.id, name: t.name.replace(/[\r\n]+/g, " ").trim(), description: t.notes.replace(marker, "") || undefined, completed: t.status === "completed", started_at: null }));
		},
		async create(task) {
			const auth = token(); // fail before adding, so a missing token can't leave an unlinked to-do
			const key = randomUUID();
			if (!(await read())) {
				await open("add-project", { title: project });
				// Wait for the project, or the to-do below would land in the Inbox.
				for (let i = 0; i < 20 && !(await read()); i++) await new Promise((r) => setTimeout(r, 250));
				if (!(await read())) throw new Error(`Things did not create project "${project}"`);
			}
			await open("add", { list: project, title: task.name, notes: `${task.description ?? ""}\n\n[pi-do:${key}]`, completed: task.completed ? "true" : undefined });
			// shortcut: polls up to ~5s for Things to save the new to-do; a slower Things fails this sync and retries later (possible duplicate).
			for (let i = 0; i < 20; i++) {
				const found = ((await read()) ?? []).find((t) => t.notes.match(marker)?.[1] === key);
				if (found) { await open("update", { id: found.id, "auth-token": auth, notes: task.description ?? "" }); return found.id; }
				await new Promise((r) => setTimeout(r, 250));
			}
			throw new Error(`Things did not save "${task.name}"`);
		},
		async update(id, patch) {
			// Diff against Things' current state and send only real changes, so a repeated or overlapping sync is a no-op.
			const cur = ((await read()) ?? []).find((t) => t.id === id);
			const params = { title: patch.name, notes: "description" in patch ? patch.description ?? "" : undefined, completed: patch.completed === undefined ? undefined : String(patch.completed) };
			if (cur) { if (params.title === cur.name) params.title = undefined; if (params.notes === cur.notes.replace(marker, "")) params.notes = undefined; if (params.completed === String(cur.status === "completed")) params.completed = undefined; }
			if (Object.values(params).every((v) => v === undefined)) return;
			await open("update", { id, "auth-token": token(), ...params });
		},
	};
}
