import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	scanEditor,
	checkLegacyCommands,
	checkMutationBoundary,
} from "./inventory.mjs";
import { checkCanonicalLiterals } from "./runtime-inventory.mjs";

async function fixture(t, files = {}) {
	const root = await mkdtemp(path.join(os.tmpdir(), "opencut-architecture-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const put = async (name, text) => {
		const destination = path.join(root, name);
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, text);
	};
	await put(
		"tsconfig.json",
		JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				allowJs: true,
				module: "ESNext",
				moduleResolution: "Bundler",
				noLib: true,
				types: [],
				jsx: "preserve",
				paths: { "@/*": ["./src/*"] },
			},
		}),
	);
	await put(
		"src/commands/base-command.ts",
		"export abstract class Command { abstract execute(): void; }",
	);
	for (const [name, text] of Object.entries(files))
		await put(`src/${name}`, text);
	const scan = () =>
		scanEditor({
			configPath: path.join(root, "tsconfig.json"),
			sourceRoot: path.join(root, "src"),
			commandBasePath: path.join(root, "src/commands/base-command.ts"),
		});
	return { put: (name, text) => put(`src/${name}`, text), scan, root };
}
const baselineFor = (inventory) => ({
	schemaVersion: 1,
	commands: Object.fromEntries(
		inventory.legacyCommands.map((entry) => [
			`${entry.file}#${entry.name}`,
			entry.fingerprint,
		]),
	),
});

const mutationBaselineFor = (inventory) => ({
	schemaVersion: 1,
	sites: Object.fromEntries(
		inventory.mutationSites.map((entry) => [entry.id, entry.fingerprint]),
	),
});

test("new use of an existing legacy command or inline snapshot mutation is rejected", async (t) => {
	const f = await fixture(t, {
		"commands/old.ts":
			'import { Command } from "./base-command"; export class Existing extends Command { execute() {} }',
		"commands/index.ts": 'export { Existing as Legacy } from "./old";',
		"core/managers/timeline-manager.ts":
			"export class TimelineManager { updateTracks(tracks: unknown) {} existing() { this.updateTracks({old:true}); } }",
	});
	const baseline = mutationBaselineFor(f.scan());
	await f.put(
		"new-panel.tsx",
		'import { Legacy as Edit } from "./commands/index"; import { TimelineManager } from "./core/managers/timeline-manager"; export function Panel() { const timeline = new TimelineManager(); const click = () => { new Edit().execute(); timeline.updateTracks({newFeature:1}); }; return <button onClick={click}>Edit</button>; }',
	);
	const violations = checkMutationBoundary(f.scan(), baseline);
	assert.equal(violations.length, 2);
	assert.ok(violations.some((v) => v.includes("new:commands/old.ts#Existing")));
	assert.ok(violations.some((v) => v.includes("call:updateTracks")));
});

test("mutation sites ignore trivia and permit deletion while changed calls fail", async (t) => {
	const f = await fixture(t, {
		"manager.ts":
			'export class Manager { edit() { this.updateSceneTracks({tracks:"before"}); } }',
	});
	const baseline = mutationBaselineFor(f.scan());
	await f.put(
		"manager.ts",
		'/* comment */\nexport class Manager { edit() {\n this.updateSceneTracks( { tracks: "before" } ); } }',
	);
	assert.deepEqual(checkMutationBoundary(f.scan(), baseline), []);
	await f.put(
		"manager.ts",
		'export class Manager { edit() { this["updateSceneTracks"]({tracks:"after"}); } }',
	);
	assert.equal(checkMutationBoundary(f.scan(), baseline).length, 1);
	await f.put("manager.ts", "export class Manager { edit() {} }");
	assert.deepEqual(checkMutationBoundary(f.scan(), baseline), []);
	assert.throws(
		() => checkMutationBoundary(f.scan(), { schemaVersion: 2 }),
		/Invalid mutation-site/,
	);
});

test("deleting one mutation does not rename later sites while duplicate entry additions fail", async (t) => {
	const f = await fixture(t, {
		"manager.ts":
			"export class Manager { edit() { this.updateTracks({one:1}); this.updateTracks({two:2}); } }",
	});
	const baseline = mutationBaselineFor(f.scan());
	await f.put(
		"manager.ts",
		"export class Manager { edit() { this.updateTracks({two:2}); } }",
	);
	assert.deepEqual(checkMutationBoundary(f.scan(), baseline), []);
	await f.put(
		"manager.ts",
		"export class Manager { edit() { this.updateTracks({two:2}); this.updateTracks({two:2}); } }",
	);
	assert.equal(checkMutationBoundary(f.scan(), baseline).length, 1);
});

test("production cannot import or re-export excluded fixtures through static or dynamic modules", async (t) => {
	const f = await fixture(t, {
		"__tests__/old.ts":
			'import { Command } from "../commands/base-command"; export class Hidden extends Command { execute() {} }',
		"hidden.test.ts": "export const hidden = true;",
		"allowed.d.ts": "export type Allowed = string;",
	});
	const baseline = mutationBaselineFor(f.scan());
	await f.put(
		"feature.ts",
		'import { Hidden } from "@/__tests__/old"; export { Hidden as Alias } from "./__tests__/old"; import type { Allowed } from "./allowed"; const load = () => import("./hidden.test"); const legacy = () => require("./__tests__/old");',
	);
	const violations = checkMutationBoundary(f.scan(), baseline);
	assert.equal(violations.length, 4);
	assert.ok(
		violations.every((v) =>
			v.includes("production imports excluded test code"),
		),
	);
	assert.equal(f.scan().legacyCommands.length, 1);
});

test("new canonical feature calls remain allowed while retired legacy commands cannot reappear", async (t) => {
	const f = await fixture(t, {
		"commands/old.ts":
			'import { Command } from "./base-command"; export class Retired extends Command { execute() {} }',
	});
	const reviewed = f.scan();
	const commands = baselineFor(reviewed);
	delete commands.commands["commands/old.ts#Retired"];
	assert.equal(checkLegacyCommands(reviewed, commands).length, 1);
	const mutations = mutationBaselineFor(reviewed);
	await f.put(
		"feature.ts",
		'export function Feature(editor: any) { editor.command.invokeCanonicalControl({capabilityId:"new.feature",input:{}}); }',
	);
	assert.deepEqual(checkMutationBoundary(f.scan(), mutations), []);
});

test("gate resolves aliases, re-exports, derived classes and out-of-folder additions", async (t) => {
	const f = await fixture(t, {
		"commands/index.ts": 'export { Command as Base } from "./base-command";',
		"commands/old.ts":
			'import { Base as EditorCommand } from "./index"; export class Existing extends EditorCommand { execute() {} }',
	});
	const original = f.scan();
	assert.equal(original.legacyCommands.length, 2);
	await f.put(
		"features/new.ts",
		'import { Existing as Parent } from "../commands/old"; export class SneakedIn extends Parent { execute() {} }',
	);
	await f.put(
		"features/expression.mts",
		'import { Command } from "@/commands/base-command"; export const ExpressionCommand = class extends Command { execute() {} };',
	);
	await f.put(
		"features/javascript.mjs",
		'import { Command } from "@/commands/base-command"; export class JavaScriptCommand extends Command { execute() {} }',
	);
	const problems = checkLegacyCommands(f.scan(), baselineFor(original));
	assert.equal(problems.length, 3);
	assert.ok(problems.some((p) => p.includes("SneakedIn")));
	assert.ok(problems.some((p) => p.includes("ExpressionCommand")));
	assert.ok(problems.some((p) => p.includes("JavaScriptCommand")));
});

test("format/comments are stable while literal contents and imports are guarded", async (t) => {
	const f = await fixture(t);
	const code =
		'import { Command } from "./base-command"; export class Edit extends Command { execute() { return "a b"; } }';
	await f.put("commands/edit.ts", code);
	const baseline = baselineFor(f.scan());
	await f.put(
		"commands/edit.ts",
		'import { Command } from "./base-command";\n/** explanation */\nexport class Edit extends Command {\n // comment\n execute() {\n return "a b";\n }\n}\n',
	);
	assert.deepEqual(checkLegacyCommands(f.scan(), baseline), []);
	await f.put("commands/edit.ts", code.replace('"a b"', '"ab"'));
	assert.equal(checkLegacyCommands(f.scan(), baseline).length, 1);
	await f.put(
		"commands/edit.ts",
		code + '\nimport { helper } from "../new-helper";',
	);
	assert.equal(checkLegacyCommands(f.scan(), baseline).length, 1);
});

test("deleted legacy classes are allowed and test fixtures are excluded", async (t) => {
	const f = await fixture(t, {
		"commands/old.ts":
			'import { Command } from "./base-command"; export class Old extends Command { execute() {} }',
	});
	const baseline = baselineFor(f.scan());
	await f.put("commands/old.ts", "export const migrated = true;");
	await f.put(
		"feature.test.ts",
		'import { Command } from "./commands/base-command"; class TestCommand extends Command { execute() {} }',
	);
	assert.deepEqual(checkLegacyCommands(f.scan(), baseline), []);
	assert.equal(f.scan().legacyCommands.length, 1);
});

test("base mutation, missing base and syntax errors fail closed", async (t) => {
	const f = await fixture(t);
	const baseline = baselineFor(f.scan());
	await f.put(
		"commands/base-command.ts",
		"export abstract class Command { abstract execute(): number; }",
	);
	assert.equal(checkLegacyCommands(f.scan(), baseline).length, 1);
	await f.put("commands/base-command.ts", "export class Replacement {}");
	assert.throws(f.scan, /base was not found/);
	await f.put("commands/base-command.ts", "export class Command { broken(");
	assert.throws(f.scan, /invalid syntax/);
});

test("inventory reports resolved call candidates without declaring parity", async (t) => {
	const f = await fixture(t, {
		"core/canonical-classic-session.ts": `export class CanonicalClassicSession {
      call(value: unknown) {} updateTrack() { this.call({capability: "timeline.classic.track.update"}); }
    }`,
		"core/managers/timeline-manager.ts": `import { CanonicalClassicSession } from "../canonical-classic-session";
      export class TimelineManager { session = new CanonicalClassicSession(); toggle() { this.session.updateTrack(); } }`,
		"actions/definitions.ts":
			'export const ACTIONS = { mute: {description: "Mute track", category: "timeline"} } as const;',
		"actions/use-action-handler.ts":
			"export function useActionHandler(action: string, handler: () => void) {}",
		"panel.tsx": `import { useActionHandler as bind } from "./actions/use-action-handler";
      import { TimelineManager } from "./core/managers/timeline-manager";
      const timeline = new TimelineManager();
      export function Panel() { const click = () => timeline.toggle(); bind("mute", click);
        return <button onClick={click} onBlur={unknownHandler}>Mute</button>; }`,
	});
	const report = f.scan();
	assert.deepEqual(
		report.actions.map((a) => a.id),
		["mute"],
	);
	assert.deepEqual(report.actionBindings[0].candidateCapabilities, [
		"timeline.classic.track.update",
	]);
	assert.equal(report.actionBindings[0].parityVerified, false);
	assert.deepEqual(report.uiEvents[0].candidateCapabilities, [
		"timeline.classic.track.update",
	]);
	assert.equal(report.uiEvents[1].handlerResolved, false);
	assert.equal(report.canonicalCallSites.length, 1);
});

test("canonical button bindings resolve aliases and join the compiled registry gate", async (t) => {
	const f = await fixture(t, {
		"components/editor/canonical-button.tsx":
			"export function CanonicalButton(props: unknown) { return null; }",
		"fake.tsx":
			"export function CanonicalButton(props: unknown) { return null; }",
		"panel.tsx": `import { CanonicalButton as Control } from "./components/editor/canonical-button";
import { CanonicalButton } from "./fake";
export function Panel() { return <><Control action={{capabilityId:"future.edit",input:{}}}>Edit</Control><CanonicalButton action={{capabilityId:"fake",input:{}}} /></>; }`,
	});
	const report = f.scan();
	assert.deepEqual(
		report.canonicalCallSites.map((call) => call.capability),
		["future.edit"],
	);
	assert.equal(checkCanonicalLiterals(report, { capabilities: [] }).length, 1);
	assert.deepEqual(
		checkCanonicalLiterals(report, {
			capabilities: [{ id: "future.edit", documentSupport: "classic" }],
		}),
		[],
	);
});

test("regex/template meaningful whitespace changes fingerprints", async (t) => {
	const f = await fixture(t);
	const code =
		'import { Command } from "./base-command"; class Edit extends Command { execute() { return [/a b/, `a b`]; } }';
	await f.put("commands/edit.ts", code);
	const baseline = baselineFor(f.scan());
	await f.put("commands/edit.ts", code.replace("/a b/", "/ab/"));
	assert.equal(checkLegacyCommands(f.scan(), baseline).length, 1);
	await f.put("commands/edit.ts", code.replace("`a b`", "`ab`"));
	assert.equal(checkLegacyCommands(f.scan(), baseline).length, 1);
});

test("a broken or retargeted base import cannot masquerade as command deletion", async (t) => {
	const f = await fixture(t, {
		"commands/barrel.ts": 'export { Command } from "./base-command";',
		"commands/edit.ts":
			'import { Command } from "./barrel"; export class Edit extends Command { execute() {} }',
	});
	const baseline = baselineFor(f.scan());
	await f.put("commands/barrel.ts", 'export { Command } from "./missing";');
	assert.match(
		checkLegacyCommands(f.scan(), baseline).join("\n"),
		/ancestry no longer resolves/,
	);
});

test("generic document synchronization is not presented as feature coverage", async (t) => {
	const f = await fixture(t, {
		"core/canonical-classic-session.ts": `export class CanonicalClassicSession {
      call(value: unknown) {} sync() { this.call({capability: "project.classic.synchronize"}); }
    }`,
		"core/managers/manager.ts":
			'import { CanonicalClassicSession } from "../canonical-classic-session"; export class Manager { session = new CanonicalClassicSession(); apply() { this.session.sync(); } }',
	});
	const method = f
		.scan()
		.managerMethods.find((entry) => entry.name === "Manager.apply");
	assert.deepEqual(method.candidateCapabilities, []);
	assert.deepEqual(method.infrastructureCapabilities, [
		"project.classic.synchronize",
	]);
	assert.equal(method.parityVerified, false);
});

test("Classic project feature contracts are not mistaken for generic synchronization", async (t) => {
	const f = await fixture(t, {
		"core/canonical-classic-session.ts":
			'export class CanonicalClassicSession { call(value: unknown) {} create() { this.call({capability:"project.classic.scenes.edit"}); } }',
		"core/managers/scenes.ts":
			'import { CanonicalClassicSession } from "../canonical-classic-session"; export class Scenes { session = new CanonicalClassicSession(); create() { this.session.create(); } }',
	});
	const method = f
		.scan()
		.managerMethods.find((entry) => entry.name === "Scenes.create");
	assert.deepEqual(method.candidateCapabilities, [
		"project.classic.scenes.edit",
	]);
	assert.deepEqual(method.infrastructureCapabilities, []);
});

test("transaction callbacks contribute explicit candidates without proving wrapper execution", async (t) => {
	const f = await fixture(t, {
		"core/canonical-classic-session.ts":
			'export class CanonicalClassicSession { call(value: unknown) {} edit() { this.call({capability:"timeline.classic.bookmarks.edit"}); } }',
		"core/managers/scenes.ts":
			'import { CanonicalClassicSession } from "../canonical-classic-session"; export class Scenes { session = new CanonicalClassicSession(); transaction(input: unknown) {} edit() { this.transaction({execute: () => this.session.edit()}); } }',
	});
	const method = f
		.scan()
		.managerMethods.find((entry) => entry.name === "Scenes.edit");
	assert.deepEqual(method.candidateCapabilities, [
		"timeline.classic.bookmarks.edit",
	]);
	assert.equal(method.parityVerified, false);
});

test("compiled registry join rejects missing and wrong-representation capabilities", () => {
	const inventory = {
		canonicalCallSites: ["valid", "wrong", "missing"].map((capability) => ({
			file: "adapter.ts",
			line: 1,
			capability,
		})),
	};
	const registry = {
		capabilities: [
			{ id: "valid", documentSupport: "classic", available: false },
			{ id: "wrong", documentSupport: "rewrite" },
		],
	};
	const failures = checkCanonicalLiterals(inventory, registry);
	assert.equal(failures.length, 2);
	assert.match(failures[0], /rewrite-only/);
	assert.match(failures[1], /missing from compiled/);
});
