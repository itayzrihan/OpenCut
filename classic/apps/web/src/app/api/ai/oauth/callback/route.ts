export const runtime = "nodejs";

export function GET() {
	return Response.json(
		{
			error:
				"The separate Codex sign-in was retired. Connect ChatGPT in the POCUT Agent.",
		},
		{ status: 410, headers: { "Cache-Control": "no-store" } },
	);
}
