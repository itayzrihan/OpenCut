import { getHyperframeRuntimeScript } from "@hyperframes/core/runtime-script";

/** Compatibility fix for the pinned 0.8.115 browser bundle. Its media sync
 * ignores differences below 20 ms, even during a forced paused render seek.
 * A stopped video can therefore retain the preceding frame at an output-frame
 * boundary. Keep the runtime's own trim/rate/loop calculation and tighten only
 * the paused video tolerance. Playing media and audio retain their tolerances.
 *
 * The published runtime has no hook for this threshold. Match the complete
 * pinned statement exactly once and fail closed on a dependency change; never
 * silently serve an uncorrected or partially rewritten runtime.
 */
export function getOpenCutHyperframesRuntimeScript(): string {
	const script = getHyperframeRuntimeScript();
	const statement = "let W=!X&&e.forceSync&&Y>.02;";
	const offset = script.indexOf(statement);
	if (offset < 0 || script.indexOf(statement, offset + statement.length) >= 0)
		throw new Error("HyperFrames 0.8.115 paused-video sync contract changed");
	return script.replace(
		statement,
		'let W=!X&&e.forceSync&&Y>(!e.playing&&r.tagName==="VIDEO"?1e-7:.02);',
	);
}
