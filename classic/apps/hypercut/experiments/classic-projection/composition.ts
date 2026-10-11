import { TICKS, tracksOf, type Snapshot } from "./model";
export function escapeHTML(value: unknown) {
	return String(value ?? "").replace(
		/[&<>"']/g,
		(c) =>
			({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
				c
			]!,
	);
}
function num(value: unknown, fallback: number) {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
// Pure presentation: all editing decisions and saved values come from Rust.
export function compositionHTML(
	snapshot: Snapshot,
	urls: ReadonlyMap<string, string>,
	origin: string,
): string {
	const settings = snapshot.project.classic.document.settings;
	const tracks = tracksOf(snapshot);
	const duration = Math.max(
		1,
		...tracks.flatMap((t) =>
			t.elements.map((e) => (e.startTime + e.duration) / TICKS),
		),
	);
	const clips = tracks
		.flatMap((t, i) =>
			t.elements.map((e) => {
				const p = e.params;
				const hidden = t.hidden || p.hidden === true;
				const attrs = `id="${escapeHTML(e.id)}" data-hf-id="${escapeHTML(e.id)}" class="clip" data-label="${escapeHTML(e.name)}" data-start="${e.startTime / TICKS}" data-duration="${e.duration / TICKS}" data-track-index="${i}" ${hidden ? 'data-hidden="true"' : ""}`;
				const transform = `translate(${num(p["transform.positionX"], 0)}px,${num(p["transform.positionY"], 0)}px) rotate(${num(p["transform.rotation"], 0)}deg) scale(${num(p["transform.scaleX"], 1)},${num(p["transform.scaleY"], 1)})`;
				const style = `position:absolute;inset:0;width:100%;height:100%;object-fit:contain;z-index:${tracks.length - i};opacity:${num(p.opacity, 1)};transform:${transform}`;
				const url = e.mediaId ? urls.get(e.mediaId) : undefined;
				if (e.type === "video" || e.type === "audio") {
					if (!url)
						return `<div ${attrs} style="${style};display:grid;place-items:center;color:#fff;background:#311">Missing media: ${escapeHTML(e.name)}</div>`;
					const muted = t.muted || p.muted === true;
					return `<${e.type} ${attrs} src="${escapeHTML(url)}" preload="metadata" ${e.type === "video" ? "playsinline" : ""} ${muted ? "muted" : ""} data-media-start="${e.trimStart / TICKS}" data-playback-rate="${e.retime?.rate ?? 1}" data-volume="${muted ? 0 : Math.pow(10, num(p.volume, 0) / 20)}" data-fade-in="${num(p.fadeInDuration, 0) / TICKS}" data-fade-out="${num(p.fadeOutDuration, 0) / TICKS}" style="${style}"></${e.type}>`;
				}
				if (e.type === "image")
					return `<img ${attrs} src="${escapeHTML(url)}" style="${style}"/>`;
				if (e.type === "text")
					return `<div ${attrs} style="${style};display:flex;align-items:center;justify-content:center"><div dir="auto" style="max-width:90%;white-space:pre-wrap;text-align:${escapeHTML(p.textAlign ?? "center")};font-family:system-ui,sans-serif;font-size:${num(p.fontSize, 80)}px;font-weight:${num(p.fontWeight, 700)};color:${escapeHTML(p.color ?? "#ffffff")}">${escapeHTML(p.content ?? e.name)}</div></div>`;
				throw Error(`Preview adapter is not implemented for ${e.type}.`);
			}),
		)
		.join("\n");
	return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#hypercut-root{position:relative;width:100%;height:100%;overflow:hidden;background:${escapeHTML(settings.background.color ?? "#000")}}</style><script src="${origin}/hyperframes-runtime.js"></script><script src="${origin}/gsap.min.js"></script></head><body><div id="hypercut-root" data-composition-id="hypercut" data-width="${settings.canvasSize.width}" data-height="${settings.canvasSize.height}" data-duration="${duration}">${clips}</div><script>window.__timelines=window.__timelines||{};window.__timelines.hypercut=gsap.timeline({paused:true}).to({}, {duration:${duration}});</script></body></html>`;
}
