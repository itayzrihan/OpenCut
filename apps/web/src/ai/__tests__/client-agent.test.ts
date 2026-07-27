import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

mock.module("opencut-wasm", () => ({
	initCompositor: () => undefined,
	getCompositorCanvas: () => null,
	getLastFrameProfile: () => null,
	releaseTexture: () => undefined,
	renderFrame: () => undefined,
	resizeCompositor: () => undefined,
	uploadTexture: () => undefined,
	applyEffectPasses: ({ source }: { source: unknown }) => source,
	applyMaskFeather: ({ mask }: { mask: unknown }) => mask,
	initializeGpu: async () => undefined,
	refineBackgroundAlpha: () => undefined,
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 120_000,
	formatTimecode: () => "00:00:00:00",
	normalizeTextLayerWordIds: <T extends { wordRuns: Array<{ id: string }> }>(
		options: T,
	) =>
		options.wordRuns.map((word, previousWordIndex) => ({
			previousWordIndex,
			id: word.id,
		})),
	reconcileCaptionWords: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	reconcileTextContentWords: () => [],
	fitTextLayerWordsToSpan: () => [],
	textLayerDurationForWords: <
		T extends {
			duration: number;
			wordRuns: Array<{ startTime?: number; endTime?: number }>;
		},
	>(
		options: T,
	) =>
		Math.max(
			options.duration,
			...options.wordRuns.map((word) => word.endTime ?? word.startTime ?? 0),
		),
	defaultBackgroundRemovalSettings: () => ({
		enabled: false,
		mode: "remove",
		quality: "balanced",
		maskThreshold: 0.5,
		edgeContrast: 1,
		edgeFeather: 0,
		temporalSmoothing: 0,
		blurStrength: 0,
	}),
	removeCaptionWordTimeRanges: <T extends { words: unknown[] }>(options: T) =>
		options.words,
	preserveAudioDuringTimeRemoval: <T extends { clips: unknown[] }>(
		options: T,
	) => ({ clips: options.clips, timelineDuration: 0 }),
	planBackgroundRemovalDuplicate: () => ({
		kind: "existingTrack",
		trackId: "video",
	}),
	resolveBackgroundRemovalSettings: <T>(settings: T) => ({
		...settings,
		inputSize: 256,
		previewFps: 15,
		cacheEntries: 2,
		blurSigma: 0,
	}),
	searchAgentTools: () => [],
}));

let runAiAgent: typeof import("@/ai/client-agent").runAiAgent;

beforeAll(async () => {
	({ runAiAgent } = await import("@/ai/client-agent"));
});

const originalFetch = globalThis.fetch;

interface RequestInputItem {
	type?: string;
	output?: string;
	call_id?: string;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("AI client agent", () => {
	test("tries a direct no-tool edit plan before the tool loop", async () => {
		let requestBody: Record<string, unknown> | null = null;
		globalThis.fetch = async (...fetchParameters) => {
			const init = fetchParameters[1];
			if (typeof init?.body === "string") {
				requestBody = parseRequestBody(init.body);
			}
			return new Response(
				JSON.stringify({
					response: {
						id: "resp-direct",
						output_text: JSON.stringify(
							JSON.stringify({
								title: "Direct plan",
								summary: "Done",
								operations: [
									{
										type: "update_element",
										trackId: "track-1",
										elementId: "element-1",
										params: { content: "HELLO" },
									},
								],
							}),
						),
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await runAiAgent({
			messages: [{ role: "user", content: "change text" }],
			tools: [
				{
					type: "function",
					name: "timeline.propose_edit_plan",
					description: "",
					parameters: { type: "object", properties: {} },
				},
			],
			executeTool: async () => {
				throw new Error("The direct plan should not execute tools.");
			},
		});

		expect(result.status).toBe("completed");
		expect(result.iterations).toBe(1);
		expect(result.editPlan?.title).toBe("Direct plan");
		expect(result.editPlan?.operations[0]).toMatchObject({
			type: "update_element",
			patch: { params: { content: "HELLO" } },
		});
		expect(requestBody?.tools).toEqual([]);
	});

	test("falls back to tools when the direct edit plan is malformed", async () => {
		let callCount = 0;
		let secondRequestBody: Record<string, unknown> | null = null;
		globalThis.fetch = async (...fetchParameters) => {
			callCount += 1;
			const init = fetchParameters[1];
			if (callCount === 2 && typeof init?.body === "string") {
				secondRequestBody = parseRequestBody(init.body);
			}
			return new Response(
				JSON.stringify({
					response:
						callCount === 1
							? {
									id: "resp-malformed-direct",
									output_text:
										'{"title":"Bad plan","summary":"Missing patch","operations":[{"type":"update_element","trackId":"track-1","elementId":"element-1"}]}',
								}
							: {
									id: "resp-fallback",
									output_text:
										'{"title":"Fallback plan","summary":"Done","operations":[]}',
								},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await runAiAgent({
			messages: [{ role: "user", content: "change text" }],
			tools: [
				{
					type: "function",
					name: "timeline.propose_edit_plan",
					description: "",
					parameters: { type: "object", properties: {} },
				},
			],
			executeTool: async () => {
				throw new Error("No tool execution is needed for fallback text.");
			},
		});

		expect(callCount).toBe(2);
		expect(result.status).toBe("completed");
		expect(result.iterations).toBe(1);
		expect(result.editPlan?.title).toBe("Fallback plan");
		expect(getToolNames(secondRequestBody)[0]).toBe(
			"timeline_propose_edit_plan",
		);
	});

	test("isolates web research, preserves citations, and removes direct controls", async () => {
		const requestBodies: Record<string, unknown>[] = [];
		let callCount = 0;
		globalThis.fetch = async (...fetchParameters) => {
			callCount += 1;
			const init = fetchParameters[1];
			if (typeof init?.body === "string") {
				requestBodies.push(parseRequestBody(init.body));
			}
			return new Response(
				JSON.stringify({
					response:
						callCount === 1
							? {
									output: [
										{
											type: "web_search_call",
											action: {
												sources: [
													{
														url: "https://example.com/research",
														title: "Primary source",
													},
												],
											},
										},
										{
											type: "message",
											content: [
												{
													type: "output_text",
													text: "A sourced public finding.",
													annotations: [
														{
															type: "url_citation",
															url: "https://example.com/research",
															title: "Primary source",
														},
													],
												},
											],
										},
									],
									output_text: "A sourced public finding.",
								}
							: {
									output_text:
										'{"title":"Sourced plan","summary":"Done","operations":[]}',
								},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await runAiAgent({
			messages: [
				{ role: "system", content: "PRIVATE_TIMELINE_CONTEXT" },
				{ role: "user", content: "Use current public best practices" },
			],
			tools: [
				{
					type: "function",
					name: "app.get_state",
					description: "Read app state",
					parameters: { type: "object", properties: {} },
					risk: "read",
					executionPolicy: "immediate",
				},
				{
					type: "function",
					name: "playback.control",
					description: "Control playback",
					parameters: { type: "object", properties: {} },
					risk: "control",
					executionPolicy: "immediate",
				},
			],
			executeTool: async () => ({ ok: true }),
			preferDirectPlan: false,
			webResearchQuery: "public video editing best practices",
		});

		expect(callCount).toBe(2);
		expect(requestBodies[0]?.webSearch).toBe(true);
		expect(requestBodies[0]?.tools).toEqual([]);
		expect(JSON.stringify(requestBodies[0])).not.toContain(
			"PRIVATE_TIMELINE_CONTEXT",
		);
		expect(requestBodies[1]?.webSearch).toBeUndefined();
		expect(getToolNames(requestBodies[1])).toContain("app_get_state");
		expect(getToolNames(requestBodies[1])).not.toContain("playback_control");
		expect(JSON.stringify(requestBodies[1])).toContain(
			"UNTRUSTED_PUBLIC_WEB_RESEARCH",
		);
		expect(result.editPlan?.title).toBe("Sourced plan");
		expect(result.citations).toEqual([
			{
				url: "https://example.com/research",
				title: "Primary source",
			},
		]);
	});

	test("executes tool calls and returns the final edit plan", async () => {
		let callCount = 0;
		let firstRequestBody: Record<string, unknown> | null = null;
		let executedToolName = "";
		globalThis.fetch = async (...fetchParameters) => {
			const init = fetchParameters[1];
			callCount += 1;
			if (callCount === 1 && typeof init?.body === "string") {
				firstRequestBody = parseRequestBody(init.body);
			}
			return new Response(
				JSON.stringify({
					response:
						callCount === 1
							? {
									id: "resp-1",
									output: [
										{
											type: "function_call",
											call_id: "call-1",
											name: "timeline_get_visible_state",
											arguments: "{}",
										},
									],
								}
							: {
									id: "resp-2",
									output_text:
										'{"title":"No edits","summary":"Done","operations":[]}',
								},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await runAiAgent({
			messages: [{ role: "user", content: "do nothing" }],
			tools: [
				{
					type: "function",
					name: "timeline.get_visible_state",
					description: "",
					parameters: { type: "object", properties: {} },
				},
			],
			executeTool: async (toolCall) => {
				executedToolName = toolCall.name;
				return { ok: true };
			},
		});

		expect(result.status).toBe("completed");
		expect(result.iterations).toBe(2);
		expect(result.editPlan?.title).toBe("No edits");
		expect(getToolNames(firstRequestBody)[0]).toBe(
			"timeline_get_visible_state",
		);
		expect(executedToolName).toBe("timeline.get_visible_state");
	});

	test("stops when the max iteration budget is exhausted", async () => {
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					response: {
						id: "resp-loop",
						output: [
							{
								type: "function_call",
								call_id: "call-loop",
								name: "timeline_get_visible_state",
								arguments: "{}",
							},
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);

		const result = await runAiAgent({
			messages: [{ role: "user", content: "loop" }],
			tools: [
				{
					type: "function",
					name: "timeline.get_visible_state",
					description: "",
					parameters: { type: "object", properties: {} },
				},
			],
			executeTool: async () => ({ ok: true }),
			maxIterations: 2,
		});

		expect(result.status).toBe("max_iterations");
		expect(result.iterations).toBe(2);
		expect(result.error).toContain("2 step limit");
	});

	test("returns immediately when the edit-plan validation tool succeeds", async () => {
		let callCount = 0;
		globalThis.fetch = async () => {
			callCount += 1;
			return new Response(
				JSON.stringify({
					response: {
						id: "resp-plan-tool",
						output: [
							{
								type: "function_call",
								call_id: "call-plan",
								name: "timeline_propose_edit_plan",
								arguments:
									'{"plan":{"title":"Fast plan","summary":"Done","operations":[]}}',
							},
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await runAiAgent({
			messages: [{ role: "user", content: "validate this" }],
			tools: [
				{
					type: "function",
					name: "timeline.propose_edit_plan",
					description: "",
					parameters: { type: "object", properties: {} },
				},
			],
			executeTool: async () => ({
				success: true,
				plan: { title: "Fast plan", summary: "Done", operations: [] },
				errors: [],
			}),
			preferDirectPlan: false,
		});

		expect(callCount).toBe(1);
		expect(result.status).toBe("completed");
		expect(result.iterations).toBe(1);
		expect(result.editPlan?.title).toBe("Fast plan");
	});

	test("retries a validated proposal that fails the completion guard", async () => {
		let callCount = 0;
		let secondRequestBody: Record<string, unknown> | null = null;
		globalThis.fetch = async (...fetchParameters) => {
			callCount += 1;
			const init = fetchParameters[1];
			if (callCount === 2 && typeof init?.body === "string") {
				secondRequestBody = parseRequestBody(init.body);
			}
			return new Response(
				JSON.stringify({
					response:
						callCount === 1
							? {
									output: [
										{
											type: "function_call",
											call_id: "guarded-plan",
											name: "timeline_propose_edit_plan",
											arguments:
												'{"plan":{"title":"VFX only","summary":"Missing requested sound","operations":[]}}',
										},
									],
								}
							: {
									output_text:
										'{"title":"Complete","summary":"Added searched sound","operations":[{"type":"insert_library_audio_element","libraryAssetId":"audio-1","name":"Whoosh impact","startTime":0,"duration":120000}]}',
								},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await runAiAgent({
			messages: [{ role: "user", content: "add SFX" }],
			tools: [
				{
					type: "function",
					name: "timeline.propose_edit_plan",
					description: "",
					parameters: { type: "object", properties: {} },
				},
			],
			executeTool: async () => ({
				success: true,
				plan: { title: "VFX only", summary: "Missing sound", operations: [] },
				errors: [],
			}),
			preferDirectPlan: false,
			completionGuard: ({ editPlan }) =>
				editPlan?.operations.some(
					(operation) => operation.type === "insert_library_audio_element",
				)
					? null
					: "Requested SFX are missing.",
		});

		expect(callCount).toBe(2);
		expect(result.status).toBe("completed");
		expect(result.editPlan?.title).toBe("Complete");
		const secondInput = secondRequestBody?.input;
		expect(Array.isArray(secondInput)).toBe(true);
		expect(
			Array.isArray(secondInput) &&
				secondInput.some(
					(item) =>
						isRecord(item) &&
						typeof item.content === "string" &&
						item.content.includes("COMPLETION CHECK FAILED") &&
						item.content.includes("Requested SFX are missing"),
				),
		).toBe(true);
	});

	test("bounds large tool outputs before sending the next turn", async () => {
		let secondRequestBody: Record<string, unknown> | null = null;
		let callCount = 0;
		globalThis.fetch = async (...fetchParameters) => {
			callCount += 1;
			const init = fetchParameters[1];
			if (callCount === 2 && typeof init?.body === "string") {
				secondRequestBody = parseRequestBody(init.body);
			}
			return new Response(
				JSON.stringify({
					response:
						callCount === 1
							? {
									id: "resp-large-tool",
									output: [
										{
											type: "reasoning",
											id: "rs-1",
										},
										{
											type: "message",
											content: [
												{
													type: "output_text",
													text: "Inspecting the layer.",
												},
											],
										},
										{
											type: "function_call",
											call_id: "call-large",
											name: "timeline_get_layer",
											arguments: '{"trackId":"track-1"}',
										},
									],
								}
							: {
									id: "resp-final",
									output_text:
										'{"title":"Done","summary":"Done","operations":[]}',
								},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await runAiAgent({
			messages: [{ role: "user", content: "inspect layer" }],
			tools: [
				{
					type: "function",
					name: "timeline.get_layer",
					description: "",
					parameters: { type: "object", properties: {} },
				},
			],
			executeTool: async () => ({ text: "x".repeat(20_000) }),
		});

		const secondInput = getInputItems(secondRequestBody);
		const functionCall = secondInput.find(
			(item) => item.type === "function_call",
		);
		const functionOutput = secondInput.find(
			(item) => item.type === "function_call_output",
		);

		expect(result.status).toBe("completed");
		expect(secondRequestBody?.previousResponseId).toBeUndefined();
		expect(secondInput.some((item) => item.type === "reasoning")).toBe(false);
		expect(secondInput.some((item) => item.type === "message")).toBe(false);
		expect(functionCall?.call_id).toBe("call-large");
		expect(functionOutput?.call_id).toBe("call-large");
		expect(functionOutput?.output?.length).toBeLessThan(17_000);
		expect(functionOutput?.output).toContain('"truncated":true');
	});

	test("loads deferred tool schemas through capability search", async () => {
		let callCount = 0;
		const requestBodies: Record<string, unknown>[] = [];
		let executedTool = "";
		globalThis.fetch = async (...fetchParameters) => {
			callCount += 1;
			const init = fetchParameters[1];
			if (typeof init?.body === "string") {
				requestBodies.push(parseRequestBody(init.body));
			}
			const response =
				callCount === 1
					? {
							output: [
								{
									type: "function_call",
									call_id: "search-1",
									name: "capabilities_search",
									arguments: '{"query":"inspect layer elements"}',
								},
							],
						}
					: callCount === 2
						? {
								output: [
									{
										type: "function_call",
										call_id: "layer-1",
										name: "timeline_get_layer",
										arguments: '{"trackId":"track-1"}',
									},
								],
							}
						: {
								output_text:
									'{"title":"Inspected","summary":"Done","operations":[]}',
							};
			return new Response(JSON.stringify({ response }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const result = await runAiAgent({
			messages: [{ role: "user", content: "inspect the captions layer" }],
			tools: [
				{
					type: "function",
					name: "timeline.read_source",
					description: "Read timeline source",
					parameters: { type: "object", properties: {} },
				},
				{
					type: "function",
					name: "timeline.get_layer",
					description: "Inspect layer elements",
					parameters: { type: "object", properties: {} },
					deferLoading: true,
					category: "timeline read",
					keywords: ["layer elements", "captions"],
				},
			],
			executeTool: async (toolCall) => {
				executedTool = toolCall.name;
				return { items: [] };
			},
			toolSearch: async () => [{ name: "timeline.get_layer", score: 100 }],
		});

		expect(result.status).toBe("completed");
		expect(executedTool).toBe("timeline.get_layer");
		expect(getToolNames(requestBodies[0] ?? null)).toEqual([
			"timeline_read_source",
			"capabilities_search",
		]);
		expect(getToolNames(requestBodies[1] ?? null)).toContain(
			"timeline_get_layer",
		);
	});

	test("rejects calls to deferred capabilities that were not loaded", async () => {
		let callCount = 0;
		let executeCount = 0;
		let secondRequestBody: Record<string, unknown> | null = null;
		globalThis.fetch = async (...fetchParameters) => {
			callCount += 1;
			const init = fetchParameters[1];
			if (callCount === 2 && typeof init?.body === "string") {
				secondRequestBody = parseRequestBody(init.body);
			}
			return new Response(
				JSON.stringify({
					response:
						callCount === 1
							? {
									output: [
										{
											type: "function_call",
											call_id: "unauthorized-1",
											name: "timeline_get_layer",
											arguments: '{"trackId":"track-1"}',
										},
									],
								}
							: {
									output_text:
										'{"title":"Denied","summary":"Tool unavailable","operations":[]}',
								},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await runAiAgent({
			messages: [{ role: "user", content: "inspect a layer" }],
			tools: [
				{
					type: "function",
					name: "timeline.read_source",
					description: "Read source",
					parameters: { type: "object", properties: {} },
				},
				{
					type: "function",
					name: "timeline.get_layer",
					description: "Read layer",
					parameters: { type: "object", properties: {} },
					deferLoading: true,
				},
			],
			executeTool: async () => {
				executeCount += 1;
				return {};
			},
		});

		const deniedOutput = getInputItems(secondRequestBody).find(
			(item) =>
				item.call_id === "unauthorized-1" &&
				item.type === "function_call_output",
		)?.output;
		expect(result.status).toBe("completed");
		expect(executeCount).toBe(0);
		expect(deniedOutput).toContain("not loaded or is not authorized");
	});

	test("executes independent idempotent reads in parallel", async () => {
		let callCount = 0;
		let activeCalls = 0;
		let maximumConcurrency = 0;
		globalThis.fetch = async () => {
			callCount += 1;
			return new Response(
				JSON.stringify({
					response:
						callCount === 1
							? {
									output: [
										{
											type: "function_call",
											call_id: "read-1",
											name: "app_get_state",
											arguments: "{}",
										},
										{
											type: "function_call",
											call_id: "read-2",
											name: "catalog_list",
											arguments: '{"domain":"effects"}',
										},
									],
								}
							: {
									output_text:
										'{"title":"Read","summary":"Done","operations":[]}',
								},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const result = await runAiAgent({
			messages: [{ role: "user", content: "inspect app and effects" }],
			tools: [
				{
					type: "function",
					name: "app.get_state",
					description: "Read state",
					parameters: { type: "object", properties: {} },
					readOnly: true,
					idempotent: true,
				},
				{
					type: "function",
					name: "catalog.list",
					description: "List catalog",
					parameters: { type: "object", properties: {} },
					readOnly: true,
					idempotent: true,
				},
			],
			executeTool: async () => {
				activeCalls += 1;
				maximumConcurrency = Math.max(maximumConcurrency, activeCalls);
				await new Promise((resolve) => setTimeout(resolve, 0));
				activeCalls -= 1;
				return { ok: true };
			},
		});

		expect(result.status).toBe("completed");
		expect(maximumConcurrency).toBe(2);
	});

	test("compacts long runs without orphaning tool calls", async () => {
		let callCount = 0;
		const requestBodies: Record<string, unknown>[] = [];
		globalThis.fetch = async (...fetchParameters) => {
			callCount += 1;
			const init = fetchParameters[1];
			if (typeof init?.body === "string") {
				requestBodies.push(parseRequestBody(init.body));
			}
			const response =
				callCount < 12
					? {
							output: [0, 1, 2].map((offset) => ({
								type: "function_call",
								call_id: `read-${callCount}-${offset}`,
								name: "app_get_state",
								arguments: "{}",
							})),
						}
					: {
							output_text:
								'{"title":"Compacted","summary":"Done","operations":[]}',
						};
			return new Response(JSON.stringify({ response }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const result = await runAiAgent({
			messages: [{ role: "user", content: "keep inspecting" }],
			tools: [
				{
					type: "function",
					name: "app.get_state",
					description: "Read state",
					parameters: { type: "object", properties: {} },
					readOnly: true,
					idempotent: true,
				},
			],
			executeTool: async () => ({ ok: true }),
			maxIterations: 12,
		});

		const finalInput = requestBodies.at(-1)?.input;
		expect(result.status).toBe("completed");
		expect(Array.isArray(finalInput)).toBe(true);
		if (!Array.isArray(finalInput)) return;
		expect(finalInput.length).toBeLessThanOrEqual(36);
		expect(
			finalInput.some(
				(item) =>
					isRecord(item) &&
					typeof item.content === "string" &&
					item.content.includes("were compacted"),
			),
		).toBe(true);
		const calls = finalInput.filter(
			(item) => isRecord(item) && item.type === "function_call",
		);
		const outputIds = new Set(
			finalInput.flatMap((item) =>
				isRecord(item) &&
				item.type === "function_call_output" &&
				typeof item.call_id === "string"
					? [item.call_id]
					: [],
			),
		);
		for (const call of calls) {
			expect(outputIds.has(String(call.call_id))).toBe(true);
		}
	});

	test("sends preview frames as multimodal tool output", async () => {
		let secondRequestBody: Record<string, unknown> | null = null;
		let callCount = 0;
		globalThis.fetch = async (...fetchParameters) => {
			callCount += 1;
			const init = fetchParameters[1];
			if (callCount === 2 && typeof init?.body === "string") {
				secondRequestBody = parseRequestBody(init.body);
			}
			return new Response(
				JSON.stringify({
					response:
						callCount === 1
							? {
									output: [
										{
											type: "function_call",
											call_id: "preview-1",
											name: "preview_capture_frame",
											arguments: "{}",
										},
									],
								}
							: {
									output_text:
										'{"title":"Seen","summary":"Done","operations":[]}',
								},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		await runAiAgent({
			messages: [{ role: "user", content: "inspect preview" }],
			tools: [
				{
					type: "function",
					name: "preview.capture_frame",
					description: "Capture preview",
					parameters: { type: "object", properties: {} },
				},
			],
			executeTool: async () => ({
				success: true,
				filename: "preview.png",
				mimeType: "image/png",
				dataUrl: "data:image/png;base64,AAAA",
			}),
		});

		const rawInput = secondRequestBody?.input;
		expect(Array.isArray(rawInput)).toBe(true);
		const output = Array.isArray(rawInput)
			? rawInput.find(
					(item) => isRecord(item) && item.type === "function_call_output",
				)
			: null;
		expect(isRecord(output) && Array.isArray(output.output)).toBe(true);
		if (isRecord(output) && Array.isArray(output.output)) {
			expect(output.output).toContainEqual({
				type: "input_image",
				image_url: "data:image/png;base64,AAAA",
				detail: "low",
			});
		}
	});

	test("bounds range preview storyboards and sends them as low-detail images", async () => {
		let secondRequestBody: Record<string, unknown> | null = null;
		let callCount = 0;
		globalThis.fetch = async (...fetchParameters) => {
			callCount += 1;
			const init = fetchParameters[1];
			if (callCount === 2 && typeof init?.body === "string") {
				secondRequestBody = parseRequestBody(init.body);
			}
			return new Response(
				JSON.stringify({
					response:
						callCount === 1
							? {
									output: [
										{
											type: "function_call",
											call_id: "range-preview-1",
											name: "preview_capture_range_frames",
											arguments: "{}",
										},
									],
								}
							: {
									output_text:
										'{"title":"Seen","summary":"Done","operations":[]}',
								},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			);
		};

		const oversized = `data:image/jpeg;base64,${"A".repeat(121_001)}`;
		await runAiAgent({
			messages: [{ role: "user", content: "inspect the selected range" }],
			tools: [
				{
					type: "function",
					name: "preview.capture_range_frames",
					description: "Capture representative range frames",
					parameters: { type: "object", properties: {} },
				},
			],
			executeTool: async () => ({
				success: true,
				frameCount: 6,
				range: { startTime: 0, endTime: 2_400_000 },
				frames: [
					{ time: 1, dataUrl: oversized },
					...Array.from({ length: 5 }, (_, index) => ({
						time: index + 2,
						timeSeconds: index + 0.5,
						filename: `frame-${index}.jpg`,
						mimeType: "image/jpeg",
						byteSize: 4,
						dataUrl: `data:image/jpeg;base64,AAA${index}`,
					})),
				],
			}),
		});

		const rawInput = secondRequestBody?.input;
		expect(Array.isArray(rawInput)).toBe(true);
		const output = Array.isArray(rawInput)
			? rawInput.find(
					(item) =>
						isRecord(item) &&
						item.type === "function_call_output" &&
						item.call_id === "range-preview-1",
				)
			: null;
		expect(isRecord(output) && Array.isArray(output.output)).toBe(true);
		if (isRecord(output) && Array.isArray(output.output)) {
			const images = output.output.filter(
				(item) => isRecord(item) && item.type === "input_image",
			);
			expect(images).toHaveLength(4);
			expect(
				images.every(
					(item) =>
						isRecord(item) &&
						item.detail === "low" &&
						item.image_url !== oversized,
				),
			).toBe(true);
			const textItem = output.output.find(
				(item) => isRecord(item) && item.type === "input_text",
			);
			expect(isRecord(textItem) && String(textItem.text)).toContain(
				'"imagesIncluded":4',
			);
			expect(isRecord(textItem) && String(textItem.text)).not.toContain(
				"data:image",
			);
		}
	});
});

function parseRequestBody(value: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(value);
	if (!isRecord(parsed)) {
		throw new Error("Expected request body to be a JSON object");
	}
	return parsed;
}

function getToolNames(body: Record<string, unknown> | null): string[] {
	const tools = body?.tools;
	if (!Array.isArray(tools)) {
		return [];
	}
	return tools.map((tool) =>
		isRecord(tool) && typeof tool.name === "string" ? tool.name : "",
	);
}

function getInputItems(
	body: Record<string, unknown> | null,
): RequestInputItem[] {
	const input = body?.input;
	if (!Array.isArray(input)) {
		return [];
	}
	return input.filter(isRecord).map((item) => ({
		type: typeof item.type === "string" ? item.type : undefined,
		output: typeof item.output === "string" ? item.output : undefined,
		call_id: typeof item.call_id === "string" ? item.call_id : undefined,
	}));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
