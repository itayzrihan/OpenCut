const sourceVersions = new WeakMap<object, string>();

export function markCanvasSourceVersion({
	source,
	version,
}: {
	source: CanvasImageSource;
	version: string;
}): void {
	if ((typeof source === "object" && source !== null) || typeof source === "function") {
		sourceVersions.set(source as object, version);
	}
}

export function getCanvasSourceVersion({
	source,
}: {
	source: CanvasImageSource;
}): string | undefined {
	if ((typeof source !== "object" || source === null) && typeof source !== "function") {
		return undefined;
	}
	return sourceVersions.get(source as object);
}
