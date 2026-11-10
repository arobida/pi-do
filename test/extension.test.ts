import { expect, mock, test } from "bun:test";

mock.module("@earendil-works/pi-tui", () => ({ truncateToWidth: (text: string) => text }));
const { default: extension } = await import("../src/index.ts");

test("registers the existing tool, command, shortcuts, and lifecycle hooks", () => {
 const tools: any[] = [], commands: string[] = [], shortcuts: string[] = [], events: string[] = [];
 extension({
  registerTool: (tool: any) => tools.push(tool),
  registerCommand: (name: string) => commands.push(name),
  registerShortcut: (key: string) => shortcuts.push(key),
  on: (event: string) => events.push(event),
 } as any);
 expect(tools.map(t => t.name)).toEqual(["dex_task"]);
 expect(commands).toEqual(["todos"]);
 expect(shortcuts).toEqual(["ctrl+shift+t", "ctrl+shift+v"]);
 expect(events).toEqual(["session_start", "session_switch", "tool_result"]);
});

test("manifest exposes the source and host packages remain peers", async () => {
 const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
 expect(pkg.pi.extensions).toEqual(["./src/index.ts"]);
 expect(pkg.keywords).toContain("pi-package");
 expect(pkg.dependencies).toBeUndefined();
 expect(await Bun.file(new URL("../src/index.ts", import.meta.url)).exists()).toBe(true);
});
