import { createHash } from "node:crypto";

// One JSONL record per task. todo.txt fields get their own keys; +projects, @contexts and other key:value tags stay in name (todo.txt description).
export interface Task {
	id: string;
	name: string;
	completed: boolean;
	priority?: string; // A-Z
	created?: string; // YYYY-MM-DD
	completed_date?: string; // YYYY-MM-DD
	started_at: string | null;
	description?: string;
	parent?: string;
	result?: string;
}

const date = /^\d{4}-\d{2}-\d{2}$/;
const optional = ["priority", "created", "completed_date", "description", "parent", "result"] as const;

// Validates a parsed JSONL record and returns it as a Task; unknown keys are rejected so typos never pass silently.
export function toTask(record: any): Task {
	if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("not an object");
	for (const key of Object.keys(record)) if (!["id", "name", "completed", "started_at", ...optional].includes(key)) throw new Error(`unknown key ${key}`);
	if (typeof record.id !== "string" || !record.id) throw new Error("bad id");
	if (typeof record.name !== "string" || !record.name.trim() || /[\r\n]/.test(record.name)) throw new Error("bad name");
	if (typeof record.completed !== "boolean") throw new Error("bad completed");
	if (record.started_at !== null && typeof record.started_at !== "string") throw new Error("bad started_at");
	for (const key of optional) if (record[key] !== undefined && typeof record[key] !== "string") throw new Error(`bad ${key}`);
	if (record.priority !== undefined && !/^[A-Z]$/.test(record.priority)) throw new Error("bad priority");
	for (const key of ["created", "completed_date"] as const) if (record[key] !== undefined && !date.test(record[key])) throw new Error(`bad ${key}`);
	return record;
}

// Drops empty optional fields so records stay minimal and stable.
// Keys are written in schema order so every record reads the same.
const order = ["id", "name", "completed", "priority", "created", "completed_date", "started_at", "description", "parent", "result"];
export const clean = (task: Task): Task => Object.fromEntries(Object.entries(task).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).filter(([key, value]) => value !== undefined && (value !== "" || key === "name"))) as Task;

// Parses one todo.txt line (import, legacy {"todo": ...} records). Legacy ids keep their line index so existing sync links still match.
export function parseTodo(line: string, index?: number): Task {
	const meta: Record<string, string> = {};
	let body = line.replace(/(?:^|\s)(piid|pistart|pidesc|piparent|piresult|pri):([^\s:]+)/g, (match, key, value) => {
		if (key === "pri" && !/^[A-Z]$/.test(value)) return match;
		try { meta[key] = decodeURIComponent(value); return ""; } catch { return match; }
	}).trim();
	const done = body.match(/^x\s+(?:(\d{4}-\d{2}-\d{2})\s+)?/);
	if (done) body = body.slice(done[0].length);
	const pri = done ? undefined : body.match(/^\(([A-Z])\)\s+/);
	if (pri) body = body.slice(pri[0].length);
	const created = body.match(/^(\d{4}-\d{2}-\d{2})\s+/);
	if (created) body = body.slice(created[0].length);
	return toTask(clean({
		id: meta.piid || `line-${index === undefined ? "" : `${index + 1}-`}${createHash("sha256").update(line).digest("hex").slice(0, 12)}`,
		name: body, completed: !!done, priority: pri?.[1] ?? meta.pri, created: created?.[1], completed_date: done?.[1],
		started_at: meta.pistart || null, description: meta.pidesc, parent: meta.piparent, result: meta.piresult,
	}));
}

// Renders a task as a todo.txt line (export). Completed tasks move priority to pri: per the todo.txt spec.
export function todoLine(task: Task): string {
	const head = task.completed ? ["x", task.completed_date] : [task.priority && `(${task.priority})`];
	const tags = Object.entries({ pri: task.completed ? task.priority : undefined, piid: task.id, pistart: task.started_at, pidesc: task.description, piparent: task.parent, piresult: task.result })
		.filter(([, value]) => typeof value === "string" && value !== "").map(([key, value]) => `${key}:${encodeURIComponent(value as string)}`);
	const line = [...head, task.created, task.name.trim(), ...tags].filter(Boolean).join(" ");
	// todo.txt has no escape, so a name that reads back as a marker (x, (A), date) must be refused rather than exported wrong.
	const back = parseTodo(line);
	if (back.name !== task.name.trim() || back.completed !== task.completed) throw new Error(`Task ${task.id} name cannot be exported to todo.txt without changing it: ${task.name}`);
	return line;
}

// Names must survive a todo.txt export/import round trip and must not reach Dex as a flag.
export function checkName(name: string) {
	if (/[\r\n]/.test(name) || !name.trim()) throw new Error("Task name must be a non-empty single line");
	if (/^\s*x\s/.test(name)) throw new Error('Task name must not start with "x " (todo.txt completion marker)');
	if (/^\s*-/.test(name)) throw new Error('Task name must not start with "-"');
	if (/(?:^|\s)pi(?:id|start|desc|parent|result):/.test(name)) throw new Error("Task name must not contain pi-do metadata tokens (piid:, pistart:, pidesc:, piparent:, piresult:)");
}
