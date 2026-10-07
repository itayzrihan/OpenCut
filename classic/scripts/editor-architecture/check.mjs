import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	scanEditor,
	checkLegacyCommands,
	checkMutationBoundary,
} from "./inventory.mjs";
import {
	readRuntimeInventory,
	checkCanonicalLiterals,
} from "./runtime-inventory.mjs";
import { writeFeatureCoverage } from "./feature-coverage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const classic = path.resolve(here, "../..");
const inventory = scanEditor({
	configPath: path.join(classic, "apps/web/tsconfig.json"),
	sourceRoot: path.join(classic, "apps/web/src"),
	commandBasePath: path.join(classic, "apps/web/src/commands/base-command.ts"),
});
const baseline = JSON.parse(
	await readFile(path.join(here, "legacy-commands.json"), "utf8"),
);
const violations = checkLegacyCommands(inventory, baseline);
const mutationBaseline = JSON.parse(
	await readFile(path.join(here, "legacy-mutation-sites.json"), "utf8"),
);
violations.push(...checkMutationBoundary(inventory, mutationBaseline));
if (process.argv.includes("--with-runtime")) {
	inventory.runtime = await readRuntimeInventory();
	violations.push(...checkCanonicalLiterals(inventory, inventory.runtime));
} else
	inventory.runtime = {
		inspected: false,
		reason:
			"Run with --with-runtime after building canonical WASM to join the compiled registry.",
	};
const reportPath = path.resolve(
	classic,
	"../.local/editor-architecture/inventory.json",
);
await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(
	reportPath,
	JSON.stringify({ ...inventory, violations }, null, 2) + "\n",
);
console.log(
	`Scanned ${inventory.sourceFiles} source files: ${inventory.legacyCommands.length} legacy classes, ${inventory.mutationSites.length} generic/legacy mutation sites, ${inventory.managerMethods.length} manager methods, ${inventory.actions.length} actions, ${inventory.uiEvents.length} JSX event sites.`,
);
console.log(`Candidate map (not parity proof): ${reportPath}`);
if (violations.length) {
	console.error(violations.join("\n"));
	process.exitCode = 1;
} else
	console.log(
		"Legacy command definitions and mutation sites match the reviewed boundaries; deletions are allowed.",
	);
if (process.argv.includes("--with-runtime") && !violations.length)
	await writeFeatureCoverage({ inventory, registry: inventory.runtime });
