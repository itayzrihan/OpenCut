import type { VisualElement } from "@/timeline";

export const LOOP_TARGET_ELEMENT_TYPES = [
	"video",
	"image",
	"text",
] as const satisfies readonly VisualElement["type"][];

export function isLoopTargetElementType({
	elementType,
}: {
	elementType: string;
}): elementType is (typeof LOOP_TARGET_ELEMENT_TYPES)[number] {
	return LOOP_TARGET_ELEMENT_TYPES.some((targetType) => targetType === elementType);
}
