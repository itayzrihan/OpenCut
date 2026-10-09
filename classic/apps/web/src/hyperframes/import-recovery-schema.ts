import { z } from "zod";

// HTTP storage envelope only. Source rules, bindings and import behavior are
// validated by the canonical runtime before an edit or authored code executes.
export const hyperframesImportDraftSchema = z
	.object({
		kind: z.literal("hyperframes"),
		name: z.string().min(1).max(1024),
		sceneId: z.string().min(1).max(160),
		startSeconds: z.number().finite().nonnegative().optional(),
		source: z
			.object({
				entryFile: z.string(),
				files: z.record(z.string(), z.string()),
				resourceAssetIds: z.record(z.string(), z.string()),
				variables: z.record(z.string(), z.unknown()).optional(),
			})
			.strict(),
		resources: z
			.array(
				z
					.object({
						id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
						name: z.string(),
						type: z.enum(["image", "audio", "video", "file"]),
						size: z.number().finite().nonnegative(),
						lastModified: z.number().finite(),
						fileName: z.string(),
						mimeType: z.string(),
					})
					.strict(),
			)
			.max(512),
	})
	.strict();
