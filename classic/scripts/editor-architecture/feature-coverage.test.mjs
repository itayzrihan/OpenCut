import assert from "node:assert/strict";
import test from "node:test";
import { joinFeatureCoverage } from "./feature-coverage.mjs";

function fixture(support = "classic") {
	return {
		manifest: {
			families: [
				{
					id: "move",
					title: "Move clips",
					managers: ["TimelineManager.moveElements"],
					actions: ["move"],
					sources: ["classic/apps/web/src/move.ts"],
					contracts: ["timeline.move"],
					tests: ["move.test.ts"],
					gap: "Live acceptance pending",
				},
			],
		},
		inventory: {
			managerMethods: [
				{ name: "TimelineManager.moveElements", file: "move.ts", line: 1 },
				{ name: "TimelineManager.unreviewed", file: "new.ts", line: 1 },
			],
			actions: [{ id: "move" }],
			actionBindings: [],
			uiEvents: [
				{ file: "move.ts", line: 2 },
				{ file: "new.ts", line: 3 },
			],
			legacyCommands: [],
			mutationSites: [],
		},
		registry: {
			capabilities: [{ id: "timeline.move", documentSupport: support }],
		},
		existingFiles: new Set(["classic/apps/web/src/move.ts", "move.test.ts"]),
	};
}
test("rewrite move cannot certify a Classic move route", () => {
	const report = joinFeatureCoverage(fixture("rewrite"));
	assert.match(report.problems.join("\n"), /rewrite-only/);
	assert.equal(report.families[0].parityVerified, false);
});
test("new buttons, manager methods and actions remain visible as gaps", () => {
	const input = fixture();
	input.inventory.actions.push({ id: "new-action" });
	const report = joinFeatureCoverage(input);
	assert.match(
		report.problems.join("\n"),
		/Unmapped declared action: new-action/,
	);
	assert.match(report.uiEvents[1].gap, /Unreviewed/);
	assert.equal(report.managerMethods[1].review, "unreviewed");
	assert.equal(report.uiEvents[0].testsStatus, "definedOnly");
});
test("removed contracts, UI entry points and tests invalidate the map", () => {
	const input = fixture();
	input.registry.capabilities = [];
	input.inventory.managerMethods = [];
	input.existingFiles.delete("move.test.ts");
	const report = joinFeatureCoverage(input);
	assert.equal(report.problems.length, 3);
});
