import { withAccount, requireAccount } from "@/accounts/server";
import {
	readExternalSettings,
	requestExternalTranscript,
	ExternalProviderError,
	boundedBytes,
} from "@/transcription/external-server";
import { createTranscriptionLimit } from "@/transcription/request-limit";
const limit = createTranscriptionLimit();
export const runtime = "nodejs";
export const POST = withAccount(
	(request: Request) =>
		limit({
			account: requireAccount().id,
			run: () => handle(request),
		}),
	{ concurrent: true },
);
async function handle(request: Request) {
	try {
		const config = await readExternalSettings();
		if (!config)
			return Response.json(
				{ error: "Configure a transcription API key in Captions first." },
				{ status: 400 },
			);
		const bytes = await boundedBytes({ body: request.body, limit: 3_000_000 });
		const form = await new Response(bytes, {
			headers: { "Content-Type": request.headers.get("Content-Type") ?? "" },
		}).formData();
		if (form.get("configuration") !== config.id)
			return Response.json(
				{
					error:
						"Transcription API settings changed. Start a new transcript with the current settings.",
				},
				{ status: 409 },
			);
		const audio = form.get("audio");
		const language = String(form.get("language") ?? "auto");
		if (!(audio instanceof Blob) || !/^([a-z]{2,3}|auto)$/.test(language))
			return Response.json(
				{ error: "Invalid audio window or language" },
				{ status: 400 },
			);
		return Response.json(
			await requestExternalTranscript({
				config,
				audio,
				language,
				signal: request.signal,
			}),
		);
	} catch (error) {
		if (request.signal.aborted)
			return Response.json(
				{ error: "Transcription cancelled" },
				{ status: 499 },
			);
		if (error instanceof ExternalProviderError)
			return Response.json(
				{ error: error.message },
				{
					status: error.status === 429 ? 429 : error.status >= 500 ? 503 : 400,
				},
			);
		return Response.json(
			{
				error:
					error instanceof Error &&
					/^The API model must support|^Transcription payload exceeds|^Expected a bounded/.test(
						error.message,
					)
						? error.message
						: "Could not complete transcription API request. Check endpoint and word timestamp support.",
			},
			{
				status:
					error instanceof TypeError ||
					(error instanceof DOMException && error.name === "TimeoutError")
						? 503
						: 502,
			},
		);
	}
}
