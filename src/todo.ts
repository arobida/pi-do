import { createHash } from "node:crypto";

export interface Task {
	id: string;
	name: string;
	completed: boolean;
	started_at: string | null;
	description?: string;
	parent?: string;
	result?: string;
}

export function parseTodo(line: string, index: number): Task {
	const meta: Record<string, string> = {};
	const body = line.replace(/(?:^|\s)(piid|pistart|pidesc|piparent|piresult):([^\s:]+)/g, (match, key, value) => {
		try { meta[key] = decodeURIComponent(value); return ""; } catch { return match; }
	}).trim();
	const completed = /^x\s/.test(body);
	return { id: meta.piid || `line-${index + 1}-${createHash("sha256").update(line).digest("hex").slice(0, 12)}`, name: completed ? body.replace(/^x\s+(?:\d{4}-\d{2}-\d{2}\s+)?/, "") : body, completed, started_at: meta.pistart || null, description: meta.pidesc, parent: meta.piparent, result: meta.piresult };
}

export function todoLine(task: Task, date: string | undefined): string {
	let name = task.name.trim();
	if (task.completed && /^\([A-Z]\)\s/.test(name)) name = name.replace(/^\(([A-Z])\)\s+/, "") + ` pri:${name[1]}`;
	const metadata = Object.entries({ piid: task.id, pistart: task.started_at, pidesc: task.description, piparent: task.parent, piresult: task.result })
		.filter(([, value]) => typeof value === "string" && value !== "").map(([key, value]) => `${key}:${encodeURIComponent(value as string)}`);
	return `${task.completed ? `x ${date} ` : ""}${name} ${metadata.join(" ")}`;
}

// Names are stored as todo.txt text, so reject what would read back differently or reach Dex as a flag.
export function checkName(name: string) {
	if (/[\r\n]/.test(name) || !name.trim()) throw new Error("Task name must be a non-empty single line");
	if (/^\s*x\s/.test(name)) throw new Error('Task name must not start with "x " (todo.txt completion marker)');
	if (/^\s*-/.test(name)) throw new Error('Task name must not start with "-"');
	if (/(?:^|\s)pi(?:id|start|desc|parent|result):/.test(name)) throw new Error("Task name must not contain pi-do metadata tokens (piid:, pistart:, pidesc:, piparent:, piresult:)");
}
