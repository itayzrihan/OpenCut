import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createCanonicalTestRuntime } from "@/core/__tests__/canonical-runtime-fixture";
import {
	advertiseCanonicalRegistry,
	canonicalMcpDescriptor,
	canonicalReceiptSchema,
	encodeArtifactBytes,
	type CanonicalDescriptor,
} from "../canonical-transport";

function availableDescriptor(id: string): CanonicalDescriptor {
	return {
		id,
		title: id,
		description: "Internal editor capability",
		version: "1.0.0",
		inputSchema: { type: "object" },
		outputSchema: { type: "object" },
		access: "admin",
		idempotent: false,
		openWorld: true,
		transactional: false,
		supportsDryRun: false,
		cancellable: true,
		available: true,
		unavailableReason: null,
		category: "agent",
		tags: [],
		documentSupport: "both",
		execution: "host",
	};
}

test.each([
	"computer.observe",
	"computer.execute",
	"computer.future.operation",
	"agent.policy.set",
	"agent.policy.future",
])("external MCP discovery and execution reject internal capability %s", (id) => {
	const source = availableDescriptor(id);
	const advertised = advertiseCanonicalRegistry({
		revision: 1,
		capabilities: [source],
	});
	expect(advertised[0]?.canonical.available).toBe(false);
	expect(advertised[0]?.canonical.unavailableReason).toContain(
		"internal editor",
	);
	// CommandManager reuses this transform immediately before invocation,
	// instead of trusting the availability from an earlier discovery snapshot.
	const atExecution = canonicalMcpDescriptor(source);
	expect(atExecution.available).toBe(false);
	expect(atExecution).toEqual(advertised[0]?.canonical);
	// The live internal runtime still owns permission-driven harness access.
	expect(source.available).toBe(true);
	expect(source.unavailableReason).toBeNull();
});

test("external MCP continues to expose editor automation and Earshot capabilities", () => {
	for (const id of [
		"audio.earshot.preview",
		"project.classic.automation.start",
		"timeline.classic.audio.procedural.set",
		"app.state.read",
	]) {
		const source = availableDescriptor(id);
		expect(canonicalMcpDescriptor(source)).toBe(source);
	}
});

async function setup() {
	const runtime = await createCanonicalTestRuntime();
	runtime.invokeSync(
		"project.classic.session.attach",
		{
			projectId: "classic-project",
			expectedRevision: 0,
			classic: JSON.parse(
				readFileSync(
					new URL(
						"../../../../../../crates/editor-api/tests/fixtures/classic-project.json",
						import.meta.url,
					),
					"utf8",
				),
			),
		},
		{},
	);
	const input = {
		projectId: "classic-project",
		expectedRevision: 1,
		procedural: {
			version: 1,
			engine: "earshot",
			bankRevision: "591fa3e028032e6dce56620a20e932e35667e8d8",
			presetId: "whoosh_fast/whip",
			seed: 42,
			duration: 0.02,
		},
	};
	return { runtime, input };
}
const context = {
	requestId: "mcp-test",
	dryRun: false,
	metadata: {
		"opencut/projectId": "classic-project",
		"opencut/idempotencyKey": "preview-test",
	},
};
const pcm = () => ({
	type: "success",
	data: { channels: 1, pcm16Base64: encodeArtifactBytes(new Uint8Array(1920)) },
});

test("browser publishes canonical schemas and host availability without a feature tool registry", async () => {
	const { runtime } = await setup();
	try {
		const tools = advertiseCanonicalRegistry(runtime.capabilities());
		const sound = tools.find(
			(tool) => tool.name === "canonical.audio.earshot.preview",
		);
		expect(sound?.canonical.access).toBe("write");
		expect(sound?.openWorld).toBe(true);
		expect(sound?.canonical.available).toBe(true);
		expect(
			tools.find(
				(tool) =>
					tool.name === "canonical.timeline.classic.audio.procedural.set",
			)?.canonical.available,
		).toBe(true);
		expect(
			tools.find((tool) => tool.name === "canonical.editor.export.render")
				?.canonical.available,
		).toBe(false);
		expect(
			tools.find((tool) => tool.name === "canonical.project.close")?.canonical
				.available,
		).toBe(false);
	} finally {
		runtime.free();
	}
}, 60_000);

test("generic WASM host invocation returns canonical audio artifacts without an editing-agent run", async () => {
	const { runtime, input } = await setup();
	try {
		const before = runtime.snapshot();
		const receipt = canonicalReceiptSchema.parse(
			await runtime.invokeWithHost(
				"audio.earshot.preview",
				input,
				context,
				(effect: { adapter: string; projectId: string }) => {
					expect(effect.adapter).toBe("earshotPreview");
					expect(effect.projectId).toBe("classic-project");
					return pcm();
				},
			),
		);
		const metadata = receipt.result.artifacts[0]!;
		expect(metadata.mimeType).toBe("audio/wav");
		expect(
			new TextDecoder().decode(
				runtime.readArtifact(metadata.id).subarray(0, 4),
			),
		).toBe("RIFF");
		expect(runtime.snapshot()).toEqual(before);
	} finally {
		runtime.free();
	}
}, 60_000);

test("uncertain host response retains the exact invocation until reconciliation", async () => {
	const { runtime, input } = await setup();
	try {
		await expect(
			runtime.invokeWithHost("audio.earshot.preview", input, context, () => {
				throw new Error("transport lost");
			}),
		).rejects.toThrow("reconcile");
		await expect(
			runtime.invokeWithHost(
				"audio.earshot.preview",
				{ ...input, procedural: { ...input.procedural, seed: 43 } },
				context,
				pcm,
			),
		).rejects.toThrow("same pending");
		const result = canonicalReceiptSchema.parse(
			await runtime.invokeWithHost(
				"audio.earshot.preview",
				input,
				context,
				pcm,
			),
		);
		expect(result.result.artifacts.length).toBe(1);
		const read = canonicalReceiptSchema.parse(
			await runtime.invokeWithHost("app.state.read", {}, context, () => {
				throw new Error("not needed");
			}),
		);
		expect(read.capabilityId).toBe("app.state.read");
	} finally {
		runtime.free();
	}
}, 60_000);

test("only the matching transport request can cancel a noncommitting preview", async () => {
	const { runtime, input } = await setup();
	try {
		await runtime.invokeWithHost(
			"audio.earshot.preview",
			input,
			context,
			() => {
				runtime.cancelExternalInvocation("other-request");
				return pcm();
			},
		);
		await expect(
			runtime.invokeWithHost(
				"audio.earshot.preview",
				input,
				{
					...context,
					requestId: "cancel-me",
					metadata: {
						...context.metadata,
						"opencut/idempotencyKey": "cancel-preview",
					},
				},
				() => {
					runtime.cancelExternalInvocation("cancel-me");
					return { type: "rejected", message: "cancelled" };
				},
			),
		).rejects.toThrow();
		const read = canonicalReceiptSchema.parse(
			await runtime.invokeWithHost("app.state.read", {}, context, pcm),
		);
		expect(read.capabilityId).toBe("app.state.read");
	} finally {
		runtime.free();
	}
}, 60_000);
