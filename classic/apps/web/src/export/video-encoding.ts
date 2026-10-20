import { canEncodeVideo } from "mediabunny";
import type { ExportPlan } from "./index";

/** Host capability check: never silently trade away the chosen codec or size. */
export async function checkExportEncoder(
	plan: ExportPlan,
): Promise<string | null> {
	try {
		if (
			await canEncodeVideo(plan.codec, {
				width: plan.width,
				height: plan.height,
				bitrate: plan.videoBitrate,
				bitrateMode: "variable",
				latencyMode: "quality",
			})
		)
			return null;
	} catch {
		/* Same actionable message for unsupported encoder configurations. */
	}
	return plan.codec === "hevc"
		? "HEVC encoding is unavailable at this resolution in this browser. Choose Compatible H.264 or use a browser with HEVC encoding."
		: "The selected encoder cannot export this resolution. Choose a smaller project canvas or another format.";
}
