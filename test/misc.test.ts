import { expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withLock } from "../src/util.ts";
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
	expect(readJsonl(`${dir}/torn.jsonl`, (r) => r)).toEqual([{ a: 1 }]);
	writeFileSync(`${dir}/bad.jsonl`, '{"a":1}\n{"b":\n');
	expect(() => readJsonl(`${dir}/bad.jsonl`, (r) => r)).toThrow("line 2");
	writeFileSync(`${dir}/p.jsonl`, '{"id":"a"}\n{"id":1}\n');
	expect(() => readJsonl(`${dir}/p.jsonl`, (r) => { if (typeof r.id !== "string") throw new Error("bad id"); return r.id; })).toThrow("line 2 of");
});


const lockFile = () => join(mkdtempSync(join(tmpdir(), "lock-")), "f");
const DEAD = 2147483646;

test("lock with a dead pid is taken over", async () => {
	const f = lockFile();
	writeFileSync(`${f}.lock`, `${DEAD}:x`);
	expect(await withLock(f, () => "ok")).toBe("ok");
});

test("lock held by a live pid times out naming the pid", async () => {
	const f = lockFile();
	writeFileSync(`${f}.lock`, `${process.pid}:x`);
	await expect(withLock(f, () => 1, 2)).rejects.toThrow(`pid ${process.pid}`);
	expect(readFileSync(`${f}.lock`, "utf8")).toBe(`${process.pid}:x`);
});

test("empty lock is taken over only once older than 5s", async () => {
	const f = lockFile();
	writeFileSync(`${f}.lock`, "");
	await expect(withLock(f, () => 1, 2)).rejects.toThrow("locked");
	const old = new Date(Date.now() - 6000);
	utimesSync(`${f}.lock`, old, old);
	expect(await withLock(f, () => "ok")).toBe("ok");
});

test("two waiters on a dead lock never overlap", async () => {
	const f = lockFile();
	writeFileSync(`${f}.lock`, `${DEAD}:x`);
	const log: string[] = [];
	const run = (n: string) => withLock(f, async () => { log.push(`${n}+`); await new Promise((r) => setTimeout(r, 50)); log.push(`${n}-`); });
	await Promise.all([run("a"), run("b")]);
	expect(log.length).toBe(4);
	expect(log[1]).toBe(log[0].replace("+", "-"));
	expect(log[3]).toBe(log[2].replace("+", "-"));
});

test("takeover restores a lock a new holder took mid-rename and does not run fn", async () => {
	const real = await import("node:fs");
	const f = lockFile(), lock = `${f}.lock`;
	writeFileSync(lock, `${DEAD}:x`);
	const { renameSync, writeFileSync: write } = real; // captured: the mock replaces the live module
	let armed = true;
	// a new live holder replaces the dead lock just before the waiter's rename
	mock.module("node:fs", () => ({ ...real, renameSync: (from: string, to: string) => { if (armed) { armed = false; write(lock, `${process.pid}:new`); } return renameSync(from, to); } }));
	const { withLock: locked } = await import("../src/util.ts" + "?restore");
	let ran = false;
	await expect(locked(f, () => { ran = true; }, 1)).rejects.toThrow("locked");
	expect(ran).toBe(false);
	expect(readFileSync(lock, "utf8")).toBe(`${process.pid}:new`);
});

import { runFile as rf } from "../src/tasks.ts";
import { tmpdir as td } from "node:os";
import { join as j } from "node:path";
test("short prefixed ids, prefix lookup, list query", async () => {
	const file = j(mkdtempSync(j(td(), "ids-")), "My-Proj.todos.jsonl");
	const a = (await rf(file, ["create", "Write spec", "--description", "link target"]) as string).match(/Created task (\S+)/)![1];
	expect(a).toMatch(/^mypr-[0-9a-f]{6}$/);
	const short = a.slice(5, 9);
	const b = (await rf(file, ["create", "Review", "--blocked-by", short]) as string).match(/Created task (\S+)/)![1];
	expect(JSON.parse(await rf(file, ["list"]) as string).find((t: any) => t.id === b).blocked_by).toEqual([a]);
	expect(await rf(file, ["start", short])).toContain(a);
	expect(() => rf(file, ["list", "--query", "zz"])).not.toThrow();
	expect(JSON.parse(await rf(file, ["list", "--query", "LINK"]) as string).map((t: any) => t.id)).toEqual([a]);
	await expect(rf(file, ["start", "mypr-"])).rejects.toThrow("Ambiguous task id");
	await expect(rf(file, ["start", "zzz"])).rejects.toThrow("Task not found: zzz");
});
