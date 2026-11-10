import { z } from "zod";
import { generateJournaledImage } from "./image-journal";
import {
	completedStream,
	imageRequestSchema,
	localProviderSchema,
	localRequestSchema,
} from "./protocol";
import type { NativeProvider } from "./native-providers";
import type { CompanionHandler } from "./server";

/** This is the entire local HTTP surface; provider credentials never cross it. */
export function companionHandler({
	providers,
	imageRoot,
}: {
	providers: Record<"codex" | "claude", NativeProvider>;
	imageRoot?: string;
}): CompanionHandler {
	return async ({ path, method, body, signal, provider }) => {
		const native = providers[localProviderSchema.parse(provider)];
		try {
			const parsed = body.length
				? JSON.parse(new TextDecoder().decode(body))
				: {};
			if (path === "/api/editor-agent/connection") {
				if (method === "GET") return Response.json(await native.status());
				const input = z
					.object({ operation: z.enum(["signIn", "disconnect", "models"]) })
					.strict()
					.parse(parsed);
				if (input.operation === "models")
					return Response.json({ models: await native.models(signal) });
				if (input.operation === "signIn")
					return Response.json(await native.signIn());
				await native.disconnect();
				return Response.json({ revocationConfirmed: true });
			}
			if (path === "/api/ai/oauth/status") {
				const s = await native.status();
				return Response.json({
					authenticated: s.sharing,
					identity: s.identity,
					error: s.error,
					provider: s.provider,
					imageGenerationSupported: s.imageGenerationSupported,
				});
			}
			if (path === "/api/ai/models")
				return Response.json({
					models: await native.models(signal),
					authenticated: (await native.status()).sharing,
				});
			if (path === "/api/ai/local-image") {
				const input = imageRequestSchema.parse(parsed);
				if (!imageRoot) throw new Error("Local image storage is unavailable");
				return Response.json(
					await generateJournaledImage({
						root: imageRoot,
						provider: native,
						request: input,
						signal,
					}),
				);
			}
			if (path === "/api/editor-agent/respond")
				return completedStream(
					await native.respond({
						request: localRequestSchema.parse(parsed),
						signal: signal,
					}),
				);
			if (path === "/api/ai/chat") {
				const input = z
					.object({
						input: z.array(z.unknown()).min(1).max(40),
						tools: z.array(z.unknown()).max(12).optional(),
						model: z.string().max(100).optional(),
						reasoningEffort: z.string().max(32).optional(),
						webSearch: z.boolean().optional(),
					})
					.strict()
					.parse(parsed);
				if (input.webSearch)
					throw new Error(
						"Web search is unavailable through the local editing connection",
					);
				const instructions = input.input.flatMap((item) => {
					const result = z
						.object({ role: z.literal("system"), content: z.string() })
						.safeParse(item);
					return result.success ? [result.data.content] : [];
				});
				const model = input.model ?? (await native.models(signal))[0]?.id;
				const request = localRequestSchema.parse({
					model,
					input: input.input.filter(
						(item) =>
							!(
								item &&
								typeof item === "object" &&
								"role" in item &&
								item.role === "system"
							),
					),
					tools: input.tools ?? [],
					instructions: instructions.join("\n\n"),
					...(input.reasoningEffort
						? { reasoningEffort: input.reasoningEffort }
						: {}),
				});
				return Response.json({
					response: await native.respond({ request: request, signal: signal }),
				});
			}
			return Response.json(
				{ error: "Unsupported local AI operation" },
				{ status: 404 },
			);
		} catch (error) {
			return Response.json(
				{
					error:
						error instanceof z.ZodError || error instanceof SyntaxError
							? "Invalid local AI request"
							: error instanceof Error
								? error.message
								: "Local provider failed",
				},
				{ status: 400, headers: { "X-OpenCut-Provider-Retry": "never" } },
			);
		}
	};
}
