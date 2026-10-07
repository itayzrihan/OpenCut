import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { acquireBrowser } from "@hyperframes/engine";
declare global {
	interface Window {
		__uiControlFixture: typeof import("./ui-control-browser-fixture");
	}
}
test("opaque UI targets open panels and fill filters while private, document, expired and foreign controls stay fenced", async () => {
	const build = await Bun.build({
		entrypoints: [
			fileURLToPath(
				new URL("./ui-control-browser-fixture.ts", import.meta.url),
			),
		],
		target: "browser",
		format: "esm",
	});
	if (!build.success) throw new Error(build.logs.join("\n"));
	const code = await build.outputs[0].text();
	const lease = await acquireBrowser(["--disable-gpu"], {
		enableBrowserPool: false,
		forceScreenshot: true,
	});
	try {
		const page = await lease.browser.newPage();
		await page.setViewport({ width: 900, height: 700 });
		await page.setContent(
			'<main data-opencut-editor-project="project"><button id="panel">Effects</button><button id="edit">Delete clip</button><button disabled>Disabled</button><label>Search <input id="filter" type="search"></label><div data-editor-agent-private><button>Secret</button></div><iframe srcdoc="<button>Embedded</button>"></iframe></main><button>Outside</button>',
		);
		await page.evaluate(async (code) => {
			const url = URL.createObjectURL(
				new Blob([code], { type: "text/javascript" }),
			);
			try {
				window.__uiControlFixture = await import(url);
			} finally {
				URL.revokeObjectURL(url);
			}
		}, code);
		const result = await page.evaluate(async () => {
			window.__opencutAccountId = "alice";
			let clicks = 0;
			let writes = 0;
			let inputs = 0;
			const panel = document.getElementById("panel"),
				filter = document.getElementById("filter");
			if (!panel || !filter) throw new Error("Fixture missing");
			panel.addEventListener("click", () => clicks++);
			document
				.getElementById("edit")
				?.addEventListener("click", () => writes++);
			filter.addEventListener("input", () => inputs++);
			const api = window.__uiControlFixture;
			const cleanup = api.bindEditorUiSurface({
				element: panel,
				gestures: ["click"],
			});
			api.bindEditorUiSurface({ element: filter, gestures: ["fill", "key"] });
			const capture = () =>
				api.captureEditorUi({
					document,
					projectId: "project",
					request: { projectId: "project", expectedRevision: 7 },
				});
			const first = capture();
			const find = (name: string) => {
				const node = first.nodes.find((node) => node.name === name);
				if (!node) throw new Error(`Missing ${name}`);
				return node;
			};
			const input = ({
				name,
				gesture,
			}: {
				name: string;
				gesture:
					| { type: "click" }
					| { type: "fill"; text: string }
					| { type: "focus" }
					| { type: "key"; key: "Enter" };
			}) => ({
				projectId: "project",
				expectedRevision: 7,
				snapshotId: first.snapshotId,
				targetId: find(name).targetId,
				gesture,
			});
			const run = ({
				request,
				options = {},
			}: {
				request: unknown;
				options?: {
					accountId?: string;
					project?: string;
					revision?: number;
					signal?: AbortSignal;
				};
			}) =>
				api.controlEditorUi({
					request,
					accountId: options.accountId ?? "alice",
					projectId: () => options.project ?? "project",
					currentRevision: () => options.revision ?? 7,
					signal: options.signal ?? new AbortController().signal,
				});
			const blocked: string[] = [];
			const reject = async ({
				label,
				request,
				options,
			}: {
				label: string;
				request: unknown;
				options?: Parameters<typeof run>[0]["options"];
			}) => {
				try {
					await run({ request, options });
				} catch {
					blocked.push(label);
				}
			};
			const click = (name: string) =>
				input({ name, gesture: { type: "click" } });
			const focus = (name: string) =>
				input({ name, gesture: { type: "focus" } });
			const receipt = await run({ request: click("Effects") });
			await run({
				request: input({
					name: "Search",
					gesture: { type: "fill", text: "כותרת glass" },
				}),
			});
			await run({ request: focus("Search") });
			await reject({ label: "document", request: click("Delete clip") });
			await reject({
				label: "account",
				request: click("Effects"),
				options: { accountId: "bob" },
			});
			await reject({
				label: "project",
				request: click("Effects"),
				options: { project: "other" },
			});
			await reject({
				label: "revision",
				request: click("Effects"),
				options: { revision: 8 },
			});
			const controller = new AbortController();
			controller.abort();
			await reject({
				label: "cancel",
				request: click("Effects"),
				options: { signal: controller.signal },
			});
			await reject({
				label: "selector",
				request: { ...click("Effects"), selector: "body" },
			});
			cleanup();
			await reject({ label: "unbound", request: click("Effects") });
			window.__opencutAccountId = "bob";
			await reject({ label: "switch", request: focus("Search") });
			window.__opencutAccountId = "alice";
			capture();
			await reject({ label: "superseded", request: focus("Search") });
			return {
				receipt,
				clicks,
				writes,
				inputs,
				blocked,
				focused: document.activeElement?.id,
				text: filter instanceof HTMLInputElement ? filter.value : "",
				names: first.nodes.map((node) => node.name),
				gestures: find("Effects").gestures,
			};
		});
		expect(result.receipt.transport).toBe("browserDom");
		expect(result.clicks).toBe(1);
		expect(result.writes).toBe(0);
		expect(result.inputs).toBe(1);
		expect(result.text).toBe("כותרת glass");
		expect(result.focused).toBe("filter");
		expect(result.blocked).toEqual([
			"document",
			"account",
			"project",
			"revision",
			"cancel",
			"selector",
			"unbound",
			"switch",
			"superseded",
		]);
		expect(result.gestures).toEqual(["focus", "scroll", "click"]);
		expect(result.names).not.toContain("Secret");
		expect(result.names).not.toContain("Outside");
		expect(result.names).not.toContain("Embedded");
	} finally {
		await lease.release();
	}
}, 30_000);
