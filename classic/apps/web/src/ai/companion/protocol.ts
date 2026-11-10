import { z } from "zod";

export const localProviderSchema = z.enum(["codex", "claude"]);
export type LocalProvider = z.infer<typeof localProviderSchema>;
export const localRequestSchema = z
	.object({
		model: z.string().min(1).max(100),
		instructions: z.string().max(64_000).optional(),
		input: z.array(z.unknown()).min(1).max(256),
		tools: z
			.array(
				z.object({
					type: z.literal("function"),
					name: z.string().regex(/^[a-zA-Z0-9_]{1,80}$/),
					description: z.string().max(8000).optional(),
					parameters: z.record(z.string(), z.unknown()),
					strict: z.boolean().optional(),
				}),
			)
			.max(12)
			.default([]),
		reasoningEffort: z.string().max(32).optional(),
	})
	.strict();
export type LocalRequest = z.infer<typeof localRequestSchema>;
export interface LocalModel {
	id: string;
	name: string;
	reasoningEfforts?: string[];
}
export interface LocalStatus {
	connected: boolean;
	sharing: boolean;
	connecting: boolean;
	identity: { name?: string; email?: string } | null;
	error: string | null;
	usageUrl: string;
	provider: "local-codex" | "local-claude";
	installed: boolean;
	imageGenerationSupported: boolean;
	authenticationRequired: boolean;
}
export const imageRequestSchema = z
	.object({
		projectId: z.string().min(1).max(128),
		operationId: z.string().min(1).max(160),
		prompt: z.string().trim().min(1).max(16000),
		references: z
			.array(
				z
					.string()
					.max(3_000_000)
					.regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
			)
			.max(4)
			.default([]),
		confirmed: z.literal(true),
		model: z.string().min(1).max(100).optional(),
	})
	.strict();
export type ImageRequest = z.infer<typeof imageRequestSchema>;

/** Models propose registered operations; the browser's Rust runtime executes them. */
export function proposalSchema(request: LocalRequest) {
	return {
		type: "object",
		properties: {
			text: { type: "string" },
			calls: {
				type: "array",
				maxItems: request.tools.length ? 4 : 0,
				items: {
					type: "object",
					properties: {
						name: {
							type: "string",
							...(request.tools.length
								? { enum: request.tools.map((t) => t.name) }
								: {}),
						},
						arguments: { type: "string" },
					},
					required: ["name", "arguments"],
					additionalProperties: false,
				},
			},
		},
		required: ["text", "calls"],
		additionalProperties: false,
	};
}
export function proposalResponse({
	raw,
	request,
}: {
	raw: unknown;
	request: LocalRequest;
}) {
	const parsed = z
		.object({
			text: z.string().max(500_000),
			calls: z
				.array(
					z
						.object({ name: z.string(), arguments: z.string().max(500_000) })
						.strict(),
				)
				.max(4),
		})
		.strict()
		.parse(raw);
	const allowed = new Set(request.tools.map((tool) => tool.name));
	for (const call of parsed.calls) {
		if (!allowed.has(call.name))
			throw new Error(
				"The local provider proposed an unavailable editor operation",
			);
		const args: unknown = JSON.parse(call.arguments);
		if (!args || typeof args !== "object" || Array.isArray(args))
			throw new Error("Invalid editor operation arguments");
	}
	return {
		id: crypto.randomUUID(),
		status: "completed",
		output_text: parsed.text,
		output: [
			...(parsed.text
				? [
						{
							type: "message",
							role: "assistant",
							content: [{ type: "output_text", text: parsed.text }],
						},
					]
				: []),
			...parsed.calls.map((call) => ({
				type: "function_call",
				id: crypto.randomUUID(),
				call_id: crypto.randomUUID(),
				name: call.name,
				arguments: call.arguments,
			})),
		],
	};
}
export function planningPrompt(request: LocalRequest) {
	return (
		"You are the POCUT editing assistant. Return the required JSON proposal. You cannot execute editor tools here; the active browser validates and executes the returned calls. Do not run shell commands, read local files, use the network, or invent results. Available function definitions and conversation follow.\n" +
		JSON.stringify(request, (_key, value) =>
			typeof value === "string" && /^data:image\//.test(value)
				? "[image provided as a native image attachment]"
				: value,
		)
	);
}
export function planningImages(request: LocalRequest): string[] {
	const images: string[] = [];
	JSON.stringify(request.input, (_key, value) => {
		if (typeof value === "string" && /^data:image\//.test(value)) {
			if (
				!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value) ||
				value.length > 3_000_000
			)
				throw new Error("Unsupported or oversized image attachment");
			if (!images.includes(value)) images.push(value);
		}
		return value;
	});
	if (images.length > 4)
		throw new Error(
			"The local connection accepts up to four image attachments per request",
		);
	return images;
}
export function completedStream(response: unknown) {
	return new Response(
		`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
		{
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-store",
				"X-OpenCut-Provider-Retry": "never",
			},
		},
	);
}
