import { BaseNode } from "./base-node";

export class PushBrollNode extends BaseNode<
	{
		timeOffset: number;
		duration: number;
		edge: "top" | "bottom";
		screenPercent: number;
		transitionSeconds: number;
	},
	{ progress: number }
> {}

/** One clock controls both edges, including short clips with overlapping ramps. */
export function pushBrollProgress({
	time,
	start,
	duration,
	transition,
}: {
	time: number;
	start: number;
	duration: number;
	transition: number;
}): number {
	const local = time - start;
	if (local < 0 || local >= duration) return 0;
	const ramp = Math.min(Math.max(0, transition), duration / 2);
	if (!ramp) return 1;
	const t = Math.min(1, local / ramp, (duration - local) / ramp);
	return t * t * (3 - 2 * t);
}

/** First child is the target text; remaining children use nested scene time. */
export class TextGraphicsNode extends PushBrollNode {}
