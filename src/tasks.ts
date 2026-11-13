import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { checkName, clean, parseTodo, todoLine, toTask, type Task } from "./todo.ts";
import { withLock } from "./util.ts";

// Runs a list/export/import/create/start/complete/edit action against a pi-do JSONL todos file.
export function runFile(file: string, args: string[]): string | Promise<string> {
	const [action, value] = args;
	if (action !== "list" && action !== "export") mkdirSync(dirname(file), { recursive: true });
	return action === "list" || action === "export" ? mutate() : withLock(file, mutate);
	function mutate(): string {
	let items: Task[] = [], legacy = false;
	try {
		const data = readFileSync(file, "utf8");
		items = data.split("\n").flatMap((line, index) => {
			if (!line.trim()) return []; // blank lines (hand edits) are harmless
			let record: any;
			try { record = JSON.parse(line); } catch { throw new Error(`Invalid pi-do JSONL record on line ${index + 1}`); }
			// Pre-schema stores held {"todo": "<todo.txt line>"}; converted on the next write.
			if (record && typeof record.todo === "string" && Object.keys(record).length === 1 && record.todo.trim() && !/[\r\n]/.test(record.todo)) { legacy = true; record = parseTodo(record.todo, index); }
			try { return [toTask(record)]; } catch (error: any) { throw new Error(`Invalid pi-do JSONL record on line ${index + 1}: ${error.message}`); }
		});
	} catch (error: any) { if (error.code !== "ENOENT") throw error; }
	if (action === "export") return items.map((task) => todoLine(task) + "\n").join("");
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
		if (added || legacy) save();
		return `Imported ${added} tasks`;
	}
	if (action === "put") {
		// Sync writes a whole task (JSON in value): replace by id, or append.
		const task: Task = JSON.parse(value);
		checkName(task.name);
		const at = items.findIndex((item) => item.id === task.id);
		const old = items[at];
		// Adapters don't carry todo.txt-only fields, so keep the stored ones.
		const merged = { priority: old?.priority, created: old?.created, completed_date: old?.completed_date, ...task, started_at: task.started_at ?? null };
		merged.completed_date = merged.completed ? merged.completed_date || args[2] || today() : undefined;
		items[at < 0 ? items.length : at] = toTask(clean(merged));
		save();
		return `put: ${task.id}`;
	}
	// Walk option/value pairs by position so values that look like flags stay values.
	const options: Record<string, string> = {};
	for (let i = 2; i < args.length; i++) { if (args[i] === "--no-commit") continue; options[args[i]] = args[++i]; }
	const option = (key: string): string | undefined => options[key];
	let task: Task;
	let index = items.length;
	if (action === "create") {
		const parent = option("--parent");
		if (parent && !items.some((item) => item?.id === parent)) throw new Error(`Task not found: ${parent}`);
		task = { id: randomUUID(), name: value, completed: false, created: today(), started_at: null, description: option("--description"), parent };
	} else {
		index = items.findIndex((item) => item?.id === value);
		const found = items[index];
		if (!found) throw new Error(`Task not found: ${value}`);
		task = found;
		if (action === "start") task.started_at = new Date().toISOString();
		else if (action === "complete") { task.completed = true; task.completed_date ||= today(); task.result = option("--result"); }
		else if (action === "edit") { if (option("--name") !== undefined) task.name = option("--name")!; if (option("--description") !== undefined) task.description = option("--description"); }
		else throw new Error(`Unknown action: ${action}`);
	}
	if (action === "create" || (action === "edit" && option("--name") !== undefined)) checkName(task.name);
	items[index] = clean(task);
	save();
	return action === "create" ? `Created task ${task.id}` : `${action}: ${task.id}`;
	}
}
