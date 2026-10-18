import { withAccount } from "@/accounts/server";
import {
	readExternalSettings,
	publicExternalSettings,
	saveExternalSettings,
	boundedBytes,
} from "@/transcription/external-server";
export const runtime = "nodejs";
export const GET = withAccount(async () =>
	Response.json(publicExternalSettings(await readExternalSettings())),
);
export const PUT = withAccount(async (request: Request) => {
	try {
		const body = await boundedBytes({ body: request.body, limit: 8192 });
		return Response.json(
			await saveExternalSettings(JSON.parse(new TextDecoder().decode(body))),
		);
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof Error && error.name !== "ZodError"
						? error.message
						: "Invalid transcription API settings",
			},
			{ status: 400 },
		);
	}
});
