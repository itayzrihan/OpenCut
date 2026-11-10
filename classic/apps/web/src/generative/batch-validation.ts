import { z } from "zod";
import type { EditorCore } from "@/core";
import { scope } from "./client";
import { planSeamless } from "./seamless-connect";
import { planReplace } from "./replace-clip";
import type { DirectorBatch, DirectorJob } from "./types";
export function matchBatchJobs({
	batch,
	jobs,
	projectId,
}: {
	batch: DirectorBatch | null;
	jobs: DirectorJob[];
	projectId: string;
}) {
	const matched =
		batch?.jobs.flatMap((item) => {
			const job = jobs.find(
				(j) =>
					j.id === item.id &&
					j.digest === item.digest &&
					j.projectId === projectId,
			);
			return job ? [job] : [];
		}) ?? [];
	return {
		jobs: matched,
		complete:
			!!batch &&
			batch.projectId === projectId &&
			matched.length === batch.jobs.length,
	};
}
/** Same canonical source guard for the docked Agent, single review and batch review. */
export function validateChapterBatch({
	editor,
	jobs,
}: {
	editor: EditorCore;
	jobs: DirectorJob[];
}) {
	const current = scope(editor);
	for (const job of jobs) {
		if (job.projectId !== current.projectId)
			throw new Error("Review project changed");
		if (job.seamless) {
			const { anchor, ...target } = job.seamless;
			if (planSeamless({ editor, target }).anchor !== anchor)
				throw new Error(
					"The source clips changed. Prepare the connection again.",
				);
		}
		if (
			job.replacement &&
			planReplace({ editor, target: job.replacement }).anchor !==
				job.replacement.anchor
		)
			throw new Error("The replacement source changed. Prepare it again.");
	}
	for (const planId of new Set(
		jobs.flatMap((j) => (j.chapter ? [j.chapter.planId] : [])),
	)) {
		const result = z
			.object({
				plan: z.object({
					version: z.number().int(),
					chapters: z.array(z.object({ id: z.string(), prompt: z.string() })),
				}),
			})
			.parse(
				editor.command.invokeCanonicalControl({
					...current,
					capabilityId: "project.generative.chapters.validate",
					input: { planId },
				}),
			);
		if (
			jobs
				.filter((j) => j.chapter?.planId === planId)
				.some(
					(job) =>
						job.chapter?.planVersion !== result.plan.version ||
						!result.plan.chapters.some(
							(chapter) =>
								chapter.id === job.chapter?.chapterId &&
								chapter.prompt === job.prompt,
						),
				)
		)
			throw new Error(
				"The frozen chapter request differs from the current plan. Prepare the current version again.",
			);
	}
}
