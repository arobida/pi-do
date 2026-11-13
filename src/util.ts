import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const home = (path: string) => path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

export function isAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error: any) { return error.code !== "ESRCH"; }
}

// A lock holds "<pid>:<token>"; it is stale when that pid is dead. tries * 25ms is the wait limit (~11s).
export async function withLock<T>(file: string, fn: () => T | Promise<T>, tries = 440): Promise<T> {
	const lock = `${file}.lock`;
	const mine = `${process.pid}:${randomUUID()}`;
	for (let i = 0; ; i++) {
		try { writeFileSync(lock, mine, { flag: "wx" }); break; }
		catch (error: any) {
			if (error.code !== "EEXIST") throw error;
			let seen: string, pid: number | undefined;
			try {
				seen = readFileSync(lock, "utf8");
				pid = /^(\d+):./.test(seen) ? Number(seen.split(":")[0]) : undefined;
				// an empty or malformed lock may be mid-write: stale only once it is 5s old.
				if (pid === undefined ? Date.now() - statSync(lock).mtimeMs > 5_000 : !isAlive(pid)) {
					// rename is atomic, so one waiter wins; if it moved a new holder's lock, put it back.
					const stale = `${lock}.${randomUUID()}.stale`;
					renameSync(lock, stale);
					try { if (readFileSync(stale, "utf8") !== seen) linkSync(stale, lock); } catch {}
					try { unlinkSync(stale); } catch {}
					continue;
				}
			} catch {}
			if (i >= tries) throw new Error(`Task file is locked: ${lock} (held by pid ${pid ?? "unknown"}). If that pid is not a pi-do process, delete the file.`);
			await new Promise((r) => setTimeout(r, 25));
		}
	}
	try { return await fn(); }
	finally { try { if (readFileSync(lock, "utf8") === mine) unlinkSync(lock); } catch {} }
}

// check validates each record and gives it its type; it throws on a bad record.
export function readJsonl<T>(path: string, check: (record: Record<string, unknown>) => T): T[] {
	let data: string;
	try { data = readFileSync(path, "utf8"); }
	catch (error: any) { if (error.code === "ENOENT") return []; throw new Error(`Cannot read ${path}: ${error.message}`); }
	const lines = data.split("\n").filter((line) => line.trim());
	return lines.flatMap((line, index) => {
		let record: any;
		try { record = JSON.parse(line); } catch {
			// A crash mid-append leaves an unterminated last line; drop it rather than refuse the whole file.
			if (index === lines.length - 1 && !data.endsWith("\n")) return [];
			throw new Error(`Invalid JSON on line ${index + 1} of ${path}`);
		}
		if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error(`Invalid record on line ${index + 1} of ${path}`);
		try { return [check(record)]; } catch (error: any) { throw new Error(`Invalid record on line ${index + 1} of ${path}: ${error.message}`); }
	});
}
