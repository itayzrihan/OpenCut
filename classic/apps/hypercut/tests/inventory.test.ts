import test from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import inventory from "../feature-parity.json";
test("inventory retains all canonical feature families, panel tabs and source evidence", async () => {
	const root = new URL("../../../../", import.meta.url);
	const legacy = JSON.parse(
		await readFile(
			new URL(
				"classic/scripts/editor-architecture/feature-coverage.json",
				root,
			),
			"utf8",
		),
	);
	const ids = new Set(inventory.features.map((f) => f.id));
	assert.equal(ids.size, inventory.features.length);
	for (const f of legacy.families) assert.ok(ids.has(f.id), `Missing ${f.id}`);
	const tabs = await readFile(
		new URL(
			"classic/apps/web/src/components/editor/panels/assets/assets-panel-store.tsx",
			root,
		),
		"utf8",
	);
	for (const [, tab] of tabs
		.match(/export const TAB_KEYS = \[([\s\S]*?)\] as const/)![1]
		.matchAll(/"([^"]+)"/g))
		assert.ok(ids.has(`panel-${tab}`), `Missing panel ${tab}`);
	for (const feature of inventory.features)
		for (const source of feature.source) await access(new URL(source, root));
	assert.equal(
		inventory.features.filter((f) => String(f.status) === "fully migrated")
			.length,
		0,
		"Do not declare parity without recorded acceptance evidence",
	);
});
