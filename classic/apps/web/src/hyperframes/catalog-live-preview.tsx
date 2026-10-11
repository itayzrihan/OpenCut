"use client";
import { useEffect, useRef, useState } from "react";
const endpoint = "/api/editor-agent/hyperframes-catalog-preview";
type Lease = {
	id: string;
	url: string;
	width: number;
	height: number;
	missingFiles?: string[];
};
function parseLease(value: unknown): Lease {
	if (
		!value ||
		typeof value !== "object" ||
		!("id" in value) ||
		typeof value.id !== "string" ||
		!/^[a-f0-9]{48}$/.test(value.id) ||
		!("url" in value) ||
		typeof value.url !== "string" ||
		!/^http:\/\/[a-f0-9]{48}\.localhost:\d+\//.test(value.url) ||
		!("width" in value) ||
		typeof value.width !== "number" ||
		!(value.width > 0 && value.width <= 8192) ||
		!("height" in value) ||
		typeof value.height !== "number" ||
		!(value.height > 0 && value.height <= 8192)
	)
		throw new Error("Invalid catalog preview response");
	return {
		id: value.id,
		url: value.url,
		width: value.width,
		height: value.height,
		missingFiles:
			"missingFiles" in value && Array.isArray(value.missingFiles)
				? value.missingFiles.filter(
						(file): file is string => typeof file === "string",
					)
				: [],
	};
}
const release = (id: string) =>
	void fetch(`${endpoint}?id=${encodeURIComponent(id)}`, {
		method: "DELETE",
		keepalive: true,
	}).catch(() => {});

/** Only the active card owns a disposable source preview, never a project edit. */
export function CatalogLivePreview({
	id,
	upstreamCommit,
	title,
}: {
	id: string;
	upstreamCommit: string;
	title: string;
}) {
	const [lease, setLease] = useState<Lease | null>(null);
	const [status, setStatus] = useState("Loading live source…");
	const [failed, setFailed] = useState(false);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const container = useRef<HTMLDivElement>(null),
		frame = useRef<HTMLIFrameElement>(null);
	useEffect(() => {
		const node = container.current;
		if (!node) return;
		const observer = new ResizeObserver(([entry]) =>
			setSize({
				width: entry.contentRect.width,
				height: entry.contentRect.height,
			}),
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);
	useEffect(() => {
		let current = true,
			owned: Lease | null = null;
		// Do not abort after dispatch: collect and release the returned lease even
		// when the pointer left while its server-side package was being prepared.
		const timer = setTimeout(() => {
			void fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id, upstreamCommit }),
			})
				.then(async (response) => {
					const data = await response.json();
					if (!response.ok)
						throw new Error(data.error ?? "Preview unavailable");
					return parseLease(data);
				})
				.then((result) => {
					if (!current) {
						release(result.id);
						return;
					}
					owned = result;
					setLease(result);
				})
				.catch((error) => {
					if (current) {
						setFailed(true);
						setStatus(String(error.message));
					}
				});
		}, 300);
		return () => {
			current = false;
			clearTimeout(timer);
			if (owned) release(owned.id);
		};
	}, [id, upstreamCommit]);
	useEffect(() => {
		if (!lease) return;
		const timeout = setTimeout(() => {
			setFailed(true);
			setStatus(
				"Live preview timed out. Some source dependencies may be unavailable.",
			);
		}, 25000);
		const onMessage = (event: MessageEvent) => {
			if (
				event.source !== frame.current?.contentWindow ||
				event.data?.source !== "opencut-catalog"
			)
				return;
			if (event.data.type === "ready") {
				clearTimeout(timeout);
				setStatus("");
				setFailed(false);
			}
			if (event.data.type === "error") {
				clearTimeout(timeout);
				setFailed(true);
				setStatus(String(event.data.message).slice(0, 200));
			}
		};
		window.addEventListener("message", onMessage);
		return () => {
			clearTimeout(timeout);
			window.removeEventListener("message", onMessage);
		};
	}, [lease]);
	const scale = lease
		? Math.min(size.width / lease.width, size.height / lease.height)
		: 1;
	return (
		<div
			ref={container}
			className="relative aspect-video w-full overflow-hidden rounded-lg bg-black"
			aria-label={`${title} live source preview`}
		>
			{lease && (
				<iframe
					ref={frame}
					title={`${title} live preview`}
					src={lease.url}
					sandbox="allow-scripts"
					allow="autoplay 'none'; camera 'none'; microphone 'none'"
					tabIndex={-1}
					className="absolute border-0 pointer-events-none"
					style={{
						width: lease.width,
						height: lease.height,
						left: (size.width - lease.width * scale) / 2,
						top: (size.height - lease.height * scale) / 2,
						transform: `scale(${scale})`,
						transformOrigin: "top left",
					}}
				/>
			)}
			{lease?.missingFiles?.length ? (
				<div className="absolute inset-x-0 top-0 bg-black/85 p-2 text-xs text-amber-200">
					Partial preview: the upstream source is missing{" "}
					{lease.missingFiles.length} media files.
				</div>
			) : null}
			{status && (
				<div
					role={failed ? "alert" : "status"}
					className="absolute inset-x-0 bottom-0 bg-black/85 p-3 text-xs text-white"
				>
					{status}
				</div>
			)}
		</div>
	);
}
