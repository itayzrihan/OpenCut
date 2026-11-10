import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { registerAccount, sessionCookie } from "@/accounts/server";
import { GET, POST } from "@/app/api/generative/route";
import { importArchiveReference } from "./archive-reference";
import { probeReference } from "./probe";
import { artifact, archiveReferenceDirectory, fileBytes, sha } from "./store";

const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
	"base64",
);

test("probing an imported audio reference updates only its copied project metadata", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocut-portable-audio-"));
	try {
		const pcmBytes = 16000;
		const wav = Buffer.alloc(44 + pcmBytes);
		wav.write("RIFF");
		wav.writeUInt32LE(36 + pcmBytes, 4);
		wav.write("WAVEfmt ", 8);
		wav.writeUInt32LE(16, 16);
		wav.writeUInt16LE(1, 20);
		wav.writeUInt16LE(1, 22);
		wav.writeUInt32LE(16000, 24);
		wav.writeUInt32LE(32000, 28);
		wav.writeUInt16LE(2, 32);
		wav.writeUInt16LE(16, 34);
		wav.write("data", 36);
		wav.writeUInt32LE(pcmBytes, 40);
		const source = await artifact({
			root,
			projectId: "source",
			name: "voice.wav",
			mime: "audio/wav",
			bytes: wav,
		});
		const invalid = Buffer.alloc(12);
		invalid.write("RIFF");
		invalid.write("WAVE", 8);
		await expect(
			importArchiveReference({
				root,
				projectId: "copy",
				bytes: invalid,
				reference: {
					id: source.id,
					name: source.name,
					mime: source.mime,
					storyboard: false,
					sha256: sha(invalid),
				},
			}),
		).rejects.toThrow("Unable to verify");
		await expect(
			stat(
				archiveReferenceDirectory({
					root,
					projectId: "copy",
					fileId: source.id,
				}),
			),
		).rejects.toThrow();
		await importArchiveReference({
			root,
			projectId: "copy",
			bytes: wav,
			reference: {
				id: source.id,
				name: source.name,
				mime: source.mime,
				storyboard: false,
				sha256: sha(wav),
			},
		});
		expect(
			await probeReference({ root, projectId: "copy", id: source.id }),
		).toBe(0.5);
		expect(
			(await fileBytes({ root, projectId: "copy", fileId: source.id })).info
				.durationSeconds,
		).toBe(0.5);
		expect(
			(await fileBytes({ root, projectId: "source", fileId: source.id })).info
				.durationSeconds,
		).toBeUndefined();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("portable reference IDs retain independent project ownership and immutable concurrent retries", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocut-portable-ref-"));
	try {
		const source = await artifact({
			root,
			projectId: "original",
			name: "image.png",
			mime: "image/png",
			bytes: png,
			storyboard: true,
		});
		const reference = {
			id: source.id,
			name: source.name,
			mime: source.mime,
			storyboard: true,
			sha256: sha(png),
		};
		const input = { root, projectId: "copy", reference, bytes: png };
		const imports = await Promise.all(
			Array.from({ length: 8 }, () => importArchiveReference(input)),
		);
		expect(imports).toEqual(Array.from({ length: 8 }, () => source));
		for (const projectId of ["original", "copy"]) {
			const stored = await fileBytes({ root, projectId, fileId: source.id });
			expect(stored.info.projectId).toBe(projectId);
			expect(stored.bytes.equals(png)).toBe(true);
		}
		await expect(
			fileBytes({ root, projectId: "other", fileId: source.id }),
		).rejects.toThrow();
		await expect(
			importArchiveReference({
				...input,
				reference: { ...reference, name: "changed.png" },
			}),
		).rejects.toThrow("different data");
		const altered = Buffer.concat([png, Buffer.from([1])]);
		await expect(
			importArchiveReference({
				...input,
				bytes: altered,
				reference: { ...reference, sha256: sha(altered) },
			}),
		).rejects.toThrow("different data");
		await expect(
			importArchiveReference({ ...input, bytes: altered }),
		).rejects.toThrow("checksum");
		await expect(
			importArchiveReference({
				...input,
				reference: { ...reference, mime: "image/jpeg" },
			}),
		).rejects.toThrow("media type");
		const directory = archiveReferenceDirectory({
			root,
			projectId: "copy",
			fileId: source.id,
		});
		expect((await readFile(join(directory, "content"))).equals(png)).toBe(true);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("archive upload routes enforce login, account, origin and project boundaries without provider calls", async () => {
	const root = await mkdtemp(join(tmpdir(), "pocut-portable-routes-"));
	const prior = {
		root: process.env.OPENCUT_ACCOUNTS_DIR,
		origin: process.env.OPENCUT_PUBLIC_ORIGIN,
		only: process.env.OPENCUT_LEGITATE_ONLY,
	};
	process.env.OPENCUT_ACCOUNTS_DIR = root;
	delete process.env.OPENCUT_PUBLIC_ORIGIN;
	delete process.env.OPENCUT_LEGITATE_ONLY;
	const origin = "http://localhost:3100";
	try {
		const owner = await registerAccount({
			login: "portable-owner",
			displayName: "Owner",
			password: "disposable local test password",
		});
		const stranger = await registerAccount({
			login: "portable-other",
			displayName: "Other",
			password: "disposable local test password",
		});
		const referenceId = "a".repeat(32);
		const upload = ({
			cookie = sessionCookie(owner.token),
			account = owner.account.id,
			sourceOrigin = origin,
			digest = sha(png),
		}: {
			cookie?: string;
			account?: string;
			sourceOrigin?: string;
			digest?: string;
		} = {}) => {
			const form = new FormData();
			for (const [key, value] of Object.entries({
				archiveReference: "1",
				projectId: "imported-project",
				id: referenceId,
				sha256: digest,
				name: "image.png",
				storyboard: "true",
			}))
				form.append(key, value);
			form.append(
				"file",
				new Blob([new Uint8Array(png)], { type: "image/png" }),
				"image.png",
			);
			return POST(
				new NextRequest(origin + "/api/generative", {
					method: "POST",
					body: form,
					headers: {
						cookie,
						Origin: sourceOrigin,
						"X-OpenCut-Account": account,
					},
				}),
			);
		};
		expect((await upload({ cookie: "" })).status).toBe(401);
		expect((await upload({ account: stranger.account.id })).status).toBe(409);
		expect(
			(await upload({ sourceOrigin: "https://outside.example" })).status,
		).toBe(401);
		expect((await upload({ digest: "f".repeat(64) })).status).toBe(400);
		expect((await upload()).status).toBe(200);
		expect((await upload()).status).toBe(200);
		const read = ({
			cookie = sessionCookie(owner.token),
			project = "imported-project",
		}: { cookie?: string; project?: string } = {}) =>
			GET(
				new Request(
					origin +
						"/api/generative?" +
						new URLSearchParams({ projectId: project, file: referenceId }),
					{ headers: { cookie } },
				),
			);
		expect(Buffer.from(await (await read()).arrayBuffer()).equals(png)).toBe(
			true,
		);
		expect((await read({ project: "different-project" })).status).toBe(400);
		expect((await read({ cookie: sessionCookie(stranger.token) })).status).toBe(
			400,
		);
	} finally {
		for (const [key, value] of Object.entries({
			OPENCUT_ACCOUNTS_DIR: prior.root,
			OPENCUT_PUBLIC_ORIGIN: prior.origin,
			OPENCUT_LEGITATE_ONLY: prior.only,
		})) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});
