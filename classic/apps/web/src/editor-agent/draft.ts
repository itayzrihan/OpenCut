/** UI-only handoff. This fills the composer; it never starts a model run. */
export const EDITING_AGENT_DRAFT_EVENT = "opencut:editing-agent-draft";

export function offerEditingAgentDraft({
	projectId,
	text,
}: {
	projectId: string;
	text: string;
}) {
	window.dispatchEvent(
		new CustomEvent(EDITING_AGENT_DRAFT_EVENT, {
			detail: {
				projectId,
				accountId: window.__opencutAccountId ?? "local",
				text,
			},
		}),
	);
}
