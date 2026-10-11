import type { Plugin } from "vite";

/** Presentation-only customization of the pinned, complete upstream Studio.
 * Keep the native label column and its timeline geometry even without animation.
 * Do not patch node_modules: installs must reproduce this behavior.
 */
export function persistentTimelineLabels(): Plugin {
	const upstream = "() => timelineNeedsLabelColumn(animationsByElement, elements),";
	return {
		name: "hypercut-persistent-timeline-labels",
		enforce: "pre",
		transform(source, id) {
			if (!id.split("?")[0].endsWith("/@hyperframes/studio/dist/index.js"))
				return;
			if (source.split(upstream).length !== 2)
				throw new Error("HyperFrames timeline label hook changed; review the persistent-label customization before upgrading Studio.");
			return { code: source.replace(upstream, "() => true,"), map: null };
		},
	};
}
