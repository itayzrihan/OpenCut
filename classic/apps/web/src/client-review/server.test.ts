import { expect, test } from "bun:test";
import {
	mkdtemp,
	rm,
	readFile,
	writeFile,
	stat,
	mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { registerAccount, sessionCookie } from "@/accounts/server";
import * as owner from "@/app/api/client-review/owner/route";
import * as item from "@/app/api/client-review/owner/[id]/route";
import * as publicApi from "@/app/api/client-review/[token]/route";
import * as media from "@/app/api/client-review/[token]/media/route";
test("real account routes isolate review ownership, password-gate metadata/media, support ranges and revoke access", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pocut-review-routes-"));
	const previousRoot = process.env.OPENCUT_ACCOUNTS_DIR;
	const previousOrigin = process.env.OPENCUT_PUBLIC_ORIGIN;
	const previousOnly = process.env.OPENCUT_LEGITATE_ONLY;
	process.env.OPENCUT_ACCOUNTS_DIR = directory;
	delete process.env.OPENCUT_PUBLIC_ORIGIN;
	delete process.env.OPENCUT_LEGITATE_ONLY;
	const origin = "http://localhost:3100";
	const req = ({
		path,
		options = {},
	}: {
		path: string;
		options?: {
			method?: string;
			cookie?: string;
			json?: unknown;
			body?: Uint8Array;
			headers?: Record<string, string>;
		};
	}) =>
		new Request(origin + path, {
			method: options.method ?? "GET",
			headers: {
				...(options.cookie ? { cookie: options.cookie } : {}),
				...(options.json !== undefined
					? { "Content-Type": "application/json", Origin: origin }
					: {}),
				...options.headers,
			},
			...(options.json !== undefined
				? { body: JSON.stringify(options.json) }
				: options.body
					? { body: new Uint8Array(options.body) }
					: {}),
		});
	try {
		const alice = await registerAccount({
			login: "review-alice",
			displayName: "Alice",
			password: "a long test password",
		});
		const bob = await registerAccount({
			login: "review-bob",
			displayName: "Bob",
			password: "a long test password",
		});
		const cookie = sessionCookie(alice.token).split(";")[0];
		const otherCookie = sessionCookie(bob.token).split(";")[0];
		const bytes = new Uint8Array(40);
		bytes.set([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
		const config = {
			projectId: "project-alice",
			sceneId: "scene-one",
			title: "Client review",
			durationTicks: 480000,
			mime: "video/mp4",
			size: bytes.length,
			password: "review-password",
		};
		for (const field of ["title", "projectId", "sceneId"]) {
			expect(
				(
					await owner.POST(
						req({
							path: "/api/client-review/owner",
							options: {
								method: "POST",
								cookie,
								json: { ...config, [field]: "bad\0value" },
							},
						}),
					)
				).status,
			).toBe(400);
		}
		for (const field of ["projectId", "sceneId"]) {
			for (const value of [
				"א".repeat(65),
				"x".repeat(129),
				"bad\nvalue",
				"bad\u0085value",
				" padded ",
			]) {
				expect(
					(
						await owner.POST(
							req({
								path: "/api/client-review/owner",
								options: {
									method: "POST",
									cookie,
									json: { ...config, [field]: value },
								},
							}),
						)
					).status,
				).toBe(400);
			}
		}
		const boundary = await owner.POST(
			req({
				path: "/api/client-review/owner",
				options: {
					method: "POST",
					cookie,
					json: {
						...config,
						projectId: "א".repeat(64),
						sceneId: "א".repeat(64),
						password: "",
					},
				},
			}),
		);
		expect(boundary.status).toBe(200);
		const boundaryReview = await boundary.json();
		const boundaryPath = `/api/client-review/owner/${boundaryReview.shareId}`;
		const boundaryContext = {
			params: Promise.resolve({ id: boundaryReview.shareId }),
		};
		expect(
			(
				await item.PUT(
					req({
						path: boundaryPath,
						options: {
							method: "PUT",
							cookie,
							body: bytes.subarray(0, 20),
							headers: { "Content-Type": "video/mp4", "Upload-Offset": "0" },
						},
					}),
					boundaryContext,
				)
			).status,
		).toBe(200);
		const boundaryPart = join(
			directory,
			"data",
			alice.account.id,
			"client-reviews",
			boundaryReview.shareId,
			"video.part",
		);
		expect((await stat(boundaryPart)).size).toBe(20);
		expect(
			(
				await item.DELETE(
					req({
						path: boundaryPath,
						options: { method: "DELETE", cookie },
					}),
					boundaryContext,
				)
			).status,
		).toBe(200);
		expect(
			await stat(boundaryPart).then(
				() => true,
				() => false,
			),
		).toBe(false);
		expect(
			(
				await owner.POST(
					req({
						path: "/api/client-review/owner",
						options: { method: "POST", json: config },
					}),
				)
			).status,
		).toBe(401);
		const created = await owner.POST(
			req({
				path: "/api/client-review/owner",
				options: { method: "POST", cookie, json: config },
			}),
		);
		expect(created.status).toBe(200);
		const review = await created.json();
		const context = { params: Promise.resolve({ id: review.shareId }) };
		const token = new URL(review.url).pathname.split("/").at(-1)!;
		const publicContext = { params: Promise.resolve({ token }) };
		const path = `/api/client-review/${token}`;
		const ownedPath = `/api/client-review/owner/${review.shareId}`;
		expect(
			(
				await publicApi.GET(
					req({
						path: path,
					}),
					publicContext,
				)
			).status,
		).toBe(404);
		expect(
			(
				await item.GET(
					req({
						path: ownedPath,
						options: { cookie: otherCookie },
					}),
					context,
				)
			).status,
		).toBe(404);
		expect(
			(
				await item.DELETE(
					req({
						path: ownedPath,
						options: { method: "DELETE", cookie: otherCookie },
					}),
					context,
				)
			).status,
		).toBe(404);
		expect(
			await (
				await owner.GET(
					req({
						path: "/api/client-review/owner?projectId=project-alice",
						options: {
							cookie: otherCookie,
						},
					}),
				)
			).json(),
		).toEqual([]);
		const uploaded = await item.PUT(
			req({
				path: ownedPath,
				options: {
					method: "PUT",
					cookie,
					body: bytes,
					headers: {
						"Content-Type": "video/mp4",
						"Content-Length": String(bytes.length),
					},
				},
			}),
			context,
		);
		expect(uploaded.status).toBe(200);
		expect((await uploaded.json()).ready).toBe(true);
		expect(
			(
				await item.PUT(
					req({
						path: ownedPath,
						options: {
							method: "PUT",
							cookie,
							body: bytes,
							headers: { "Content-Type": "video/mp4" },
						},
					}),
					context,
				)
			).status,
		).toBe(409);
		const locked = await publicApi.GET(
			req({
				path: path,
			}),
			publicContext,
		);
		expect(locked.status).toBe(401);
		expect(await locked.json()).toEqual({ locked: true });
		expect(
			(
				await media.GET(
					req({
						path: path + "/media",
					}),
					publicContext,
				)
			).status,
		).toBe(401);
		expect(
			(
				await media.HEAD(
					req({
						path: path + "/media",
						options: { method: "HEAD" },
					}),
					publicContext,
				)
			).status,
		).toBe(401);
		expect(
			(
				await publicApi.POST(
					req({
						path: path,
						options: {
							method: "POST",
							json: { action: "unlock", password: "wrong-password" },
						},
					}),
					publicContext,
				)
			).status,
		).toBe(403);
		const unlocked = await publicApi.POST(
			req({
				path: path,
				options: {
					method: "POST",
					json: { action: "unlock", password: config.password },
				},
			}),
			publicContext,
		);
		expect(unlocked.status).toBe(200);
		const accessCookie = unlocked.headers.get("Set-Cookie")!;
		expect(accessCookie).toContain("HttpOnly; SameSite=Strict");
		expect(accessCookie).toContain(`Path=${path}`);
		const publicCookie = accessCookie.split(";")[0];
		const unlockedView = await publicApi.GET(
			req({
				path: path,
				options: { cookie: publicCookie },
			}),
			publicContext,
		);
		expect(unlockedView.headers.get("Cache-Control")).toBe("private, no-store");
		expect(JSON.stringify(await unlockedView.json())).not.toContain(
			config.password,
		);
		const slice = await media.GET(
			req({
				path: path + "/media",
				options: {
					cookie: publicCookie,
					headers: { Range: "bytes=4-7" },
				},
			}),
			publicContext,
		);
		expect(slice.status).toBe(206);
		expect(slice.headers.get("Content-Range")).toBe("bytes 4-7/40");
		expect(await slice.text()).toBe("ftyp");
		const suffix = await media.GET(
			req({
				path: path + "/media",
				options: {
					cookie: publicCookie,
					headers: { Range: "bytes=-5" },
				},
			}),
			publicContext,
		);
		expect(suffix.status).toBe(206);
		expect((await suffix.arrayBuffer()).byteLength).toBe(5);
		const head = await media.HEAD(
			req({
				path: path + "/media",
				options: { method: "HEAD", cookie: publicCookie },
			}),
			publicContext,
		);
		expect(head.status).toBe(200);
		expect(head.headers.get("Content-Length")).toBe("40");
		expect(await head.text()).toBe("");
		expect(
			(
				await media.GET(
					req({
						path: path + "/media",
						options: {
							cookie: publicCookie,
							headers: { Range: "bytes=500-600" },
						},
					}),
					publicContext,
				)
			).status,
		).toBe(416);
		const comment = {
			action: "comment",
			nonce: randomUUID(),
			timeTicks: 120000,
			authorName: "Client",
			body: "Make this cut shorter.",
		};
		expect(
			(
				await publicApi.POST(
					req({
						path: path,
						options: { method: "POST", json: comment },
					}),
					publicContext,
				)
			).status,
		).toBe(401);
		const first = await publicApi.POST(
			req({
				path: path,
				options: { method: "POST", cookie: publicCookie, json: comment },
			}),
			publicContext,
		);
		expect(first.status).toBe(200);
		const initial = await first.json();
		expect(initial.comments).toHaveLength(1);
		const retry = await publicApi.POST(
			req({
				path: path,
				options: { method: "POST", cookie: publicCookie, json: comment },
			}),
			publicContext,
		);
		expect((await retry.json()).comments).toEqual(initial.comments);
		const changed = await publicApi.POST(
			req({
				path: path,
				options: {
					method: "POST",
					cookie: publicCookie,
					json: { ...comment, body: "Different intent" },
				},
			}),
			publicContext,
		);
		expect(changed.status).toBe(409);
		const resolved = await item.PATCH(
			req({
				path: ownedPath,
				options: {
					method: "PATCH",
					cookie,
					json: { commentId: initial.comments[0].id, resolved: true },
				},
			}),
			context,
		);
		expect((await resolved.json()).comments[0]).toMatchObject({
			resolved: true,
			serverRevision: 2,
		});
		const again = await item.PATCH(
			req({
				path: ownedPath,
				options: {
					method: "PATCH",
					cookie,
					json: { commentId: initial.comments[0].id, resolved: true },
				},
			}),
			context,
		);
		expect((await again.json()).comments[0].serverRevision).toBe(2);
		const concurrent = {
			...comment,
			nonce: randomUUID(),
			body: "Concurrent duplicate",
		};
		const replies = await Promise.all(
			[
				concurrent,
				concurrent,
				{ ...comment, nonce: randomUUID(), body: "Separate process one" },
				{ ...comment, nonce: randomUUID(), body: "Separate process two" },
			].map(async (next) => {
				const child = Bun.spawn(
					[
						process.execPath,
						"run",
						"src/client-review/public-mutation.fixture.ts",
					],
					{
						cwd: process.cwd(),
						env: process.env,
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				child.stdin.write(
					JSON.stringify({ token, cookie: publicCookie, comment: next }),
				);
				child.stdin.end();
				const [stdout, stderr, status] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(status).toBe(0);
				expect(stderr).toBe("");
				return JSON.parse(stdout);
			}),
		);
		for (const reply of replies) expect(reply.status).toBe(200);
		const afterConcurrent = await (
			await publicApi.GET(
				req({
					path: path,
					options: { cookie: publicCookie },
				}),
				publicContext,
			)
		).json();
		expect(afterConcurrent.comments).toHaveLength(4);
		expect(
			afterConcurrent.comments.filter(
				(value: { body: string }) => value.body === concurrent.body,
			),
		).toHaveLength(1);
		const fresh = async (size = bytes.length) => {
			const response = await owner.POST(
				req({
					path: "/api/client-review/owner",
					options: {
						method: "POST",
						cookie,
						json: { ...config, size, password: "" },
					},
				}),
			);
			expect(response.status).toBe(200);
			return response.json();
		};
		const incomplete = await fresh();
		const incompletePath = `/api/client-review/owner/${incomplete.shareId}`;
		const incompleteContext = {
			params: Promise.resolve({ id: incomplete.shareId }),
		};
		const partialPath = join(
			directory,
			"data",
			alice.account.id,
			"client-reviews",
			incomplete.shareId,
			"video.part",
		);
		expect(
			(
				await item.PUT(
					req({
						path: incompletePath,
						options: {
							method: "PUT",
							cookie,
							body: new Uint8Array(40),
							headers: { "Content-Type": "video/mp4" },
						},
					}),
					incompleteContext,
				)
			).status,
		).toBe(400);
		expect((await stat(partialPath)).size).toBe(0);
		expect(
			(
				await item.PUT(
					req({
						path: incompletePath,
						options: {
							method: "PUT",
							cookie,
							body: bytes.subarray(0, 20),
							headers: { "Content-Type": "video/mp4", "Content-Length": "40" },
						},
					}),
					incompleteContext,
				)
			).status,
		).toBe(400);
		expect((await stat(partialPath)).size).toBe(0);
		const failedStream = new ReadableStream<Uint8Array>({
			start(output) {
				output.enqueue(bytes.subarray(0, 20));
			},
			pull(output) {
				output.error(new Error("Synthetic upload interruption"));
			},
		});
		const interrupted = new Request(origin + incompletePath, {
			method: "PUT",
			headers: { cookie, "Content-Type": "video/mp4", "Upload-Offset": "0" },
			body: failedStream,
		});
		expect(
			(await item.PUT(interrupted, incompleteContext)).status,
		).toBeGreaterThanOrEqual(400);
		expect((await stat(partialPath)).size).toBe(0);
		expect(
			(
				await item.PUT(
					req({
						path: incompletePath,
						options: {
							method: "PUT",
							cookie,
							body: bytes,
							headers: { "Content-Type": "video/mp4" },
						},
					}),
					incompleteContext,
				)
			).status,
		).toBe(200);
		const chunkSize = 8 * 1024 * 1024;
		const chunked = await fresh(chunkSize + 32);
		const chunkPath = `/api/client-review/owner/${chunked.shareId}`;
		const chunkContext = { params: Promise.resolve({ id: chunked.shareId }) };
		const firstChunk = new Uint8Array(chunkSize);
		firstChunk.set(bytes);
		const chunkResponse = await item.PUT(
			req({
				path: chunkPath,
				options: {
					method: "PUT",
					cookie,
					body: firstChunk,
					headers: { "Content-Type": "video/mp4", "Upload-Offset": "0" },
				},
			}),
			chunkContext,
		);
		expect(chunkResponse.status).toBe(200);
		expect(await chunkResponse.json()).toMatchObject({
			ready: false,
			uploadedBytes: chunkSize,
		});
		expect(
			(
				await item.PUT(
					req({
						path: chunkPath,
						options: {
							method: "PUT",
							cookie,
							body: firstChunk,
							headers: { "Content-Type": "video/mp4", "Upload-Offset": "0" },
						},
					}),
					chunkContext,
				)
			).status,
		).toBe(409);
		expect(
			(
				await item.PUT(
					req({
						path: chunkPath,
						options: {
							method: "PUT",
							cookie,
							body: new Uint8Array(33),
							headers: {
								"Content-Type": "video/mp4",
								"Upload-Offset": String(chunkSize),
							},
						},
					}),
					chunkContext,
				)
			).status,
		).toBe(413);
		expect(
			(
				await stat(
					join(
						directory,
						"data",
						alice.account.id,
						"client-reviews",
						chunked.shareId,
						"video.part",
					),
				)
			).size,
		).toBe(chunkSize);
		const finalChunk = await item.PUT(
			req({
				path: chunkPath,
				options: {
					method: "PUT",
					cookie,
					body: new Uint8Array(32),
					headers: {
						"Content-Type": "video/mp4",
						"Upload-Offset": String(chunkSize),
					},
				},
			}),
			chunkContext,
		);
		expect(finalChunk.status).toBe(200);
		expect(await finalChunk.json()).toMatchObject({
			ready: true,
			uploadedBytes: chunkSize + 32,
		});
		// Seed bounded metadata to reach canonical limits without 1000 HTTP calls.
		const metadataPath = join(
			directory,
			"data",
			alice.account.id,
			"client-reviews",
			review.shareId,
			"review.json",
		);
		const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
		const originalComments = metadata.comments;
		metadata.comments = Array.from({ length: 1000 }, (_, i) => ({
			...initial.comments[0],
			id: randomUUID(),
			body: `Comment ${i}`,
		}));
		await writeFile(metadataPath, JSON.stringify(metadata));
		const secondToken = new URL(incomplete.url).pathname.split("/").at(-1)!;
		const secondContext = { params: Promise.resolve({ token: secondToken }) };
		expect(
			(
				await publicApi.POST(
					req({
						path: `/api/client-review/${secondToken}`,
						options: {
							method: "POST",
							json: { ...comment, nonce: randomUUID() },
						},
					}),
					secondContext,
				)
			).status,
		).toBe(409);
		metadata.comments = Array.from({ length: 400 }, () => ({
			...initial.comments[0],
			id: randomUUID(),
			body: "א".repeat(2000),
		}));
		await writeFile(metadataPath, JSON.stringify(metadata));
		expect(
			(
				await publicApi.POST(
					req({
						path: `/api/client-review/${secondToken}`,
						options: {
							method: "POST",
							json: { ...comment, nonce: randomUUID() },
						},
					}),
					secondContext,
				)
			).status,
		).toBe(409);
		metadata.comments = originalComments;
		await writeFile(metadataPath, JSON.stringify(metadata));
		for (const field of ["body", "authorName"]) {
			expect(
				(
					await publicApi.POST(
						req({
							path: path,
							options: {
								method: "POST",
								cookie: publicCookie,
								json: {
									...comment,
									nonce: randomUUID(),
									[field]: "bad\0value",
								},
							},
						}),
						publicContext,
					)
				).status,
			).toBe(400);
		}
		await Promise.all(
			Array.from({ length: 100 }, async () => {
				const shareId = randomUUID();
				const target = join(
					directory,
					"data",
					alice.account.id,
					"client-reviews",
					shareId,
				);
				await mkdir(target);
				await writeFile(
					join(target, "review.json"),
					JSON.stringify({
						...metadata,
						projectId: "lifetime-cap-project",
						revoked: true,
						ready: true,
						comments: [],
						requests: {},
						share: { ...metadata.share, shareId },
					}),
				);
			}),
		);
		expect(
			(
				await owner.POST(
					req({
						path: "/api/client-review/owner",
						options: {
							method: "POST",
							cookie,
							json: { ...config, projectId: "lifetime-cap-project" },
						},
					}),
				)
			).status,
		).toBe(409);
		expect(
			(
				await owner.POST(
					req({
						path: "/api/client-review/owner",
						options: {
							method: "POST",
							cookie,
							json: null,
						},
					}),
				)
			).status,
		).toBe(400);
		expect(
			(
				await owner.POST(
					req({
						path: "/api/client-review/owner",
						options: {
							method: "POST",
							cookie,
							json: { ...config, title: "x".repeat(33000) },
						},
					}),
				)
			).status,
		).toBe(400);
		expect(
			(
				await owner.POST(
					req({
						path: "/api/client-review/owner",
						options: {
							method: "POST",
							cookie,
							json: { ...config, size: 512 * 1024 * 1024 + 1 },
						},
					}),
				)
			).status,
		).toBe(413);
		expect(
			(
				await publicApi.POST(
					req({
						path: path,
						options: {
							method: "POST",
							cookie: publicCookie,
							json: {
								...comment,
								nonce: randomUUID(),
								timeTicks: config.durationTicks + 1,
							},
						},
					}),
					publicContext,
				)
			).status,
		).toBe(400);
		// Reservations exercise the actual account quota without allocating gigabytes.
		const reserved: string[] = [];
		for (let i = 0; i < 9; i++) {
			const response = await owner.POST(
				req({
					path: "/api/client-review/owner",
					options: {
						method: "POST",
						cookie,
						json: { ...config, password: "", size: 512 * 1024 * 1024 },
					},
				}),
			);
			expect(response.status).toBe(200);
			reserved.push((await response.json()).shareId);
		}
		expect(
			(
				await owner.POST(
					req({
						path: "/api/client-review/owner",
						options: {
							method: "POST",
							cookie,
							json: { ...config, password: "", size: 512 * 1024 * 1024 },
						},
					}),
				)
			).status,
		).toBe(409);
		expect(
			(
				await item.DELETE(
					req({
						path: `/api/client-review/owner/${reserved[0]}`,
						options: {
							method: "DELETE",
							cookie,
						},
					}),
					{ params: Promise.resolve({ id: reserved[0] }) },
				)
			).status,
		).toBe(200);
		expect(
			(
				await owner.POST(
					req({
						path: "/api/client-review/owner",
						options: {
							method: "POST",
							cookie,
							json: { ...config, password: "", size: 512 * 1024 * 1024 },
						},
					}),
				)
			).status,
		).toBe(200);
		expect(
			(
				await publicApi.POST(
					req({
						path: path,
						options: {
							method: "POST",
							cookie: publicCookie,
							json: comment,
							headers: { Origin: "https://evil.test" },
						},
					}),
					publicContext,
				)
			).status,
		).toBeGreaterThanOrEqual(400);
		expect(
			(
				await item.DELETE(
					req({
						path: ownedPath,
						options: { method: "DELETE", cookie },
					}),
					context,
				)
			).status,
		).toBe(200);
		expect(
			(
				await publicApi.GET(
					req({
						path: path,
						options: { cookie: publicCookie },
					}),
					publicContext,
				)
			).status,
		).toBe(404);
		expect(
			(
				await media.GET(
					req({
						path: path + "/media",
						options: { cookie: publicCookie },
					}),
					publicContext,
				)
			).status,
		).toBe(404);
		expect(
			(
				await publicApi.POST(
					req({
						path: path,
						options: {
							method: "POST",
							cookie: publicCookie,
							json: { ...comment, nonce: randomUUID() },
						},
					}),
					publicContext,
				)
			).status,
		).toBe(404);
	} finally {
		for (const [key, value] of [
			["OPENCUT_ACCOUNTS_DIR", previousRoot],
			["OPENCUT_PUBLIC_ORIGIN", previousOrigin],
			["OPENCUT_LEGITATE_ONLY", previousOnly],
		]) {
			if (value === undefined) delete process.env[key!];
			else process.env[key!] = value;
		}
		await rm(directory, { recursive: true, force: true });
	}
}, 20000);
