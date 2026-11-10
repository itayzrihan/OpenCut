import { z } from "zod";
import { audioDraftSchema } from "./types";
import { audioApi } from "./client";
import type { AudioJob } from "./types";
import type {
	EditingAgentHostEffect,
	EditingAgentHostResult,
} from "@/core/agent-protocol";
import { useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { useDirectorStudioTab } from "@/generative/studio-tab";
export async function performAudioProductionEffect({
	effect,
	accountId,
	signal,
	activeProjectId,
	currentRevision,
}: {
	effect: EditingAgentHostEffect;
	accountId: string;
	signal: AbortSignal;
	activeProjectId?: () => string | undefined;
	currentRevision?: () => number | undefined;
}): Promise<EditingAgentHostResult> {
	const i = z
		.object({
			projectId: z.string(),
			expectedRevision: z.number().int(),
			operationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
			draft: audioDraftSchema,
		})
		.strict()
		.parse(effect.request);
	const check = () => {
		signal.throwIfAborted();
		if (
			effect.adapter !== "audioProduction" ||
			effect.projectId !== i.projectId ||
			activeProjectId?.() !== i.projectId ||
			currentRevision?.() !== i.expectedRevision ||
			window.__opencutAccountId !== accountId
		)
			throw new Error("Audio account, project or revision changed");
	};
	check();
	const { job } = await audioApi<{ job: AudioJob }>({
		projectId: i.projectId,
		action: "prepare",
		signal,
		data: { operationId: i.operationId, draft: i.draft },
	});
	check();
	if (job.status !== "review" || job.projectId !== i.projectId)
		throw new Error("Audio review already submitted; inspect existing status");
	useDirectorStudioTab.getState().setTab("audio");
	useAssetsPanelStore.getState().setActiveTab("generative");
	return {
		type: "success",
		data: {
			projectId: i.projectId,
			revision: i.expectedRevision,
			jobId: job.id,
			digest: job.digest,
			status: "review",
		},
	};
}
