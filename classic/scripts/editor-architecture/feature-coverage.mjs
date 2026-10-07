import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanEditor } from "./inventory.mjs";
import { readRuntimeInventory } from "./runtime-inventory.mjs";

/** Audit metadata, never an agent tool table or a second feature registry. */
export function joinFeatureCoverage({
	manifest,
	inventory,
	registry,
	existingFiles,
}) {
	const descriptors = new Map(registry.capabilities.map((c) => [c.id, c]));
	const methods = new Map(inventory.managerMethods.map((m) => [m.name, m]));
	const actions = new Map(inventory.actions.map((a) => [a.id, a]));
	const ids = new Set();
	const problems = [];
	const families = manifest.families.map((f) => {
		if (ids.has(f.id)) problems.push(`Duplicate feature family: ${f.id}`);
		ids.add(f.id);
		const entries = f.managers.map((name) => {
			const method = methods.get(name);
			if (!method) problems.push(`${f.id}: missing manager entry ${name}`);
			return method ?? { name, missing: true };
		});
		const boundActions = f.actions.map((id) => {
			if (!actions.has(id)) problems.push(`${f.id}: missing action ${id}`);
			return actions.get(id) ?? { id, missing: true };
		});
		for (const file of [...f.sources, ...f.tests]) {
			if (!existingFiles.has(file))
				problems.push(`${f.id}: missing evidence file ${file}`);
		}
		const contracts = f.contracts.map((id) => {
			const descriptor = descriptors.get(id);
			if (!descriptor)
				problems.push(`${f.id}: missing compiled capability ${id}`);
			else if (descriptor.documentSupport === "rewrite")
				problems.push(
					`${f.id}: rewrite-only capability cannot cover Classic: ${id}`,
				);
			return descriptor ?? { id, missing: true };
		});
		const sourceFiles = new Set(
			f.sources.map((file) => file.replace(/^classic\/apps\/web\/src\//, "")),
		);
		const candidateUiEvents = inventory.uiEvents.filter(
			(e) =>
				sourceFiles.has(e.file) ||
				e.legacyCommands?.some((command) =>
					sourceFiles.has(command.split("#")[0]),
				) ||
				e.candidateCapabilities?.some((id) =>
					contracts.some((c) => c.id === id),
				),
		);
		return {
			...f,
			entries,
			boundActions,
			contracts,
			candidateUiEvents,
			parityVerified: false,
			testsStatus: "definedOnly",
			review:
				"Reviewed audit mapping; AST edges and file existence do not prove runtime UI parity.",
		};
	});
	const owners = (kind, value) =>
		families
			.filter((f) =>
				f[kind].some((entry) =>
					typeof entry === "string" ? entry === value : entry.name === value,
				),
			)
			.map((f) => f.id);
	const evidenceFor = (familyIds) => {
		const selected = families.filter((f) => familyIds.includes(f.id));
		return {
			featureFamilies: familyIds,
			tests: [...new Set(selected.flatMap((f) => f.tests))],
			agentContracts: [
				...new Set(selected.flatMap((f) => f.contracts.map((c) => c.id))),
			],
			gap: selected.length
				? selected.map((f) => f.gap).join("; ")
				: "Unreviewed candidate: classify the operation and trace UI, contract and test before claiming coverage.",
			parityVerified: false,
			testsStatus: "definedOnly",
		};
	};
	for (const action of inventory.actions)
		if (!owners("actions", action.id).length)
			problems.push(`Unmapped declared action: ${action.id}`);
	return {
		schemaVersion: 1,
		limitations: [
			"Contracts come from the actual compiled registry; no live editor is attached.",
			"Test references mean defined tests, not a successful current test run.",
			"Every scanned candidate is retained; unreviewed UI/manager candidates are explicit gaps.",
			"Legacy command bridging is distinct from dedicated Classic capability migration.",
		],
		families,
		actions: inventory.actions.map((a) => ({
			...a,
			...evidenceFor(owners("actions", a.id)),
			handlerBindings: inventory.actionBindings.filter(
				(b) => b.action === a.id,
			),
		})),
		managerMethods: inventory.managerMethods.map((m) => ({
			...m,
			...evidenceFor(owners("managers", m.name)),
			review: owners("managers", m.name).length ? "mapped" : "unreviewed",
		})),
		uiEvents: inventory.uiEvents.map((e) => ({
			...e,
			...evidenceFor(
				families
					.filter((f) => f.candidateUiEvents.some((c) => c === e))
					.map((f) => f.id),
			),
		})),
		legacyCommands: inventory.legacyCommands.map((command) => ({
			...command,
			...evidenceFor(
				families
					.filter(
						(f) =>
							f.sources.includes(`classic/apps/web/src/${command.file}`) ||
							f.entries.some((e) =>
								e.legacyCommands?.includes(`${command.file}#${command.name}`),
							),
					)
					.map((f) => f.id),
			),
		})),
		mutationSites: inventory.mutationSites.map((site) => ({
			...site,
			...evidenceFor(
				families
					.filter((f) =>
						f.sources.includes(`classic/apps/web/src/${site.file}`),
					)
					.map((f) => f.id),
			),
		})),
		compiledRegistry: registry,
		problems,
	};
}

export async function writeFeatureCoverage({
	inventory: suppliedInventory,
	registry: suppliedRegistry,
} = {}) {
	const here = path.dirname(fileURLToPath(import.meta.url));
	const classic = path.resolve(here, "../..");
	const root = path.dirname(classic);
	const manifestPath = path.join(here, "feature-coverage.json");
	const manifestBytes = await readFile(manifestPath);
	const manifest = JSON.parse(manifestBytes.toString());
	const inventory =
		suppliedInventory ??
		scanEditor({
			configPath: path.join(classic, "apps/web/tsconfig.json"),
			sourceRoot: path.join(classic, "apps/web/src"),
			commandBasePath: path.join(
				classic,
				"apps/web/src/commands/base-command.ts",
			),
		});
	const registry = suppliedRegistry ?? (await readRuntimeInventory());
	const files = [
		...new Set(manifest.families.flatMap((f) => [...f.sources, ...f.tests])),
	];
	const existingFiles = new Set();
	const sourceHashes = {};
	await Promise.all(
		files.map(async (file) => {
			if (path.isAbsolute(file) || file.split("/").includes(".."))
				throw new Error("Coverage path must be repository-relative");
			try {
				const bytes = await readFile(path.join(root, file));
				existingFiles.add(file);
				sourceHashes[file] = createHash("sha256").update(bytes).digest("hex");
			} catch (error) {
				if (error.code !== "ENOENT") throw error;
			}
		}),
	);
	const report = joinFeatureCoverage({
		manifest,
		inventory,
		registry,
		existingFiles,
	});
	report.evidence = {
		generatedAt: new Date().toISOString(),
		manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
		sourceHashes,
	};
	const output = path.join(
		root,
		".local/editor-architecture/feature-coverage.json",
	);
	await mkdir(path.dirname(output), { recursive: true });
	await writeFile(output, JSON.stringify(report, null, 2) + "\n");
	const escape = (value) =>
		String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
	const localPath = (file) => {
		const absolute = path.join(root, file).replaceAll("\\", "/");
		return absolute;
	};
	const link = (file) => `[${file.split("/").at(-1)}](${localPath(file)})`;
	const route = (feature) =>
		feature.entries
			.map((e) =>
				e.missing
					? escape(e.name)
					: `[${escape(e.name)}](${localPath(`classic/apps/web/src/${e.file}`)}:${e.line})`,
			)
			.join("; ") || feature.sources.map(link).join("; ");
	const markdown = [
		"# OpenCut feature coverage",
		"",
		"Existing operations are linked to their manager or implementation entry points, compiled agent contracts, defined tests and remaining migration gaps. AST control edges are candidates, not proof of runtime UI parity. Every scanned action, manager method and JSX event is retained in the JSON report, including unreviewed candidates. Test references do not certify a current run.",
		"",
		"| Existing operation | UI/manager route | Agent contract | Defined tests | Remaining gap |",
		"| --- | --- | --- | --- | --- |",
		...report.families.map(
			(f) =>
				`| ${escape(f.title)} | ${route(f)} | ${f.contracts.map((c) => escape(c.id)).join("; ") || "Missing"} | ${f.tests.map(link).join("; ")} | ${escape(f.gap)} |`,
		),
		"",
		`Inventory: ${report.actions.length} actions, ${report.managerMethods.length} manager methods, ${report.uiEvents.length} JSX event candidates, ${report.mutationSites.length} generic/legacy mutation sites. No parity percentage is inferred.`,
		"",
	];
	const markdownPath = path.join(root, "EDITOR-FEATURE-COVERAGE.md");
	await writeFile(markdownPath, markdown.join("\n"));
	console.log(
		`Coverage: ${report.families.length} reviewed families, ${report.actions.length} actions, ${report.uiEvents.length} UI candidates; ${report.problems.length} broken references. ${markdownPath}`,
	);
	if (report.problems.length) throw new Error(report.problems.join("\n"));
	return report;
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
	await writeFeatureCoverage();
