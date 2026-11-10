import { z } from "zod";

// Rust validates Unicode scalar counts, rather than JavaScript UTF-16 units.
const copy = ({ min = 0, max }: { min?: number; max: number }) =>
	z.string().refine((value) => {
		const length = Array.from(value).length;
		return length >= min && length <= max;
	}, "Storyboard copy exceeds its character limit");

const image = z
	.object({
		id: z.string().regex(/^[a-fA-F0-9]{32}$/),
		name: z.string().max(300),
		kind: z.literal("image"),
		mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
		bytes: z
			.number()
			.int()
			.nonnegative()
			.max(100 * 1024 * 1024),
		storyboard: z.boolean(),
	})
	.strict();
const scene = z
	.object({
		id: copy({ min: 1, max: 120 }),
		title: copy({ min: 1, max: 200 }),
		description: copy({ min: 1, max: 6000 }),
		startSeconds: z.number().nonnegative().max(86400).nullable(),
		endSeconds: z.number().positive().max(86400).nullable(),
		imageReferenceId: z
			.string()
			.regex(/^[a-fA-F0-9]{32}$/)
			.nullable(),
	})
	.strict();
export const storyboardPdfPlanSchema = z
	.object({
		projectId: z.string().min(1),
		revision: z.number().int().nonnegative(),
		title: copy({ min: 1, max: 200 }),
		summary: copy({ max: 6000 }),
		sheets: z.array(image).max(8),
		scenes: z.array(scene).max(96),
		sceneImages: z.array(image).max(96),
		digest: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
export type StoryboardPdfPlan = z.infer<typeof storyboardPdfPlanSchema>;
export type StoryboardPdfImage = z.infer<typeof image>;

/** No caller-provided URLs, prompts or provider metadata enter the renderer. */
export function parseStoryboardPdfPlan(value: unknown): StoryboardPdfPlan {
	const plan = storyboardPdfPlanSchema.parse(value);
	if (new TextEncoder().encode(JSON.stringify(plan)).length > 350_100)
		throw new Error("Storyboard proposal exceeds its copy budget");
	const images = new Set(plan.sceneImages.map((image) => image.id));
	if (
		(!plan.sheets.length && !plan.scenes.length) ||
		plan.scenes.some(
			(scene) =>
				(scene.imageReferenceId !== null &&
					!images.has(scene.imageReferenceId)) ||
				(scene.startSeconds === null) !== (scene.endSeconds === null) ||
				(scene.startSeconds !== null &&
					scene.endSeconds! <= scene.startSeconds),
		)
	)
		throw new Error("Invalid storyboard images or scene timing");
	return plan;
}
