import type {
	ClipboardEntry,
	ClipboardEntryByType,
	ClipboardEntryType,
	ClipboardHandler,
	ClipboardHandlerMap,
	CopyContext,
	PasteContext,
} from "../types";
import { ElementsClipboardHandler } from "./elements";
import { KeyframesClipboardHandler } from "./keyframes";

export const clipboardHandlers: ClipboardHandlerMap = {
	elements: ElementsClipboardHandler,
	keyframes: KeyframesClipboardHandler,
};

export const clipboardCopyHandlers = [
	KeyframesClipboardHandler,
	ElementsClipboardHandler,
] as const satisfies readonly ClipboardHandler<ClipboardEntryType>[];

export function copyClipboardEntry({
	context,
}: {
	context: CopyContext;
}): ClipboardEntry | null {
	for (const handler of clipboardCopyHandlers) {
		if (!handler.canCopy(context)) {
			continue;
		}

		return handler.copy(context);
	}

	return null;
}

export function buildPasteClipboardAction<TType extends ClipboardEntryType>({
	entry,
	context,
}: {
	entry: ClipboardEntryByType[TType] & { type: TType };
	context: PasteContext;
}) {
	const handler: ClipboardHandler<TType> = clipboardHandlers[entry.type];
	return handler.paste({ entry, context });
}
