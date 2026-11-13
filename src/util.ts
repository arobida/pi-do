import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const home = (path: string) => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

export async function withLock<T>(file: string, fn: () => T | Promise<T>): Promise<T> {
	const lock = `${file}.lock`;
	for (let i = 0; ; i++) {
		try { writeFileSync(lock, String(process.pid), { flag: "wx" }); break; }
		catch (error: any) {
			if (error.code !== "EEXIST") throw error;
			// shortcut: a crashed holder's lock is treated as stale after 10s; fine for interactive use.
			try { if (Date.now() - statSync(lock).mtimeMs > 10_000) { unlinkSync(lock); continue; } } catch {}
			// ~11s of waiting: outlasts the 10s stale window so a waiter can clear a crashed holder's lock.
			if (i > 440) throw new Error(`Task file is locked: ${lock}`);
			await new Promise((r) => setTimeout(r, 25));
		}
	}
	try { return await fn(); } finally { try { unlinkSync(lock); } catch {} }
}

export function readJsonl(path: string): any[] {
	let data: string;
	try { data = readFileSync(path, "utf8"); }
	catch (error: any) { if (error.code === "ENOENT") return []; throw new Error(`Cannot read ${path}: ${error.message}`); }
	return data.split("\n").filter((line) => line.trim()).map((line, index) => {
		let record: any;
		try { record = JSON.parse(line); } catch { throw new Error(`Invalid JSON on line ${index + 1} of ${path}`); }
		if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`Invalid record on line ${index + 1} of ${path}`);
		return record;
	});
}
