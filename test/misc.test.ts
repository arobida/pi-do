import { expect, test } from "bun:test";
import { parseTodo, todoLine, type Task } from "../src/todo.ts";

const base = { id: "T1", started_at: null } as const;
const cases: [string, Partial<Task>][] = [
	["x marks", { created: "2026-01-01" }],
	["(B) foo", { created: "2026-01-01" }],
	["2026-01-01 foo", { created: "2026-01-01" }],
	["x marks", { completed: true, completed_date: "2026-02-01", created: "2026-01-01" }],
	["(B) foo", { completed: true, completed_date: "2026-02-01", created: "2026-01-01" }],
	["2026-01-01 foo", { completed: true, completed_date: "2026-02-01", created: "2026-01-01" }],
	["plain", { completed: true, completed_date: "2026-02-01" }],
	["plain", { priority: "A", created: "2026-01-01" }],
];

for (const [name, extra] of cases) {
	test(`round trip ${JSON.stringify(name)} ${JSON.stringify(extra)}`, () => {
		const task: Task = { ...base, name, completed: false, ...extra };
		const back = parseTodo(todoLine(task));
		expect(back.name).toBe(name);
		expect(back.completed).toBe(!!task.completed);
	});
}

test("names that would read back as markers without a created date are refused", () => {
	expect(() => todoLine({ ...base, name: "x marks", completed: false })).toThrow("cannot be exported");
	expect(() => todoLine({ ...base, name: "(B) foo", completed: false })).toThrow("cannot be exported");
	expect(() => todoLine({ ...base, name: "2026-01-01 foo", completed: false })).toThrow("cannot be exported");
});

test("readJsonl drops only an unterminated torn last line", async () => {
	const { readJsonl } = await import("../src/util.ts");
	const { mkdtempSync, writeFileSync } = await import("node:fs");
	const dir = mkdtempSync(`${require("node:os").tmpdir()}/pido-`);
	writeFileSync(`${dir}/torn.jsonl`, '{"a":1}\n{"b":');
	expect(readJsonl(`${dir}/torn.jsonl`)).toEqual([{ a: 1 }]);
	writeFileSync(`${dir}/bad.jsonl`, '{"a":1}\n{"b":\n');
	expect(() => readJsonl(`${dir}/bad.jsonl`)).toThrow("line 2");
});
