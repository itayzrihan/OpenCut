/** Isolated, read-only HTTP delivery for derived composition previews.
 * Each preview has its own unguessable localhost origin, so root-relative and
 * dynamically constructed package URLs work without rewriting author scripts.
 * This is a render cache; the canonical document remains the source of truth.
 */
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { pipeline } from "node:stream/promises";
import type { HyperframesSource } from "./types";

export interface HyperframesPreviewResource {
	path: string;
	mimeType: string;
	size: number;
}

interface Preview {
	html: Buffer;
	source: HyperframesSource;
	resources: ReadonlyMap<string, HyperframesPreviewResource>;
	lastUsed: number;
	bytes: number;
}

const IDLE_MS = 30 * 60 * 1000;
const MAX_PREVIEWS = 8;
const MAX_TEXT_BYTES = 64 * 1024 * 1024;

export class HyperframesPreviewHost {
	private readonly previews = new Map<string, Preview>();
	private readonly server = createServer((request, response) => {
		void this.serve({ request, response }).catch(() => {
			if (!response.headersSent) response.writeHead(500);
			response.end();
		});
	});
	private port = 0;
	private closed = false;
	private opening: Promise<void> | null = null;
	private readonly timer = setInterval(() => this.expire(), 60_000);

	constructor() {
		this.timer.unref();
	}

	async add({
		html,
		source,
		resources,
	}: {
		html: string;
		source: HyperframesSource;
		resources: ReadonlyMap<string, HyperframesPreviewResource>;
	}): Promise<{ id: string; url: string }> {
		if (this.closed) throw new Error("The HyperFrames preview host is closed");
		// Caller has prepared and validated the source through OpenCutRuntime.
		for (const path of Object.keys(source.resourceAssetIds)) {
			if (!resources.has(path))
				throw new Error(`Missing HyperFrames resource: ${path}`);
		}
		const body = Buffer.from(html);
		const bytes =
			body.byteLength +
			Object.values(source.files).reduce(
				(sum, text) => sum + Buffer.byteLength(text),
				0,
			);
		await this.listen();
		if (this.closed) throw new Error("The HyperFrames preview host is closed");
		this.expire();
		if (
			bytes > MAX_TEXT_BYTES ||
			this.previews.size >= MAX_PREVIEWS ||
			[...this.previews.values()].reduce(
				(sum, preview) => sum + preview.bytes,
				bytes,
			) > MAX_TEXT_BYTES
		)
			throw new Error(
				"Close an existing HyperFrames preview before opening another",
			);
		const id = randomBytes(24).toString("hex");
		this.previews.set(id, {
			html: body,
			source: structuredClone(source),
			resources: new Map(
				Object.keys(source.resourceAssetIds).map((path) => [
					path,
					{ ...resources.get(path)! },
				]),
			),
			lastUsed: Date.now(),
			bytes,
		});
		return {
			id,
			url: `http://${id}.localhost:${this.port}/${source.entryFile.split("/").map(encodeURIComponent).join("/")}`,
		};
	}

	remove({ id }: { id: string }): void {
		this.previews.delete(id);
	}

	keepAlive({ id }: { id: string }): boolean {
		const preview = this.previews.get(id);
		if (!preview || Date.now() - preview.lastUsed > IDLE_MS) {
			this.previews.delete(id);
			return false;
		}
		preview.lastUsed = Date.now();
		return true;
	}

	async close(): Promise<void> {
		this.closed = true;
		clearInterval(this.timer);
		this.previews.clear();
		if (this.opening) await this.opening;
		if (!this.server.listening) return;
		await new Promise<void>((resolveClose, reject) => {
			this.server.close((error) => (error ? reject(error) : resolveClose()));
			this.server.closeAllConnections();
		});
	}

	private expire(): void {
		for (const [id, preview] of this.previews) {
			if (Date.now() - preview.lastUsed > IDLE_MS) this.previews.delete(id);
		}
	}

	private async listen(): Promise<void> {
		this.opening ??= new Promise<void>((resolveOpen, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", () => {
				this.server.removeListener("error", reject);
				const address = this.server.address();
				if (!address || typeof address === "string")
					return reject(new Error("Preview host did not bind to loopback"));
				this.port = address.port;
				this.server.unref();
				resolveOpen();
			});
		});
		await this.opening;
	}

	private async serve({
		request,
		response,
	}: {
		request: IncomingMessage;
		response: ServerResponse;
	}): Promise<void> {
		const match = /^([a-f0-9]{48})\.localhost:(\d+)$/.exec(
			request.headers.host ?? "",
		);
		const preview =
			match && Number(match[2]) === this.port
				? this.previews.get(match[1])
				: undefined;
		if (!preview || Date.now() - preview.lastUsed > IDLE_MS) {
			response.writeHead(404).end();
			return;
		}
		if (!["GET", "HEAD", "OPTIONS"].includes(request.method ?? "")) {
			response.writeHead(405, { Allow: "GET, HEAD, OPTIONS" }).end();
			return;
		}
		response.setHeader("Access-Control-Allow-Origin", "*");
		response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
		response.setHeader("Access-Control-Allow-Headers", "Range");
		response.setHeader(
			"Access-Control-Expose-Headers",
			"Accept-Ranges, Content-Range, Content-Length",
		);
		response.setHeader("Referrer-Policy", "no-referrer");
		response.setHeader("X-Content-Type-Options", "nosniff");
		response.setHeader("Cache-Control", "private, max-age=3600");
		// No app cookies, filesystem routes, credentialed CORS, forms or popups.
		response.setHeader(
			"Content-Security-Policy",
			"sandbox allow-scripts; default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' https: 'unsafe-inline'; connect-src 'self' https:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'",
		);
		response.setHeader(
			"Permissions-Policy",
			"camera=(), microphone=(), geolocation=(), display-capture=()",
		);
		if (request.method === "OPTIONS") {
			response.writeHead(204).end();
			return;
		}
		let path: string;
		try {
			path = decodeURIComponent(
				new URL(
					request.url ?? "/",
					`http://${request.headers.host}`,
				).pathname.slice(1),
			);
		} catch {
			response.writeHead(400).end();
			return;
		}
		preview.lastUsed = Date.now();
		let bytes: Buffer | undefined;
		let mimeType: string;
		if (path === preview.source.entryFile) {
			bytes = preview.html;
			mimeType = "text/html; charset=utf-8";
		} else if (Object.hasOwn(preview.source.files, path)) {
			bytes = Buffer.from(preview.source.files[path]);
			mimeType = sourceMimeType({ path });
		} else {
			const resource = preview.resources.get(path);
			if (!resource) {
				response.writeHead(404).end();
				return;
			}
			mimeType = resource.mimeType;
			const range = parseRange({
				header: request.headers.range,
				size: resource.size,
			});
			if (range === false) {
				response
					.writeHead(416, { "Content-Range": `bytes */${resource.size}` })
					.end();
				return;
			}
			response.setHeader("Content-Type", mimeType);
			response.setHeader("Accept-Ranges", "bytes");
			response.setHeader(
				"Content-Length",
				range ? range.end - range.start + 1 : resource.size,
			);
			if (range)
				response.setHeader(
					"Content-Range",
					`bytes ${range.start}-${range.end}/${resource.size}`,
				);
			response.writeHead(range ? 206 : 200);
			if (request.method === "HEAD" || resource.size === 0) {
				response.end();
				return;
			}
			await pipeline(
				createReadStream(resource.path, range || undefined),
				response,
			);
			return;
		}
		response.writeHead(200, {
			"Content-Type": mimeType,
			"Content-Length": bytes.byteLength,
		});
		response.end(request.method === "HEAD" ? undefined : bytes);
	}
}

function sourceMimeType({ path }: { path: string }): string {
	const extension = path.split(".").pop()?.toLowerCase();
	return (
		(
			{
				html: "text/html",
				htm: "text/html",
				js: "text/javascript",
				mjs: "text/javascript",
				cjs: "text/javascript",
				css: "text/css",
				json: "application/json",
				svg: "image/svg+xml",
				vtt: "text/vtt",
				xml: "application/xml",
			} as Record<string, string>
		)[extension ?? ""] ?? "text/plain; charset=utf-8"
	);
}

function parseRange({
	header,
	size,
}: {
	header?: string;
	size: number;
}): { start: number; end: number } | false | null {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header);
	if (!match || (!match[1] && !match[2])) return false;
	const start = match[1]
		? Number(match[1])
		: Math.max(0, size - Number(match[2]));
	const end =
		match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		start > end ||
		start >= size
	)
		return false;
	return { start, end };
}
