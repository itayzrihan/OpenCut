import { z } from "zod";
const voice = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const audioDraftSchema = z
	.object({
		id: z.string().min(1).max(128),
		version: z.number().int().positive(),
		title: z.string().trim().min(1).max(300),
		kind: z.enum(["speech", "dialogue", "sound", "music"]),
		modelId: z.string().regex(/^[A-Za-z0-9_.-]{1,120}$/),
		text: z.string().max(12000),
		voiceId: voice.nullable().optional(),
		durationSeconds: z.number().finite().nullable().optional(),
		instrumental: z.boolean().default(false),
		dialogue: z
			.array(
				z
					.object({ text: z.string().trim().min(1).max(2000), voiceId: voice })
					.strict(),
			)
			.max(50)
			.default([]),
	})
	.strict()
	.superRefine((d, ctx) => {
		const fail = (message: string) => ctx.addIssue({ code: "custom", message });
		if (d.text.includes("\0") || d.id.includes("\0"))
			fail("Invalid control character");
		if (
			d.kind === "speech" &&
			(!d.voiceId || !d.text.trim() || d.text.length > 10000)
		)
			fail("Speech requires a voice and 1–10000 characters");
		if (
			d.kind === "dialogue" &&
			(!d.dialogue.length ||
				d.dialogue.reduce((n, l) => n + [...l.text].length, 0) > 2000 ||
				new Set(d.dialogue.map((l) => l.voiceId)).size > 10)
		)
			fail("Dialogue allows 2000 characters and 10 voices");
		if (d.kind === "sound" && (!d.text.trim() || d.text.length > 3000))
			fail("Describe the sound in up to 3000 characters");
		if (d.kind === "music" && (!d.text.trim() || d.text.length > 4100))
			fail("Describe the music in up to 4100 characters");
		if (d.durationSeconds != null) {
			const [min, max] = d.kind === "sound" ? [0.5, 30] : [3, 600];
			if (d.durationSeconds < min || d.durationSeconds > max)
				fail(`Duration must be ${min}–${max} seconds`);
		}
	});
export type AudioDraft = z.infer<typeof audioDraftSchema>;
export type AudioJob = {
	id: string;
	projectId: string;
	digest: string;
	draft: AudioDraft;
	status:
		| "review"
		| "submitted"
		| "ready"
		| "failed"
		| "uncertain"
		| "cancelled";
	createdAt: number;
	message?: string;
	output?: import("@/generative/types").DirectorReference;
};
export type AudioStatus = {
	configured: boolean;
	sessionSeconds: number;
	jobs: AudioJob[];
};
