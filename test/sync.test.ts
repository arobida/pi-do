import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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
		const id = (await runFile(file, ["create", "keep"]) as string).split(" ").pop()!;
		await runFile(file, ["put", JSON.stringify({ id, completed: true })]);
		expect(JSON.parse(await runFile(file, ["list"]) as string)[0]).toMatchObject({ name: "keep", completed: true });
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
