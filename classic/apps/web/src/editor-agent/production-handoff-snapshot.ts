import type { DirectorDocument } from "@/generative/types";

/** Runtime reads deserialize the handoff each time. External-store snapshots
 * must contain stable primitives, not the newly allocated nested document. */
export function productionHandoffSnapshot({
	projectId,
	handoff,
}: {
	projectId: string;
	handoff: DirectorDocument["productionHandoff"];
}) {
	return {
		projectId,
		handoffId: handoff?.id ?? "",
		referenceIdsJson: JSON.stringify(handoff?.referenceIds ?? []),
	};
}
