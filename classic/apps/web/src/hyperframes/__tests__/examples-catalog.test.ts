// @opencut-test-wasm: real
import { expect, test } from "bun:test";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";

test("the browser runtime discovers the pinned reference catalog without loading source into search results", async () => {
	const runtime = await createCanonicalTestRuntime();
	try {
		const before = runtime.invokeSync("app.state.read", {}, null);
		const result = runtime.invokeSync(
			"hyperframes.examples.search",
			{ query: "גרף", limit: 3 },
			null,
		);
		expect(result.result.data.totalCatalogItems).toBe(394);
		expect(result.result.data.totalVerified).toBe(150);
		expect(result.result.data.items.length).toBe(3);
		expect(result.result.data.searchMode).toBe("lexicalWithHebrewAliases");
		expect(JSON.stringify(result)).not.toContain("<!doctype");
		const detail = runtime.invokeSync(
			"hyperframes.examples.read",
			{
				id: "data-chart",
				upstreamCommit: result.result.data.upstreamCommit,
			},
			null,
		);
		expect(
			detail.result.data.item.files.some(
				(file: { path: string }) => file.path === "data-chart.html",
			),
		).toBe(true);
		expect(detail.result.data.item.verification.status).toBe("captured");
		expect(runtime.invokeSync("app.state.read", {}, null)).toEqual(before);
	} finally {
		runtime.free();
	}
}, 30000);
