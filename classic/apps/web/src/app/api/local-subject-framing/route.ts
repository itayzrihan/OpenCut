import { NextRequest, NextResponse } from "next/server";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { z } from "zod";
import { runProcess } from "../transcription/whisper-cpp/run-process";
export const runtime = "nodejs";
const schema = z
	.object({
		frames: z
			.array(
				z
					.string()
					.max(270000)
					.regex(/^[A-Za-z0-9+/]+={0,2}$/),
			)
			.min(3)
			.max(5),
	})
	.strict();
let running = 0;
export async function POST(request: NextRequest) {
	const host = request.nextUrl.hostname;
	if (
		!["localhost", "127.0.0.1", "[::1]"].includes(host) ||
		(request.headers.get("origin") &&
			request.headers.get("origin") !== request.nextUrl.origin)
	)
		return NextResponse.json(
			{ error: "Local same-origin detector only" },
			{ status: 403 },
		);
	if (running >= 2)
		return NextResponse.json(
			{ error: "Local detector is busy; try again" },
			{ status: 429 },
		);
	if (Number(request.headers.get("content-length")) > 1400000)
		return NextResponse.json({ error: "Frames too large" }, { status: 413 });
	const raw = await request.text();
	if (raw.length > 1400000)
		return NextResponse.json({ error: "Frames too large" }, { status: 413 });
	const parsed = schema.safeParse(
		await Promise.resolve()
			.then(() => JSON.parse(raw))
			.catch(() => null),
	);
	if (!parsed.success)
		return NextResponse.json(
			{ error: "Invalid source frames" },
			{ status: 400 },
		);
	const root = resolve(process.cwd(), "../..");
	const python = join(
		root,
		".local",
		"subject-framing",
		process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
	);
	if (!existsSync(python))
		return NextResponse.json(
			{
				error:
					"Local subject detector is not installed. Run python classic/scripts/local-subject-framing/setup.py once.",
			},
			{ status: 503 },
		);
	const work = await mkdtemp(join(tmpdir(), "opencut-local-framing-"));
	running++;
	try {
		const input = join(work, "input.json"),
			output = join(work, "output.json");
		await writeFile(input, JSON.stringify(parsed.data));
		await runProcess({
			command: python,
			args: [
				join(root, "scripts/local-subject-framing/detect.py"),
				input,
				output,
			],
			signal: request.signal,
			timeoutMs: 45000,
		});
		return NextResponse.json(JSON.parse(await readFile(output, "utf8")));
	} catch (error) {
		return NextResponse.json(
			{
				error: request.signal.aborted
					? "Local framing cancelled"
					: error instanceof Error
						? error.message
						: "Local face detector failed",
			},
			{ status: 500 },
		);
	} finally {
		running--;
		await rm(work, { recursive: true, force: true });
	}
}
