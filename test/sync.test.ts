import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { sync } from "../src/adapters/sync.ts";
import { runFile } from "../src/tasks.ts";

const setup = () => {
	const dir = mkdtempSync(`${tmpdir()}/pi-do-sync-`), remote = new Map<string, any>(); let n = 0, failAt = -1, calls = 0;
	const adapter = { name: "fake", list: async () => [...remote.values()].map((t) => ({ ...t })), update: async () => {},
		create: async (t: any) => { if (++calls === failAt) throw new Error("boom"); const id = `r${n++}`; remote.set(id, { ...t, id }); return id; } };
	return { dir, file: `${dir}/t.jsonl`, remote, adapter, failOn: (i: number) => { failAt = i; calls = 0; } };
};

test("sync: links survive a failed create, no duplicates next time", async () => {
	const { dir, file, remote, adapter, failOn } = setup();
	try {
		await runFile(file, ["create", "a"]); await runFile(file, ["create", "b"]);
		failOn(2);
		await expect(sync(file, dir, adapter)).rejects.toThrow("boom");
		expect(readFileSync(`${dir}/sync/fake.jsonl`, "utf8").trim().split("\n")).toHaveLength(1);
		failOn(-1); await sync(file, dir, adapter);
		expect(remote.size).toBe(2);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sync: remote name like '- call mom' syncs in", async () => {
	const { dir, file, remote, adapter } = setup();
	try {
		remote.set("x", { id: "x", name: "- call mom", completed: false, started_at: null });
		await sync(file, dir, adapter);
		expect(JSON.parse(await runFile(file, ["list"]) as string)[0].name).toBe("- call mom");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("put: partial record keeps stored name", async () => {
	const { dir, file } = setup();
	try {
		const id = (await runFile(file, ["create", "keep"]) as string).match(/Created task (\S+)/)![1];
		await runFile(file, ["put", JSON.stringify({ id, completed: true })]);
		expect(JSON.parse(await runFile(file, ["list"]) as string)[0]).toMatchObject({ name: "keep", completed: true });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sync: field cleared remotely is cleared locally", async () => {
	const { dir, file, remote, adapter } = setup();
	try {
		await runFile(file, ["create", "a", "--description", "details"]);
		await sync(file, dir, adapter);
		const [r] = remote.values(); expect(r.description).toBe("details"); delete r.description;
		await sync(file, dir, adapter);
		expect(JSON.parse(await runFile(file, ["list"]) as string)[0].description).toBeUndefined();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("export: names todo.txt would misread are skipped and reported, rest export", async () => {
	const { dir, file } = setup();
	try {
		await runFile(file, ["create", "fine"]);
		await runFile(file, ["put", JSON.stringify({ id: "bad", name: "x marks", completed: false, started_at: null })]);
		const { text, skipped } = JSON.parse(await runFile(file, ["export"]) as string);
		expect(text).toContain("fine"); expect(text).not.toContain("x marks");
		expect(skipped).toEqual(["#bad x marks"]);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("put/import: missing parent rejected, cycle rejected on put", async () => {
	const { dir, file } = setup();
	try {
		await expect(runFile(file, ["put", JSON.stringify({ id: "a", name: "a", completed: false, started_at: null, parent: "nope" })])).rejects.toThrow("Parent task not found");
		await expect(runFile(file, ["import", "a piparent:nope piid:a"])).rejects.toThrow("Parent task not found");
		await runFile(file, ["put", JSON.stringify({ id: "a", name: "a", completed: false, started_at: null })]);
		await runFile(file, ["put", JSON.stringify({ id: "b", name: "b", completed: false, started_at: null, parent: "a" })]);
		await expect(runFile(file, ["put", JSON.stringify({ id: "a", parent: "b" })])).rejects.toThrow("Parent cycle");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sync: remote parent cycle still finishes, rejected parent not stored", async () => {
	const { dir, file, remote, adapter } = setup();
	try {
		remote.set("x", { id: "x", name: "x", completed: false, started_at: null, parent: "y" });
		remote.set("y", { id: "y", name: "y", completed: false, started_at: null, parent: "x" });
		remote.set("z", { id: "z", name: "z", completed: false, started_at: null });
		await sync(file, dir, adapter);
		const list = JSON.parse(await runFile(file, ["list"]) as string);
		expect(list).toHaveLength(3);
		expect(list.filter((t: any) => t.parent)).toHaveLength(1);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("sync: linked task with dangling parent takes remote update and parent is cleared", async () => {
	const { dir, file, remote, adapter } = setup();
	try {
		await runFile(file, ["create", "a"]); await sync(file, dir, adapter);
		const [r] = remote.values(); r.name = "renamed";
		const rows = JSON.parse(await runFile(file, ["list"]) as string);
		writeFileSync(file, JSON.stringify({ ...rows[0], parent: "ghost" }) + "\n");
		await sync(file, dir, adapter);
		const [t] = JSON.parse(await runFile(file, ["list"]) as string);
		expect(t.name).toBe("renamed"); expect(t.parent).toBeUndefined();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claims: refused for another live claimer, force overrides, dead pid ignored, complete clears, release scoped", async () => {
	const { dir, file } = setup();
	try {
		const mk = async (n: string) => (await runFile(file, ["create", n]) as string).match(/Created task (\S+)/)![1];
		const [a, b] = [await mk("a"), await mk("b")];
		const mine = `s1:${process.pid}`, other = `s2:${process.pid}`;
		const get = async (id: string) => JSON.parse(await runFile(file, ["list"]) as string).find((t: any) => t.id === id);
		await runFile(file, ["start", a, "--claim", mine]);
		expect((await get(a)).claimed_by).toBe(mine);
		expect(() => runFile(file, ["start", a, "--claim", other])).toThrow("claimed by");
		expect(() => runFile(file, ["complete", a, "--claim", other])).toThrow("claimed by");
		await runFile(file, ["start", a, "--claim", other, "--force"]);
		expect((await get(a)).claimed_by).toBe(other);
		await runFile(file, ["start", b, "--claim", "s3:2147483646"]);
		await runFile(file, ["start", a, "--claim", mine, "--force"]);
		await runFile(file, ["start", b, "--claim", mine]); // dead pid claim ignored
		await runFile(file, ["release", "--claim", "s9:1"]);
		expect((await get(a)).claimed_by).toBe(mine);
		await runFile(file, ["complete", a, "--claim", mine]);
		expect((await get(a)).claimed_by).toBeUndefined();
		await runFile(file, ["release", "--claim", mine]);
		expect((await get(b)).claimed_by).toBeUndefined();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("claims: survive a sync pull and never reach adapter.create", async () => {
	const { dir, file, remote, adapter } = setup();
	try {
		const id = (await runFile(file, ["create", "a"]) as string).match(/Created task (\S+)/)![1];
		await runFile(file, ["start", id, "--claim", "s1:1"]);
		await sync(file, dir, adapter);
		expect([...remote.values()][0].claimed_by).toBeUndefined();
		[...remote.values()][0].name = "renamed";
		await sync(file, dir, adapter);
		expect(JSON.parse(await runFile(file, ["list"]) as string)[0]).toMatchObject({ name: "renamed", claimed_by: "s1:1" });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("blocked_by: ready query, claims, self/cycle rejected, multiple, clear", async () => {
	const { dir, file } = setup();
	try {
		const mk = async (n: string, ...o: string[]) => (await runFile(file, ["create", n, ...o]) as string).match(/Created task (\S+)/)![1];
		const ready = async () => JSON.parse(await runFile(file, ["ready"]) as string).map((t: any) => t.id);
		const list = async () => JSON.parse(await runFile(file, ["list"]) as string);
		const a = await mk("a"), b = await mk("b", "--blocked-by", a);
		expect(await ready()).toEqual([a]);
		await runFile(file, ["complete", a]);
		expect(await ready()).toEqual([b]);
		await runFile(file, ["start", b, "--claim", `s1:${process.pid}`]);
		expect(await ready()).toEqual([]);
		const c = await mk("c"), d = await mk("d");
		expect(() => runFile(file, ["edit", c, "--blocked-by", c])).toThrow("cycle");
		await runFile(file, ["edit", c, "--blocked-by", d]);
		expect(() => runFile(file, ["edit", d, "--blocked-by", c])).toThrow("cycle");
		expect(() => runFile(file, ["edit", d, "--blocked-by", "nope"])).toThrow("not found");
		const e = await mk("e", "--blocked-by", `${c},${d}`);
		expect((await list()).find((t: any) => t.id === e).blocked_by).toEqual([c, d]);
		expect(await ready()).toEqual([d]);
		await runFile(file, ["edit", e, "--blocked-by", ""]);
		expect((await list()).find((t: any) => t.id === e).blocked_by).toBeUndefined();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
