import { GET as serve } from "@/app/api/global-assets/[...path]/route";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Compatibility for pre-account project URLs. Only published audio may resolve.
// eslint-disable-next-line opencut/prefer-object-params -- Next route handlers receive request and context positionally.
export async function GET(
	request: Request,
	context: { params: Promise<{ path: string[] }> },
) {
	return serve(request, {
		params: Promise.resolve({
			path: ["shared-library", ...(await context.params).path],
		}),
	});
}
export const HEAD = GET;
