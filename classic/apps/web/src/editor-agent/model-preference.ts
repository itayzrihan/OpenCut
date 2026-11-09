import { z } from "zod";

const modelPreferenceSchema = z.object({
	model: z.string().min(1).max(100),
	reasoningEffort: z
		.string()
		.regex(/^[a-z][a-z0-9_]{0,31}$/)
		.optional(),
});
type ModelPreference = z.infer<typeof modelPreferenceSchema>;

function key() {
	return `opencut-agent-model:${window.__opencutAccountId ?? "local"}`;
}

export function readAgentModelPreference(): ModelPreference | undefined {
	try {
		const value: unknown = JSON.parse(
			window.localStorage.getItem(key()) ?? "null",
		);
		return modelPreferenceSchema.safeParse(value).data;
	} catch {
		// Browser storage may be disabled.
	}
}

export function saveAgentModelPreference(preference: ModelPreference) {
	try {
		window.localStorage.setItem(key(), JSON.stringify(preference));
	} catch {
		// The active model remains available to the Agent without persistence.
	}
}

export const agentModelSchema = z.object({
	id: z.string().min(1).max(100),
	name: z.string().max(200).optional(),
	reasoningEfforts: z.array(z.string()).optional(),
	defaultReasoningEffort: z.string().optional(),
});

export function preferredAgentModel(
	models: z.infer<typeof agentModelSchema>[],
) {
	const preference = readAgentModelPreference();
	const selected = models.find((item) => item.id === preference?.model);
	const model = selected ?? models[0];
	const effort = preference?.reasoningEffort;
	return {
		model: model?.id,
		reasoningEffort:
			selected && effort && selected.reasoningEfforts?.includes(effort)
				? effort
				: model?.defaultReasoningEffort,
	};
}
