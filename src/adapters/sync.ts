import { join } from "node:path";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { type Task, toTask } from "../todo.ts";
import { randomUUID } from "node:crypto";
import { readJsonl, withLock } from "../util.ts";
import { ParentError, runFile } from "../tasks.ts";

// An external todo app. Tasks use pi-do's shape; ids are the app's own.
export interface Adapter {
	name: string;
	// Fields the app can hold; others are neither pushed nor pulled. Default: all.
	fields?: readonly (typeof fields)[number][];
	list(): Promise<Task[]>;
	create(task: Task): Promise<string>;
	update(id: string, patch: Partial<Task>): Promise<void>;
}

// Each link remembers both ids and the task as of the last sync, so a 3-way compare tells which side changed.
interface Link { local: string; remote: string; base: Task }
const toLink = (r: Record<string, unknown>): Link => {
	if (typeof r.local !== "string" || typeof r.remote !== "string") throw new Error("bad link ids");
	return { local: r.local, remote: r.remote, base: toTask(r.base) };
};
const fields = ["name", "description", "completed", "started_at", "result", "parent"] as const;

// Two-way sync of the pi-do todos file with one adapter. Per field: only one side changed -> copy it; both -> pi-do wins.
// Deletions are never propagated: a task missing on one side just stays unlinked-but-remembered.
export async function sync(file: string, base: string, adapter: Adapter): Promise<void> {
	const linksFile = join(base, "sync", `${adapter.name}.jsonl`);
	mkdirSync(join(base, "sync"), { recursive: true });
	return withLock(linksFile, async () => {
	const links = readJsonl(linksFile, toLink);
	// Links are saved even if a later step throws, so created tasks are never duplicated next sync.
	try {
	const local: Task[] = JSON.parse(await runFile(file, ["list"]));
	const remote = await adapter.list();
	const byLocal = new Map(local.map((t) => [t.id, t])), byRemote = new Map(remote.map((t) => [t.id, t]));
	const toRemote = new Map(links.map((l) => [l.local, l.remote])), toLocal = new Map(links.map((l) => [l.remote, l.local]));
	const norm = (t: Task): Task => ({ id: t.id, name: t.name, completed: t.completed, started_at: t.started_at ?? null, description: t.description || undefined, parent: t.parent || undefined, result: t.result || undefined });
	// A rejected parent is cleared ("" overrides the stored value) so one bad link doesn't abort the sync. Returns the saved record.
	const put = async (t: Task): Promise<Task> => {
		try { await runFile(file, ["put", JSON.stringify(t)]); } catch (e) { if (!(e instanceof ParentError)) throw e; await runFile(file, ["put", JSON.stringify({ ...t, parent: "" })]); }
		return norm(JSON.parse(await runFile(file, ["list"]) as string).find((x: Task) => x.id === t.id));
	};
	// Parents first, so a child's parent is already linked when it is created.
	const depth = (t: Task, m: Map<string, Task>, n = 0): number => t.parent && m.has(t.parent) && n < 50 ? depth(m.get(t.parent)!, m, n + 1) + 1 : 0;
	for (const t of [...local].sort((a, b) => depth(a, byLocal) - depth(b, byLocal))) {
		if (toRemote.has(t.id)) continue;
		const id = await adapter.create({ ...t, parent: t.parent && toRemote.get(t.parent) });
		toRemote.set(t.id, id); toLocal.set(id, t.id);
		links.push({ local: t.id, remote: id, base: norm(t) });
	}
	for (const r of [...remote].sort((a, b) => depth(a, byRemote) - depth(b, byRemote))) {
		if (toLocal.has(r.id)) continue;
		const t = norm({ ...r, id: crypto.randomUUID(), parent: r.parent && toLocal.get(r.parent) });
		const saved = await put(t);
		toRemote.set(t.id, r.id); toLocal.set(r.id, t.id);
		links.push({ local: t.id, remote: r.id, base: saved });
	}
	for (const link of links) {
		const l = byLocal.get(link.local), r = byRemote.get(link.remote);
		if (!l || !r) continue;
		const lv = norm(l), rv = norm({ ...r, id: l.id, parent: r.parent && toLocal.get(r.parent) }), b = link.base;
		const push: Partial<Task> = {}, pull: Partial<Task> = {};
		for (const f of adapter.fields ?? fields) {
			// Skip values the remote already has, so adapters needn't re-read to avoid no-op writes.
			if (lv[f] !== b[f]) { if (lv[f] !== rv[f]) (push as Record<string, unknown>)[f] = lv[f]; }
			else if (rv[f] !== b[f]) (pull as Record<string, unknown>)[f] = rv[f];
		}
		if (Object.keys(push).length) await adapter.update(r.id, { ...push, parent: push.parent && toRemote.get(push.parent), result: lv.result });
		link.base = Object.keys(pull).length ? await put({ id: lv.id, ...Object.fromEntries(Object.entries(pull).map(([k, v]) => [k, v ?? ""])) } as Task) : { ...lv };
	}
	} finally {
		const temp = `${linksFile}.${randomUUID()}.tmp`;
		writeFileSync(temp, links.map((l) => JSON.stringify(l)).join("\n") + "\n");
		renameSync(temp, linksFile);
	}
	});
}
