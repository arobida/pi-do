import { type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { todoLine } from "./todo.ts";
import { home, readJsonl } from "./util.ts";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// Pinned to this install's version so editors validate against the options it actually supports; tag v<version> on release.
export const schemaUrl = `https://raw.githubusercontent.com/arobida/pi-do/v${version}/schema.json`;

// JSONC: drops comments, then trailing commas (second pass catches a comma that sat before a comment); strings are kept as-is.
const stripJsonc = (t: string) => t.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\/|,(\s*[}\]])/g, (_m, str, close) => str ?? close ?? "");
export function parseJsonc(text: string, path: string): any {
	if (!text.trim()) return {};
	let config: any;
	try { config = JSON.parse(stripJsonc(stripJsonc(text))); } catch (error: any) { throw new Error(`Invalid JSON in ${path}: ${error.message}`); }
	if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error(`${path} must hold a JSON object`);
	return config;
}

export const writeConfig = (dir: string, config: object) => writeFileSync(join(dir, "config.json"), JSON.stringify({ $schema: schemaUrl, ...config }, null, 2) + "\n");
// Creates config.json unless it (or a legacy config.jsonl, converted by readConfig) exists.
const ensureConfig = (dir: string) => { readConfig(dir); if (!existsSync(join(dir, "config.json"))) writeConfig(dir, {}); };

// <dir>/config.json (JSONC). Converts a legacy config.jsonl and keeps "$schema" pointed at this version.
export function readConfig(dir: string): { adapters?: Record<string, { sync?: boolean }>; file?: string; scope?: string; id?: string } {
	const path = join(dir, "config.json"), legacy = join(dir, "config.jsonl");
	let text: string;
	try { text = readFileSync(path, "utf8"); }
	catch (error: any) {
		if (error.code !== "ENOENT") throw new Error(`Cannot read ${path}: ${error.message}`);
		if (!existsSync(legacy)) return {};
		writeConfig(dir, Object.assign({}, ...readJsonl(legacy))); rmSync(legacy);
		text = readFileSync(path, "utf8");
	}
	const config = parseJsonc(text, path);
	// Text replace, not a rewrite, so the user's comments survive.
	if (typeof config.$schema === "string" && config.$schema !== schemaUrl) writeFileSync(path, text.replace(JSON.stringify(config.$schema), JSON.stringify(schemaUrl)));
	if (config.backend !== undefined) throw new Error(`"backend" was replaced by "adapters" in ${path}`);
	if (config.adapters !== undefined && (typeof config.adapters !== "object" || Array.isArray(config.adapters) || Object.entries(config.adapters).some(([k, v]: [string, any]) => !["dex", "things"].includes(k) || !v || typeof v !== "object" || (v.sync !== undefined && typeof v.sync !== "boolean")))) throw new Error(`Invalid adapters in ${path}`);
	if (config.file !== undefined && (typeof config.file !== "string" || !config.file.trim())) throw new Error(`Invalid file in ${path}`);
	if (config.scope !== undefined && !["project", "global", "temp"].includes(config.scope)) throw new Error(`Invalid scope in ${path}`);
	if (config.id !== undefined && (typeof config.id !== "string" || !/^[\w-]+$/.test(config.id))) throw new Error(`Invalid id in ${path}`);
	return config;
}

// Adds the project id to an existing config by text insert after the opening brace, keeping comments.
function addId(dir: string, id: string) {
	const path = join(dir, "config.json"), config = readConfig(dir);
	if (!existsSync(path)) return writeConfig(dir, { id });
	const text = readFileSync(path, "utf8");
	if (!text.trim()) return writeConfig(dir, { id });
	const comma = Object.keys(config).length ? "," : "";
	writeFileSync(path, text.replace(/^(\s*(?:\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*)\{/, `$1{\n  "id": ${JSON.stringify(id)}${comma}`));
}

export const piDoHome = () => process.env.PI_DO_HOME || join(homedir(), ".pi-do");

export interface Settings { adapters: Record<string, { sync?: boolean }>; file?: string; scope: string; base: string; local: string; name: string; id: string; registered: boolean }

export const localDir = (cwd: string) => join(cwd, existsSync(join(cwd, ".agents", "pi-do")) ? ".agents/pi-do" : ".pi-do");
export const globalDir = (s: { name: string; id: string }) => join(piDoHome(), "projects", `${s.name}.${s.id}`);

// The project's id lives in its local config.json (kept in place across scopes) and keys its projects.jsonl record.
// Scope: env PI_DO_SCOPE > the project's record scope > global config.json > "project".
export function settings(ctx: ExtensionContext, forceGlobal = false): Settings {
	const root = piDoHome(), cwd = resolve(ctx.cwd), trusted = ctx.isProjectTrusted();
	const local = localDir(cwd);
	const id: string = (trusted ? readConfig(local).id : undefined) ?? randomUUID();
	const record = readJsonl(join(root, "projects", "projects.jsonl")).find((p) => p.id === id);
	const globalConfig = readConfig(root);
	const scope = forceGlobal ? "global" : process.env.PI_DO_SCOPE || record?.scope || globalConfig.scope || "project";
	if (!["project", "global", "temp"].includes(scope)) throw new Error(`Invalid pi-do scope: ${scope}`);
	const name = record?.name ?? basename(cwd);
	// Untrusted projects keep the temporary session file so pi-do never writes into them.
	const temp = !trusted && !forceGlobal || scope === "temp";
	// Temp stores use the same layout as project stores, in a per-session folder.
	const base = temp ? join(tmpdir(), "pi-do", createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex"), ".pi-do") : scope === "global" ? globalDir({ name, id }) : local;
	const config = { ...globalConfig, ...(base ? readConfig(base) : {}) };
	return { adapters: config.adapters ?? {}, file: process.env.PI_DO_FILE || config.file, scope: temp ? "temp" : scope, base, local, name, id, registered: !!record };
}

export const helloWorld = () => JSON.stringify({ todo: todoLine({ id: randomUUID(), name: "Hello World", completed: false, started_at: null }, undefined) }) + "\n";

// Resolves the todos file, creating the pi-do folder, config, list index, project registration and Hello World todo on first use.
export function storeFile(ctx: ExtensionContext, s: Settings): string {
	// ~/.pi-do always exists: global config plus the projects registry. Its absence means this run is the installation.
	const installing = !existsSync(join(piDoHome(), "config.json")) && !existsSync(join(piDoHome(), "config.jsonl"));
	mkdirSync(join(piDoHome(), "projects"), { recursive: true });
	ensureConfig(piDoHome());
	if (!existsSync(join(piDoHome(), "projects", "projects.jsonl"))) writeFileSync(join(piDoHome(), "projects", "projects.jsonl"), "");
	if (s.file) return resolve(ctx.cwd, home(s.file));
	const todos = join(s.base, "todos"), file = join(todos, `${s.name}.todos.jsonl`);
	// Temp stores never write into the project or the registry.
	if (s.scope !== "temp" && !readConfig(s.local).id) { mkdirSync(s.local, { recursive: true }); addId(s.local, s.id); }
	if (!s.registered && s.scope !== "temp") {
		appendFileSync(join(piDoHome(), "projects", "projects.jsonl"), JSON.stringify({ id: s.id, name: s.name, path: resolve(ctx.cwd), scope: s.scope, created: new Date().toISOString() }) + "\n");
		s.registered = true;
	}
	if (existsSync(file)) return file;
	mkdirSync(todos, { recursive: true });
	ensureConfig(s.base);
	// Hello World onboards installation and new permanent stores; other temp stores start empty.
	try { writeFileSync(file, s.scope === "temp" && !installing ? "" : helloWorld(), { flag: "wx", mode: 0o600 }); }
	catch (error: any) { if (error.code === "EEXIST") return file; throw error; }
	const created = new Date().toISOString();
	appendFileSync(join(todos, "lists.jsonl"), JSON.stringify({ id: randomUUID(), name: s.name, file: basename(file), created }) + "\n");
	return file;
}

// Moves the project store between .pi-do and .agents/pi-do (todos, config, list index); never overwrites.
export function migrate(ctx: ExtensionContext, target: string): string {
	if (!ctx.isProjectTrusted()) throw new Error("migrate requires a trusted project");
	const s = settings(ctx);
	if (s.scope !== "project" || s.file) throw new Error("migrate only moves a project-scope pi-do folder; use /todos scope to change scope");
	const to = join(resolve(ctx.cwd), target);
	if (to === s.base) throw new Error(`Already stored in ${to}`);
	if (existsSync(to)) throw new Error(`${to} already exists`);
	mkdirSync(dirname(to), { recursive: true });
	renameSync(s.base, to);
	return `Moved ${s.base} to ${to}`;
}

// Switches scope and moves the todos folder with it; the local config.json (holding the project id) stays put.
export function setScope(ctx: ExtensionContext, scope: string): string {
	if (!ctx.isProjectTrusted()) throw new Error("scope requires a trusted project");
	const s = settings(ctx), registry = join(piDoHome(), "projects", "projects.jsonl");
	if (s.file) throw new Error("scope does not apply to an explicit file");
	storeFile(ctx, s); // registers the project and writes its id if needed
	const projects = readJsonl(registry);
	const record = projects.find((p) => p.id === s.id)!;
	if (record.scope === scope) return `Already ${scope} scope`;
	const [from, to] = scope === "global" ? [s.local, globalDir(s)] : [globalDir(s), s.local];
	if (existsSync(join(to, "todos"))) throw new Error(`${join(to, "todos")} already exists`);
	mkdirSync(to, { recursive: true });
	ensureConfig(to);
	// Copy then delete: project and home may be on different disks.
	if (existsSync(join(from, "todos"))) { cpSync(join(from, "todos"), join(to, "todos"), { recursive: true, errorOnExist: true, force: false }); rmSync(join(from, "todos"), { recursive: true }); }
	if (scope === "project") rmSync(from, { recursive: true, force: true });
	record.scope = scope;
	const temp = `${registry}.${randomUUID()}.tmp`;
	writeFileSync(temp, projects.map((p) => JSON.stringify(p) + "\n").join("")); renameSync(temp, registry);
	return `Scope set to ${scope}: ${storeFile(ctx, settings(ctx))}`;
}
