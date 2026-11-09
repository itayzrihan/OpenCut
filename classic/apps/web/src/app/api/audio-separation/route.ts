import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
	assertLocalOrigin,
	localRequestOrigin,
	withAccount,
} from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import { getMediaFile } from "@/services/local-drive/server";
import { mediaBinary } from "@/services/video-proxy/transcode";

export const runtime = "nodejs";
const sampleRate = 48_000;
const maximumFrames = sampleRate * 30;
const execute = promisify(execFile);
const modelRevision = "22da7d4cd3ea63f9365181008bff1c0d2ab6fb2b";
const stemNames = ["background", "dialogue", "music", "effects"] as const;
const inputSchema = z
	.object({
		projectId: z.string().min(1).max(256),
		mediaId: z.string().min(1).max(256),
		sourceStart: z.number().min(0).max(1_000_000_000),
		frames: z.number().int().min(1).max(maximumFrames),
		leadingFrames: z.number().int().min(0).max(maximumFrames),
	})
	.strict();
const host = globalThis as typeof globalThis & {
	__opencutAudioSeparationBusy?: boolean;
};

async function runDbsTiger({
	pcm,
	frames,
	leadingFrames,
	signal,
}: {
	pcm: Buffer;
	frames: number;
	leadingFrames: number;
	signal: AbortSignal;
}) {
	const home =
		process.env.OPENCUT_DBS_TIGER_HOME ||
		join(homedir(), ".opencut", "models", "dbs-tiger");
	const python =
		process.platform === "win32"
			? join(home, "venv", "Scripts", "python.exe")
			: join(home, "venv", "bin", "python");
	await access(join(home, modelRevision, "ready"));
	await access(python);
	signal.throwIfAborted();
	const directory = await mkdtemp(join(tmpdir(), "opencut-dbs-tiger-"));
	try {
		await writeFile(join(directory, "input.f32"), pcm, { signal });
		await execute(
			python,
			[
				join(process.cwd(), "scripts", "dbs-tiger.py"),
				"separate",
				directory,
				String(frames),
				String(leadingFrames),
			],
			{
				signal,
				windowsHide: true,
				env: {
					...process.env,
					OPENCUT_DBS_TIGER_HOME: home,
					HF_HUB_OFFLINE: "1",
					HF_HUB_DISABLE_TELEMETRY: "1",
				},
			},
		);
		return await Promise.all(
			stemNames.map(async (name) => {
				const bytes = await readFile(join(directory, `${name}.wav`), { signal });
				if (bytes.length !== 44 + frames * 8)
					throw new Error("DBS-TIGER returned an incomplete stem");
				return [name, bytes] as const;
			}),
		);
	} finally {
		await rm(directory, { recursive: true, force: true, maxRetries: 3 });
	}
}

export const POST = withAccount(
	async (request: Request) => {
		try {
			assertLocalOrigin(request);
			if (
				!["localhost", "127.0.0.1", "[::1]"].includes(
					new URL(localRequestOrigin(request)).hostname,
				)
			)
				return Response.json(
					{ error: "DBS-TIGER requires a local POCUT host" },
					{ status: 403 },
				);
			if (host.__opencutAudioSeparationBusy)
				return Response.json(
					{ error: "DBS-TIGER is already separating another clip" },
					{ status: 409 },
				);
			const input = inputSchema.parse(
				JSON.parse(
					new TextDecoder().decode(
						await readBoundedBody({ request, maximumBytes: 4096 }),
					),
				),
			);
			if (input.leadingFrames >= input.frames)
				return Response.json(
					{ error: "The selected range has no audible source samples" },
					{ status: 400 },
				);
			const source = await getMediaFile(input.projectId, input.mediaId);
			if (!source)
				return Response.json(
					{ error: "Relink the source media before separating speech" },
					{ status: 404 },
				);
			if (host.__opencutAudioSeparationBusy)
				return Response.json(
					{ error: "DBS-TIGER is already separating another clip" },
					{ status: 409 },
				);
			host.__opencutAudioSeparationBusy = true;
			try {
				const signal = AbortSignal.any([
					request.signal,
					AbortSignal.timeout(480_000),
				]);
				const { stdout } = await execute(
					mediaBinary("ffmpeg"),
					[
						"-nostdin",
						"-v",
						"error",
						"-ss",
						input.sourceStart.toFixed(7),
						"-i",
						source.path,
						"-map",
						"0:a:0",
						"-t",
						((input.frames - input.leadingFrames) / sampleRate).toFixed(7),
						"-ac",
						"2",
						"-ar",
						String(sampleRate),
						"-c:a",
						"pcm_f32le",
						"-f",
						"f32le",
						"pipe:1",
					],
					{
						signal,
						encoding: "buffer",
						maxBuffer: maximumFrames * 8 + 65_536,
						windowsHide: true,
					},
				);
				if (!stdout.length) throw new Error("Empty selected range");
			const stems = await runDbsTiger({
					pcm: stdout,
					frames: input.frames,
					leadingFrames: input.leadingFrames,
					signal,
				});
				signal.throwIfAborted();
				const result = new FormData();
				for (const [name, bytes] of stems) {
					result.append(
						name,
						new Blob([Uint8Array.from(bytes)], { type: "audio/wav" }),
						`${name}.wav`,
					);
				}
				return new Response(result, {
					headers: {
						"Cache-Control": "no-store",
						"X-OpenCut-Audio-Separation-Model": "DBS-TIGER",
						"X-OpenCut-Audio-Separation-Revision": modelRevision,
					},
				});
			} finally {
				host.__opencutAudioSeparationBusy = false;
			}
		} catch (error) {
			if (request.signal.aborted) return new Response(null, { status: 499 });
			if (error instanceof SyntaxError || error instanceof z.ZodError)
				return Response.json(
					{ error: "Select an audio range of up to 30 source seconds" },
					{ status: 400 },
				);
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				error.code === "ENOENT"
			)
				return Response.json(
					{
						error:
							"Speech separation requires DBS-TIGER and FFmpeg on this machine. Run bun run audio:setup from the Classic Web directory to install the model.",
					},
					{ status: 503 },
				);
			console.error("Local DBS-TIGER separation failed", error);
			return Response.json(
				{
					error:
						"DBS-TIGER could not separate the clip. Check the local server log.",
				},
				{ status: 500 },
			);
		}
	},
	{ concurrent: true },
);
