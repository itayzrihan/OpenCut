import type { TimelineElement } from "@/timeline/types";

export function mergeElementOverlay<TElement extends TimelineElement>({
	base,
	overlay,
}: {
	base: TElement;
	overlay: Partial<TimelineElement>;
}): TElement;
export function mergeElementOverlay({
	base,
	overlay,
}: {
	base: Partial<TimelineElement> | undefined;
	overlay: Partial<TimelineElement>;
}): Partial<TimelineElement>;
export function mergeElementOverlay({
	base,
	overlay,
}: {
	base: Partial<TimelineElement> | undefined;
	overlay: Partial<TimelineElement>;
}) {
	const merged = {
		...base,
		...overlay,
	} as Partial<TimelineElement>;

	if (overlay.params) {
		merged.params = {
			...(base?.params ?? {}),
			...overlay.params,
		};
	}

	return merged;
}
