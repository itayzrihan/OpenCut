import type { EditingInputAttachment } from "@/core/agent-protocol";
import type { MediaAsset } from "@/media/types";
import type { TimelineDragData } from "@/timeline/drag";
import { TIMELINE_DRAG_MIME } from "@/timeline/drag-source";
import { z } from "zod";

export const PROJECT_MEDIA_REFERENCE_MIME =
	"application/vnd.opencut.media-reference+json";

export function draggedProjectMedia({
	types,
	active,
}: {
	types: readonly string[];
	active: TimelineDragData | null;
}) {
	return types.includes(TIMELINE_DRAG_MIME) && active?.type === "media"
		? active.id
		: undefined;
}

export function projectMediaAttachment({
	projectId,
	asset,
}: {
	projectId: string;
	asset: Pick<MediaAsset, "id" | "name" | "type">;
}) {
	if (!["image", "video", "audio"].includes(asset.type))
		throw new Error("Only images, video and audio can be attached from Media");
	return {
		filename:
			Array.from(asset.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""))
				.slice(0, 64)
				.join("")
				.trim() || asset.type,
		mimeType: PROJECT_MEDIA_REFERENCE_MIME,
		bytes: new TextEncoder().encode(
			JSON.stringify({ projectId, mediaId: asset.id }),
		),
	};
}

export function mergeAttachments({
	current,
	added,
}: {
	current: EditingInputAttachment[];
	added: EditingInputAttachment[];
}) {
	const unique = new Map(
		[...current, ...added].map((item) => [item.artifactId, item]),
	);
	if (unique.size > 8) throw new Error("Attach at most eight files");
	return [...unique.values()];
}

const referenceSchema = z
	.object({
		projectId: z.string().min(1).max(256),
		mediaId: z.string().min(1).max(256),
	})
	.strict();

export function readProjectMediaReference({
	mimeType,
	bytes,
}: {
	mimeType: string;
	bytes: number[] | Uint8Array;
}) {
	if (mimeType !== PROJECT_MEDIA_REFERENCE_MIME || bytes.length > 1024)
		return undefined;
	try {
		return referenceSchema.parse(
			JSON.parse(new TextDecoder().decode(Uint8Array.from(bytes))),
		);
	} catch {
		return undefined;
	}
}
