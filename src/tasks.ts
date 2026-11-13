import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { checkName, clean, parseTodo, todoLine, toTask, type Task } from "./todo.ts";
import { isAlive, withLock } from "./util.ts";

export class ParentError extends Error {}
// A parent must exist and must not be the task itself or one of its descendants.
function checkParent(items: Task[], id: string, parent?: string) {
	const seen = new Set<string>();
	for (let p = parent; p; p = items.find((item) => item.id === p)?.parent) {
		if (p === id || seen.has(p)) throw new ParentError(`Parent cycle: ${parent} is or descends from ${id}`);
		seen.add(p);
		if (!items.some((item) => item.id === p)) throw new ParentError(`Parent task not found: ${p} (parent must be an existing task id; put details in description)`);
	}
}

// Runs a list/export/import/create/start/complete/edit action against a pi-do JSONL todos file.
export function runFile(file: string, args: string[]): string | Promise<string> {
	const [action, value] = args;
	if (action !== "list" && action !== "export") mkdirSync(dirname(file), { recursive: true });
	return action === "list" || action === "export" ? mutate() : withLock(file, mutate);
	function mutate(): string {
	let items: Task[] = [];
	try {
		const data = readFileSync(file, "utf8");
		items = data.split("\n").flatMap((line, index) => {
			if (!line.trim()) return []; // blank lines (hand edits) are harmless
			let record: any;
			try { record = JSON.parse(line); } catch { throw new Error(`Invalid pi-do JSONL record on line ${index + 1}`); }
			try { return [toTask(record)]; } catch (error: any) { throw new Error(`Invalid pi-do JSONL record on line ${index + 1}: ${error.message}`); }
		});
	} catch (error: any) { if (error.code !== "ENOENT") throw error; }
	if (action === "export") {
		// Tasks todo.txt can't hold unchanged are left out and named, so the rest still export.
		const skipped: string[] = [];
		const text = items.flatMap((task) => { try { return [todoLine(task) + "\n"]; } catch { skipped.push(`#${task.id} ${task.name}`); return []; } }).join("");
		return JSON.stringify({ text, skipped });
	}
	if (action === "list") return JSON.stringify(items);
	const save = () => { const temp = `${file}.${randomUUID()}.tmp`; writeFileSync(temp, items.map((task) => JSON.stringify(clean(task)) + "\n").join(""), { mode: 0o600 }); renameSync(temp, file); };
	const today = () => new Date().toISOString().slice(0, 10);
	if (action === "import") {
		// Each todo.txt line becomes one record; lines whose piid already exists are skipped.
		const ids = new Set(items.map((item) => item.id));
		let added = 0, n = 0;
		for (const line of value.split(/\r?\n/)) {
			n++;
			if (!line.trim()) continue;
			let task: Task;
			// Validate every line before saving anything, so a bad file imports nothing.
			try { task = parseTodo(line); } catch (error: any) { throw new Error(`Invalid todo.txt line ${n}: ${error.message}`); }
			if (ids.has(task.id)) continue;
			ids.add(task.id); items.push(task); added++;
		}
		// Only new tasks: an old dangling parent must not block every future import.
		for (const task of items.slice(items.length - added)) checkParent(items, task.id, task.parent);
		if (added) save();
		return `Imported ${added} tasks`;
	}
	if (action === "put") {
		// Sync writes a whole task (JSON in value): replace by id, or append.
		const task: Task = JSON.parse(value);
		const at = items.findIndex((item) => item.id === task.id);
		const old = items[at];
		// Partial merge: a stale snapshot only overwrites the fields it carries ("" clears one); todo.txt-only fields stay.
		const merged: any = { ...old, ...task };
		merged.started_at ??= null;
		merged.completed_date = merged.completed ? merged.completed_date || today() : undefined;
		checkParent(items, merged.id, merged.parent);
		items[at < 0 ? items.length : at] = toTask(clean(merged));
		save();
		return `put: ${task.id}`;
	}
	// Walk option/value pairs by position so values that look like flags stay values.
	const options: Record<string, string> = {};
	for (let i = action === "release" ? 1 : 2; i < args.length; i++) { if (args[i] === "--no-commit" || args[i] === "--force") { options[args[i]] = "1"; continue; } options[args[i]] = args[++i]; }
	const option = (key: string): string | undefined => options[key];
	if (action === "release") {
		// Clears every claim equal to --claim (session end).
		for (const item of items) if (item.claimed_by === option("--claim")) delete item.claimed_by;
		save();
		return "release";
	}
	let task: Task;
	let index = items.length;
	if (action === "create") {
		const parent = option("--parent");
		checkParent(items, "", parent);
		task = { id: randomUUID(), name: value, completed: false, created: today(), started_at: null, description: option("--description"), parent };
	} else {
		index = items.findIndex((item) => item?.id === value);
		const found = items[index];
		if (!found) throw new Error(`Task not found: ${value}`);
		task = found;
		const claim = option("--claim"), owner = found.claimed_by;
		// shortcut: a reused pid keeps a claim looking live until --force or release; upgrade by storing a process start time.
		if ((action === "start" || action === "complete") && claim && owner && owner !== claim && isAlive(Number(owner.split(":").pop())) && !option("--force")) throw new Error(`Task ${value} is claimed by ${owner}; pass force to override`);
		if (action === "start") { task.started_at = new Date().toISOString(); if (claim) task.claimed_by = claim; }
		else if (action === "complete") { task.claimed_by = undefined; task.completed = true; task.completed_date ||= today(); task.result = option("--result"); }
		else if (action === "edit") { if (option("--name") !== undefined) task.name = option("--name")!; if (option("--description") !== undefined) task.description = option("--description"); }
		else throw new Error(`Unknown action: ${action}`);
	}
	if (action === "create" || (action === "edit" && option("--name") !== undefined)) checkName(task.name);
	items[index] = clean(task);
	save();
	return action === "create" ? `Created task ${task.id}` : `${action}: ${task.id}`;
	}
}
