import { z } from "zod";

export const SCRIPT_ASSET_DRAG = "application/x-opencut-script-asset";

const scriptReference = z
	.object({
		projectId: z.string().min(1).max(128),
		scriptId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
	})
	.strict();

export function readScriptDrag(data: DataTransfer) {
	const payload = data.getData(SCRIPT_ASSET_DRAG);
	if (!payload || payload.length > 1024) return;
	try {
		return scriptReference.parse(JSON.parse(payload));
	} catch {
		return;
	}
}
