import { z } from "zod";
import { streamChatGPTResponse } from "./chatgpt";

const requestSchema = z
	.object({
		model: z.string().min(1).max(100),
		instructions: z.string().min(1).max(32_000),
		input: z.array(z.unknown()).min(1).max(256),
		tools: z
			.tuple([
				z
					.object({
						type: z.literal("function"),
						name: z.literal("opencut_editor"),
						description: z.string().max(8000),
						parameters: z.record(z.string(), z.unknown()),
						strict: z.literal(false),
					})
					.strict(),
			])
			.or(z.tuple([])),
	})
	.strict();

/** Streaming transport only. Rust produces the provider request and validates
 * every resulting action against the live registry in the active editor. */
export async function handleEditorAgentResponse(
	request: Request,
): Promise<Response> {
	const reader = request.body?.getReader();
	if (!reader)
		return Response.json({ error: "Missing request" }, { status: 400 });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			size += part.value.byteLength;
			if (size > 4_000_000) {
				await reader.cancel();
				return Response.json(
					{ error: "Agent context is too large" },
					{ status: 413 },
				);
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return Response.json({ error: "Invalid agent request" }, { status: 400 });
	}
	const input = requestSchema.safeParse(json);
	if (!input.success)
		return Response.json({ error: "Invalid agent request" }, { status: 400 });
	try {
		return await streamChatGPTResponse({
			body: {
				...input.data,
				reasoning: { effort: "high", summary: "auto" },
				include: ["reasoning.encrypted_content"],
				parallel_tool_calls: false,
			},
			signal: request.signal,
		});
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof Error ? error.message : "ChatGPT request failed",
			},
			{ status: 502 },
		);
	}
}
