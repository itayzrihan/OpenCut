/** Expiring bearer link for provider ingestion; never exposes account state. */
import { readFile } from "node:fs/promises";
import { sharedArtifact } from "@/generative/server/shares";
export const runtime = "nodejs";
// Next.js route ABI receives Request and route context positionally.
// eslint-disable-next-line opencut/prefer-object-params
export async function GET(
	_request: Request,
	{ params }: { params: Promise<{ token: string }> },
) {
	try {
		const { token } = await params,
			f = await sharedArtifact(token);
		return new Response(new Uint8Array(await readFile(f.path)), {
			headers: {
				"Content-Type": f.info.mime,
				"Content-Length": String(f.info.bytes),
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
				"Referrer-Policy": "no-referrer",
			},
		});
	} catch {
		return new Response("Unavailable", { status: 404 });
	}
}
