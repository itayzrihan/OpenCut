import type {
	HyperframesLayerEdits,
	HyperframesLayerRenderEdit,
	HyperframesSource,
} from "./types";

const visualKeys = new WeakMap<HyperframesSource, Map<string, object>>();
/** Stable derived identity across canonical projections and unrelated edits. */
export function hyperframesVisualKey({
	source,
	layerEdits,
}: {
	source: HyperframesSource;
	layerEdits?: HyperframesLayerEdits;
}): object {
	if (!layerEdits) return source;
	let keys = visualKeys.get(source);
	if (!keys) visualKeys.set(source, (keys = new Map()));
	const serialized = JSON.stringify(layerEdits);
	const key = keys.get(serialized) ?? {};
	keys.delete(serialized);
	keys.set(serialized, key);
	while (keys.size > 64) keys.delete(keys.keys().next().value!);
	return key;
}

export interface HyperframesLayerEditBridge {
	beforeSeek: () => void;
	afterSeek: () => void;
}

/** Stringified into each isolated runtime. Both live and capture call this adapter.
 * Restore author styles before every seek; multiply the evaluated animation's
 * opacity afterwards. No timeline or source state is owned by this adapter.
 */
export function installHyperframesLayerEdits(
	plan: HyperframesLayerRenderEdit[],
): void {
	const page = window as typeof window & {
		__opencutLayerEdits?: HyperframesLayerEditBridge;
	};
	const previous = new Map<
		HTMLElement | SVGElement,
		{ value: string; priority: string }
	>();
	const beforeSeek = () => {
		for (const [node, style] of previous) {
			if (style.value)
				node.style.setProperty("opacity", style.value, style.priority);
			else node.style.removeProperty("opacity");
		}
		previous.clear();
	};
	page.__opencutLayerEdits?.beforeSeek();
	page.__opencutLayerEdits = {
		beforeSeek,
		afterSeek: () => {
			// Resolve everything before changing any styles, so an identity failure
			// cannot leave a partly edited frame in the preview.
			const targets = plan.map((edit) => {
				let node: Element | undefined = document.documentElement;
				for (const index of edit.key.slice(4).split("/"))
					node = node?.children[Number(index)];
				if (
					!(node instanceof HTMLElement || node instanceof SVGElement) ||
					![
						node.id,
						node.getAttribute("data-hf-authored-id"),
						node.getAttribute("data-hf-id"),
						node.getAttribute("data-composition-id"),
					].includes(edit.elementId)
				)
					throw new Error(`HyperFrames layer changed: ${edit.elementId}`);
				const opacity = Number(getComputedStyle(node).opacity);
				if (!Number.isFinite(opacity))
					throw new Error("HyperFrames layer opacity is unavailable");
				return { node, opacity: opacity * edit.opacity };
			});
			for (const { node, opacity } of targets) {
				previous.set(node, {
					value: node.style.getPropertyValue("opacity"),
					priority: node.style.getPropertyPriority("opacity"),
				});
				node.style.setProperty("opacity", String(opacity), "important");
			}
		},
	};
}

export function hyperframesLayerEditsScript(
	plan: HyperframesLayerRenderEdit[],
): string {
	// Layer IDs come from authored HTML; never let one close the injected script.
	return `(${installHyperframesLayerEdits.toString()})(${JSON.stringify(plan).replace(/</g, "\\u003c")});`;
}
