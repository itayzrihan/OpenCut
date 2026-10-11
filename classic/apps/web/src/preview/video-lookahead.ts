import { TICKS_PER_SECOND, mediaTimeToSeconds, roundMediaTime } from "@/wasm";
import { getSourceTimeAtClipTime } from "@/retime";
import type { AnyBaseNode } from "@/services/renderer/nodes/base-node";
import { VideoNode } from "@/services/renderer/nodes/video-node";
import { ParallaxSceneNode } from "@/services/renderer/nodes/parallax-scene-node";
import { PushBrollNode } from "@/services/renderer/nodes/push-broll-node";
import { videoCache } from "@/services/video-cache/service";
import { incrementCounter } from "@/diagnostics/render-perf";

const LOOKAHEAD = 3 * TICKS_PER_SECOND;
const MAX_PENDING = 2;

/** Disposable renderer IO, derived from the canonical scene. No document or
 * history mutations. Warm an idle camera before its cut, never seek a decoder
 * that is currently supplying pixels to the preview. */
export class VideoLookahead {
	private videos: VideoNode[] = [];
	private attempted = new WeakSet<VideoNode>();
	private pendingMedia = new Set<string>();
	private lastTime: number | undefined;
	private disposed = false;

	constructor({ node }: { node: AnyBaseNode | null }) {
		const visit = (candidate: AnyBaseNode) => {
			// These containers remap their children's clock. Leave them to their
			// own renderer instead of prefetching an incorrect source time.
			if (
				candidate instanceof ParallaxSceneNode ||
				candidate instanceof PushBrollNode
			)
				return;
			if (candidate instanceof VideoNode && candidate.params.isPreview)
				this.videos.push(candidate);
			for (const child of candidate.children) visit(child);
		};
		if (node) visit(node);
		this.videos.sort((a, b) => a.params.timeOffset - b.params.timeOffset);
		const previous = new Map<string, { node: VideoNode; lane: number }>();
		for (const video of this.videos) {
			const params = video.params;
			const prior = previous.get(params.mediaId);
			let lane = prior?.lane ?? 0;
			if (
				prior &&
				params.timeOffset <=
					prior.node.params.timeOffset + prior.node.params.duration
			) {
				const end =
					prior.node.params.trimStart +
					getSourceTimeAtClipTime({
						clipTime: prior.node.params.duration,
						retime: prior.node.params.retime,
					});
				const start =
					params.trimStart +
					getSourceTimeAtClipTime({ clipTime: 0, retime: params.retime });
				// A jump cut within one file needs a second decoder: seeking the
				// currently playing decoder ahead would stall the outgoing clip.
				if (Math.abs(end - start) > 1) lane = 1 - lane;
			}
			video.previewDecoderId = lane
				? `${params.mediaId}::preview-cut-lane:1`
				: params.mediaId;
			previous.set(params.mediaId, { node: video, lane });
		}
	}

	warm({ time }: { time: number }): void {
		if (this.disposed) return;
		if (
			this.lastTime !== undefined &&
			(time < this.lastTime || time > this.lastTime + LOOKAHEAD)
		)
			this.attempted = new WeakSet();
		this.lastTime = time;
		const active = new Set(
			this.videos
				.filter(
					({ params }) =>
						time >= params.timeOffset &&
						time < params.timeOffset + params.duration,
				)
				.map((node) => node.previewDecoderId ?? node.params.mediaId),
		);
		// At most one upcoming cut per source. Warming a later cut of the same
		// camera would move its decoder past the first cut we just prepared.
		const upcoming = new Set<string>();
		for (const node of this.videos) {
			const params = node.params;
			const decoderId = node.previewDecoderId ?? params.mediaId;
			if (params.timeOffset <= time || params.duration <= 0) continue;
			if (params.timeOffset > time + LOOKAHEAD) break;
			if (upcoming.has(params.mediaId)) continue;
			upcoming.add(params.mediaId);
			if (
				active.has(decoderId) ||
				this.attempted.has(node) ||
				this.pendingMedia.has(decoderId)
			)
				continue;
			if (this.pendingMedia.size >= MAX_PENDING) break;
			this.attempted.add(node);
			this.pendingMedia.add(decoderId);
			incrementCounter({ name: "preview.videoLookahead.started" });
			void videoCache
				.getFrameAt({
					mediaId: decoderId,
					file: params.file,
					url: params.url,
					maxSourceSize: params.maxSourceSize,
					time: mediaTimeToSeconds({
						time: roundMediaTime({
							time:
								params.trimStart +
								getSourceTimeAtClipTime({ clipTime: 0, retime: params.retime }),
						}),
					}),
				})
				.then((frame) => {
					if (frame) incrementCounter({ name: "preview.videoLookahead.ready" });
				})
				.catch(() => {
					// Speculation must never fail playback. Foreground decoding retains
					// the normal fallback/error handling and will retry when needed.
					incrementCounter({ name: "preview.videoLookahead.failed" });
				})
				.finally(() => this.pendingMedia.delete(decoderId));
		}
	}

	dispose(): void {
		this.disposed = true;
		this.videos = [];
	}
}
