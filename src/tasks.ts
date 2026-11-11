import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { checkName, parseTodo, todoLine, type Task } from "./todo.ts";
import { withLock } from "./util.ts";

// Runs a list/export/import/create/start/complete/edit action against a pi-do JSONL todos file.
export function runFile(file: string, args: string[]): string | Promise<string> {
	const [action, value] = args;
	if (action !== "list" && action !== "export") mkdirSync(dirname(file), { recursive: true });
	return action === "list" || action === "export" ? mutate() : withLock(file, mutate);
	function mutate(): string {
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
	if (action === "list") return JSON.stringify(items);
	const save = () => { const temp = `${file}.${randomUUID()}.tmp`; writeFileSync(temp, lines.map((todo) => JSON.stringify({ todo })).join("\n") + "\n", { mode: 0o600 }); renameSync(temp, file); };
	if (action === "import") {
		// todo.txt lines are stored verbatim (1:1); skip lines already present or whose piid already exists.
		const ids = new Set(items.map((item) => item.id));
		let added = 0;
		for (const line of value.split(/\r?\n/)) {
			if (!line.trim() || lines.includes(line)) continue;
			const task = parseTodo(line, lines.length);
			if (ids.has(task.id)) continue;
			ids.add(task.id); lines.push(line); added++;
		}
		if (added) save();
		return `Imported ${added} tasks`;
	}
	if (action === "put") {
		// Sync writes a whole task (JSON in value): replace by id, or append.
		const task: Task = JSON.parse(value);
		checkName(task.name);
		const at = items.findIndex((item) => item.id === task.id);
		const i = at < 0 ? lines.length : at;
		lines[i] = todoLine(task, lines[i]?.match(/^x\s+(\d{4}-\d{2}-\d{2})\s/)?.[1] || args[2] || new Date().toISOString().slice(0, 10));
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
	if (action === "create" || (action === "edit" && option("--name") !== undefined)) checkName(task.name);
	const completionDate = lines[index]?.match(/^x\s+(\d{4}-\d{2}-\d{2})\s/)?.[1] || new Date().toISOString().slice(0, 10);
	lines[index] = todoLine(task, completionDate);
	save();
	return action === "create" ? `Created task ${task.id}` : `${action}: ${task.id}`;
	}
}
