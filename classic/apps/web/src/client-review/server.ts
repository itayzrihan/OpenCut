import {
	createHash,
	createHmac,
	randomBytes,
	randomUUID,
	scrypt as scryptCallback,
	timingSafeEqual,
} from "node:crypto";
import {
	mkdir,
	readFile,
	writeFile,
	rename,
	readdir,
	rm,
	open,
	stat,
	truncate,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import {
	accountsRoot,
	accountDataRoot,
	requireAccount,
	assertLocalOrigin,
	localRequestOrigin,
} from "@/accounts/server";
import { readBoundedBody } from "@/accounts/request-body";
import type { ClientReviewShare, ClientReviewComment } from "./canonical";
function derive({
	password,
	salt,
}: {
	password: string;
	salt: string;
}): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		scryptCallback(password, salt, 32, (error, key) => {
			if (error) reject(error);
			else resolve(key);
		}),
	);
}
export const MAX_REVIEW_BYTES = 512 * 1024 * 1024;
export const MAX_REVIEW_CHUNK_BYTES = 8 * 1024 * 1024;
const MAX_PROJECT_COMMENTS = 1000;
const MAX_PROJECT_COMMENT_BYTES = 1536 * 1024;
const MAX_ACCOUNT_BYTES = 5 * 1024 * 1024 * 1024;
const UUID = /^[a-f0-9-]{36}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TTL = 90 * 24 * 3600000;
type Review = {
	share: ClientReviewShare;
	accountId: string;
	projectId: string;
	token: string;
	secret: string;
	password?: {
		salt: string;
		hash: string;
	};
	ready: boolean;
	revoked: boolean;
	expiresAt: number;
	size: number;
	uploadedBytes?: number;
	mime: string;
	comments: ClientReviewComment[];
	requests: Record<string, string>;
};
export class ReviewError extends Error {
	readonly status: number;
	constructor({ message, status = 400 }: { message: string; status?: number }) {
		super(message);
		this.status = status;
	}
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const checkedId = (id: string) => {
	if (!UUID.test(id))
		throw new ReviewError({
			message: "Review not found",
			status: 404,
		});
	return id;
};
const root = () => join(accountsRoot(), "client-review-index");
const dir = ({ accountId, id }: { accountId: string; id: string }) =>
	join(
		accountsRoot(),
		"data",
		checkedId(accountId),
		"client-reviews",
		checkedId(id),
	);
const metadata = (review: Review) =>
	join(
		dir({
			accountId: review.accountId,
			id: review.share.shareId,
		}),
		"review.json",
	);
async function atomic({ path, data }: { path: string; data: unknown }) {
	const tmp = `${path}.${randomUUID()}.tmp`;
	await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
	await rename(tmp, path);
}
async function locked<T>({
	path,
	action,
}: {
	path: string;
	action: () => Promise<T>;
}) {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(path, {
		realpath: false,
		retries: { retries: 30, minTimeout: 30, maxTimeout: 200 },
		stale: 600000,
	});
	try {
		return await action();
	} finally {
		await release();
	}
}
async function load({
	accountId,
	id,
}: {
	accountId: string;
	id: string;
}): Promise<Review> {
	try {
		return JSON.parse(
			await readFile(
				join(
					dir({
						accountId: accountId,
						id: id,
					}),
					"review.json",
				),
				"utf8",
			),
		);
	} catch {
		throw new ReviewError({
			message: "Review not found",
			status: 404,
		});
	}
}
function active(review: Review) {
	if (review.revoked || review.expiresAt < Date.now())
		throw new ReviewError({
			message: "This review link has expired or was revoked",
			status: 410,
		});
}
function ownerView({ review, origin }: { review: Review; origin: string }) {
	return {
		...review.share,
		projectId: review.projectId,
		url: `${origin}/review/${review.token}`,
		passwordProtected: !!review.password,
		ready: review.ready,
		revoked: review.revoked,
		expiresAt: review.expiresAt,
		comments: review.comments,
		size: review.size,
		uploadedBytes: review.ready ? review.size : (review.uploadedBytes ?? 0),
	};
}
export async function reviewJson(
	request: Request,
): Promise<Record<string, unknown>> {
	try {
		const value = JSON.parse(
			new TextDecoder().decode(
				await readBoundedBody({ request, maximumBytes: 32 * 1024 }),
			),
		);
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Object required");
		return value;
	} catch {
		throw new ReviewError({
			message: "Invalid or oversized request",
		});
	}
}
function text({
	value,
	max,
	label,
}: {
	value: unknown;
	max: number;
	label: string;
}): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.includes("\0") ||
		value.trim().length > max
	)
		throw new ReviewError({
			message: `Invalid ${label}`,
		});
	return value.trim();
}
function identifier({
	value,
	label,
}: {
	value: unknown;
	label: string;
}): string {
	if (
		typeof value !== "string" ||
		!value ||
		value.trim() !== value ||
		Buffer.byteLength(value, "utf8") > 128 ||
		/\p{Cc}/u.test(value)
	)
		throw new ReviewError({
			message: `Invalid ${label}`,
		});
	return value;
}
export async function listReviews(request: Request) {
	const projectId = new URL(request.url).searchParams.get("projectId");
	const path = join(accountDataRoot(), "client-reviews");
	const names = await readdir(path).catch(() => []);
	const reviews = await Promise.all(
		names
			.filter((x) => UUID.test(x))
			.map((x) =>
				load({
					accountId: requireAccount().id,
					id: x,
				}).catch(() => null),
			),
	);
	return reviews
		.filter((x): x is Review => !!x && x.projectId === projectId)
		.map((x) =>
			ownerView({
				review: x,
				origin: localRequestOrigin(request),
			}),
		);
}
export async function createReview(request: Request) {
	assertLocalOrigin(request);
	const input = await reviewJson(request);
	const projectId = identifier({ value: input.projectId, label: "project" }),
		sceneId = identifier({ value: input.sceneId, label: "scene" }),
		title = text({
			value: input.title,
			max: 160,
			label: "title",
		});
	const durationTicks = input.durationTicks;
	if (
		!Number.isSafeInteger(durationTicks) ||
		Number(durationTicks) <= 0 ||
		Number(durationTicks) > 120000 * 3600 * 12
	)
		throw new ReviewError({
			message: "Invalid preview duration",
		});
	const size = input.size;
	if (
		!Number.isSafeInteger(size) ||
		Number(size) < 16 ||
		Number(size) > MAX_REVIEW_BYTES
	)
		throw new ReviewError({
			message: "Preview must be between 16 bytes and 512 MB",
			status: 413,
		});
	const mime = input.mime;
	if (mime !== "video/mp4" && mime !== "video/webm")
		throw new ReviewError({
			message: "Preview must be MP4 or WebM",
		});
	let password: Review["password"];
	if (input.password !== undefined && input.password !== "") {
		if (
			typeof input.password !== "string" ||
			input.password.length < 8 ||
			input.password.length > 128
		)
			throw new ReviewError({
				message: "Use a password between 8 and 128 characters",
			});
		const salt = randomBytes(16).toString("hex");
		password = {
			salt,
			hash: (await derive({ password: input.password, salt })).toString("hex"),
		};
	}
	return locked({
		path: join(accountDataRoot(), "client-reviews"),
		action: async () => {
			const names = (
				await readdir(join(accountDataRoot(), "client-reviews"))
			).filter((x) => UUID.test(x));
			const prior = await Promise.all(
				names.map((x) =>
					load({
						accountId: requireAccount().id,
						id: x,
					}),
				),
			);
			if (
				prior.filter((x) => !x.revoked && x.expiresAt > Date.now()).length >=
					100 ||
				prior.filter((x) => !x.revoked).reduce((n, x) => n + x.size, 0) +
					Number(size) >
					MAX_ACCOUNT_BYTES
			)
				throw new ReviewError({
					message: "Preview storage is full. Revoke old links first.",
					status: 409,
				});
			if (
				prior.filter(
					(value) =>
						value.projectId === projectId && (value.ready || !value.revoked),
				).length >= 100
			)
				throw new ReviewError({
					message:
						"This project has reached its 100 preview-version limit. Use a new project for further versions.",
					status: 409,
				});
			const id = randomUUID(),
				token = randomBytes(32).toString("base64url");
			const review: Review = {
				share: {
					shareId: id,
					version: randomUUID(),
					sceneId,
					durationTicks: Number(durationTicks),
					createdAt: new Date().toISOString(),
					title,
				},
				accountId: requireAccount().id,
				projectId,
				token,
				secret: randomBytes(32).toString("hex"),
				password,
				ready: false,
				revoked: false,
				expiresAt: Date.now() + TTL,
				size: Number(size),
				mime,
				comments: [],
				requests: {},
			};
			await mkdir(
				dir({
					accountId: review.accountId,
					id: id,
				}),
				{ recursive: true, mode: 0o700 },
			);
			await atomic({
				path: metadata(review),
				data: review,
			});
			await mkdir(root(), { recursive: true, mode: 0o700 });
			await atomic({
				path: join(root(), hash(token)),
				data: {
					accountId: review.accountId,
					id,
				},
			});
			return ownerView({
				review: review,
				origin: localRequestOrigin(request),
			});
		},
	});
}
export async function getOwnerReview({
	request,
	id,
}: {
	request: Request;
	id: string;
}) {
	return ownerView({
		review: await load({
			accountId: requireAccount().id,
			id: id,
		}),
		origin: localRequestOrigin(request),
	});
}
export async function uploadReview({
	request,
	id,
}: {
	request: Request;
	id: string;
}) {
	assertLocalOrigin(request);
	const accountId = requireAccount().id;
	await load({
		accountId: accountId,
		id: id,
	});
	return locked({
		path: dir({
			accountId: accountId,
			id: id,
		}),
		action: async () => {
			const review = await load({
				accountId: accountId,
				id: id,
			});
			active(review);
			if (review.ready)
				throw new ReviewError({
					message: "This preview version is already published",
					status: 409,
				});
			if (request.headers.get("content-type") !== review.mime || !request.body)
				throw new ReviewError({
					message: "Invalid video upload",
				});
			const rawOffset = request.headers.get("Upload-Offset");
			const offset =
				rawOffset === null
					? 0
					: /^\d+$/.test(rawOffset)
						? Number(rawOffset)
						: NaN;
			if (!Number.isSafeInteger(offset) || offset < 0 || offset >= review.size)
				throw new ReviewError({
					message: "Invalid upload offset",
					status: 409,
				});
			if (rawOffset === null && review.size > MAX_REVIEW_CHUNK_BYTES)
				throw new ReviewError({
					message: "Upload previews in chunks of at most 8 MB",
					status: 413,
				});
			const declared = request.headers.get("content-length");
			if (
				declared !== null &&
				(!/^\d+$/.test(declared) ||
					Number(declared) > MAX_REVIEW_CHUNK_BYTES ||
					offset + Number(declared) > review.size)
			)
				throw new ReviewError({
					message: "Invalid upload chunk size",
					status: 413,
				});
			const path = join(
				dir({
					accountId: accountId,
					id: id,
				}),
				"video.part",
			);
			const prior = await stat(path)
				.then((value) => value.size)
				.catch((error) => {
					if (error.code === "ENOENT") return 0;
					throw error;
				});
			if (prior !== offset)
				throw new ReviewError({
					message: "Upload offset changed. Create a new preview.",
					status: 409,
				});
			const file = await open(path, offset === 0 ? "w+" : "r+", 0o600);
			const reader = request.body.getReader();
			let received = 0,
				promoted = false;
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					const position = offset + received;
					received += value.byteLength;
					if (
						received > MAX_REVIEW_CHUNK_BYTES ||
						offset + received > review.size
					)
						throw new ReviewError({
							message: "Upload chunk is too large",
							status: 413,
						});
					let written = 0;
					while (written < value.byteLength) {
						const result = await file.write(
							value,
							written,
							value.byteLength - written,
							position + written,
						);
						if (!result.bytesWritten)
							throw new ReviewError({
								message: "Video chunk could not be written",
							});
						written += result.bytesWritten;
					}
				}
				if (!received || (declared !== null && Number(declared) !== received))
					throw new ReviewError({
						message: "Video upload chunk was incomplete",
					});
				const total = offset + received;
				if (rawOffset === null && total !== review.size)
					throw new ReviewError({
						message: "Video upload was incomplete",
					});
				if (total === review.size) {
					const first = Buffer.alloc(16);
					await file.read(first, 0, first.length, 0);
					if (
						review.mime === "video/mp4"
							? first.toString("ascii", 4, 8) !== "ftyp"
							: first.subarray(0, 4).toString("hex") !== "1a45dfa3"
					)
						throw new ReviewError({
							message: "Video contents do not match its format",
						});
				}
				await file.close();
				review.uploadedBytes = total;
				if (total === review.size) {
					await rename(
						path,
						join(
							dir({
								accountId: accountId,
								id: id,
							}),
							"video",
						),
					);
					promoted = true;
					review.ready = true;
				}
				await atomic({
					path: metadata(review),
					data: review,
				});
				return ownerView({
					review: review,
					origin: localRequestOrigin(request),
				});
			} catch (error) {
				await reader.cancel().catch(() => {});
				// A failed chunk never consumes an offset. Earlier completed chunks remain.
				await file.close().catch(() => {});
				if (promoted)
					await rename(
						join(
							dir({
								accountId: accountId,
								id: id,
							}),
							"video",
						),
						path,
					).catch(() => {});
				await truncate(path, offset).catch(() => {});
				throw error;
			} finally {
				reader.releaseLock();
			}
		},
	});
}
export async function updateReview({
	request,
	id,
}: {
	request: Request;
	id: string;
}) {
	assertLocalOrigin(request);
	const input = await reviewJson(request);
	const accountId = requireAccount().id;
	await load({
		accountId: accountId,
		id: id,
	});
	return locked({
		path: dir({
			accountId: accountId,
			id: id,
		}),
		action: async () => {
			const review = await load({
				accountId: accountId,
				id: id,
			});
			active(review);
			const comment = review.comments.find((x) => x.id === input.commentId);
			if (!comment || typeof input.resolved !== "boolean")
				throw new ReviewError({
					message: "Comment not found",
					status: 404,
				});
			if (comment.resolved !== input.resolved) {
				comment.resolved = input.resolved;
				comment.serverRevision++;
				await atomic({
					path: metadata(review),
					data: review,
				});
			}
			return ownerView({
				review: review,
				origin: localRequestOrigin(request),
			});
		},
	});
}
export async function revokeReview({
	request,
	id,
}: {
	request: Request;
	id: string;
}) {
	assertLocalOrigin(request);
	const accountId = requireAccount().id;
	await load({
		accountId: accountId,
		id: id,
	});
	return locked({
		path: dir({
			accountId: accountId,
			id: id,
		}),
		action: async () => {
			const review = await load({
				accountId: accountId,
				id: id,
			});
			review.revoked = true;
			review.secret = randomBytes(32).toString("hex");
			await atomic({
				path: metadata(review),
				data: review,
			});
			await rm(join(root(), hash(review.token)), { force: true });
			await rm(
				join(
					dir({
						accountId: accountId,
						id: id,
					}),
					"video",
				),
				{ force: true },
			);
			await rm(
				join(
					dir({
						accountId: accountId,
						id: id,
					}),
					"video.part",
				),
				{ force: true },
			);
			return { revoked: true };
		},
	});
}
async function byToken(token: string) {
	if (!TOKEN.test(token))
		throw new ReviewError({
			message: "Review not found",
			status: 404,
		});
	let index;
	try {
		index = JSON.parse(await readFile(join(root(), hash(token)), "utf8"));
	} catch {
		throw new ReviewError({
			message: "Review not found",
			status: 404,
		});
	}
	const review = await load({
		accountId: index.accountId,
		id: index.id,
	});
	active(review);
	if (!review.ready)
		throw new ReviewError({
			message: "This preview is not ready yet",
			status: 404,
		});
	return review;
}
const cookieName = (r: Review) =>
	`pocut_review_${r.share.shareId.replaceAll("-", "")}`;
const sign = ({ r, value }: { r: Review; value: string }) =>
	createHmac("sha256", r.secret).update(value).digest("hex");
function authorized({ request, r }: { request: Request; r: Review }) {
	if (!r.password) return true;
	const cookie = request.headers
		.get("cookie")
		?.split(";")
		.map((x) => x.trim())
		.find((x) => x.startsWith(`${cookieName(r)}=`))
		?.split("=")[1];
	if (!cookie) return false;
	const [expires, signature] = cookie.split(".");
	if (
		!/^\d+$/.test(expires) ||
		Number(expires) < Date.now() ||
		!signature ||
		!/^[a-f0-9]{64}$/.test(signature)
	)
		return false;
	return timingSafeEqual(
		Buffer.from(signature, "hex"),
		Buffer.from(
			sign({
				r: r,
				value: expires,
			}),
			"hex",
		),
	);
}
const attempts = new Map<
	string,
	{
		count: number;
		reset: number;
	}
>();
function limit({ key, max }: { key: string; max: number }) {
	const now = Date.now();
	if (attempts.size > 5000)
		for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
	if (attempts.size > 5000)
		throw new ReviewError({
			message: "Try again shortly",
			status: 429,
		});
	const prior = attempts.get(key);
	const item =
		prior && prior.reset > now ? prior : { count: 0, reset: now + 60000 };
	if (++item.count > max)
		throw new ReviewError({
			message: "Too many requests. Try again in a minute.",
			status: 429,
		});
	attempts.set(key, item);
}
function publicView(r: Review) {
	return { share: r.share, comments: r.comments, expiresAt: r.expiresAt };
}
export async function publicReview({
	request,
	token,
}: {
	request: Request;
	token: string;
}) {
	const r = await byToken(token);
	if (
		!authorized({
			request: request,
			r: r,
		})
	)
		return Response.json(
			{ locked: true },
			{ status: 401, headers: privateHeaders() },
		);
	return Response.json(publicView(r), { headers: privateHeaders() });
}
export async function mutatePublicReview({
	request,
	token,
}: {
	request: Request;
	token: string;
}) {
	assertLocalOrigin(request);
	const initial = await byToken(token);
	limit({
		key: hash(token),
		max: 60,
	});
	const input = await reviewJson(request);
	if (input.action === "unlock") {
		limit({
			key: `password:${hash(token)}`,
			max: 10,
		});
		if (!initial.password)
			return Response.json(publicView(initial), { headers: privateHeaders() });
		if (typeof input.password !== "string" || input.password.length > 128)
			throw new ReviewError({
				message: "Incorrect password",
				status: 403,
			});
		const actual = await derive({
			password: input.password,
			salt: initial.password.salt,
		});
		if (!timingSafeEqual(actual, Buffer.from(initial.password.hash, "hex")))
			throw new ReviewError({
				message: "Incorrect password",
				status: 403,
			});
		return locked({
			path: dir({
				accountId: initial.accountId,
				id: initial.share.shareId,
			}),
			action: async () => {
				const current = await load({
					accountId: initial.accountId,
					id: initial.share.shareId,
				});
				active(current);
				if (
					current.password?.hash !== initial.password?.hash ||
					current.password?.salt !== initial.password?.salt
				)
					throw new ReviewError({
						message: "The review password changed. Try again.",
						status: 409,
					});
				const expires = String(Date.now() + 12 * 3600000);
				return Response.json(publicView(current), {
					headers: {
						...privateHeaders(),
						"Set-Cookie": `${cookieName(current)}=${expires}.${sign({
							r: current,
							value: expires,
						})}; HttpOnly; SameSite=Strict; Path=/api/client-review/${token}; Max-Age=43200${process.env.OPENCUT_PUBLIC_ORIGIN ? "; Secure" : ""}`,
					},
				});
			},
		});
	}
	if (
		!authorized({
			request: request,
			r: initial,
		})
	)
		throw new ReviewError({
			message: "Enter the review password first",
			status: 401,
		});
	if (input.action !== "comment")
		throw new ReviewError({
			message: "Unknown review action",
		});
	return locked({
		path: join(accountsRoot(), "data", initial.accountId, "client-reviews"),
		action: () =>
			locked({
				path: dir({
					accountId: initial.accountId,
					id: initial.share.shareId,
				}),
				action: async () => {
					const r = await load({
						accountId: initial.accountId,
						id: initial.share.shareId,
					});
					active(r);
					const nonce = text({
						value: input.nonce,
						max: 36,
						label: "comment request",
					});
					checkedId(nonce);
					if (r.requests[nonce]) {
						const prior = r.comments.find(
							(comment) => comment.id === r.requests[nonce],
						);
						if (
							!prior ||
							prior.body !==
								text({
									value: input.body,
									max: 2000,
									label: "comment",
								}) ||
							prior.authorName !==
								text({
									value: input.authorName,
									max: 80,
									label: "name",
								}) ||
							prior.timeTicks !== input.timeTicks
						)
							throw new ReviewError({
								message:
									"This comment request was already used for different content.",
								status: 409,
							});
						return Response.json(publicView(r), { headers: privateHeaders() });
					}
					const timeTicks = input.timeTicks;
					if (
						!Number.isSafeInteger(timeTicks) ||
						Number(timeTicks) < 0 ||
						Number(timeTicks) > r.share.durationTicks
					)
						throw new ReviewError({
							message: "Choose a time inside this preview",
						});
					const comment: ClientReviewComment = {
						id: randomUUID(),
						shareId: r.share.shareId,
						shareVersion: r.share.version,
						sceneId: r.share.sceneId,
						timeTicks: Number(timeTicks),
						body: text({
							value: input.body,
							max: 2000,
							label: "comment",
						}),
						authorName: text({
							value: input.authorName,
							max: 80,
							label: "name",
						}),
						createdAt: new Date().toISOString(),
						serverRevision: 1,
						resolved: false,
					};
					const names = (
						await readdir(
							join(accountsRoot(), "data", r.accountId, "client-reviews"),
						)
					).filter((name) => UUID.test(name));
					const related = (
						await Promise.all(
							names.map((name) =>
								load({
									accountId: r.accountId,
									id: name,
								}).catch(() => null),
							),
						)
					).filter(
						(value): value is Review =>
							!!value && value.projectId === r.projectId,
					);
					const projectComments = related.flatMap((value) => value.comments);
					if (
						projectComments.length >= MAX_PROJECT_COMMENTS ||
						Buffer.byteLength(
							JSON.stringify([...projectComments, comment]),
							"utf8",
						) > MAX_PROJECT_COMMENT_BYTES
					)
						throw new ReviewError({
							message:
								"This project has reached its feedback limit. Preserve existing feedback and use a new project for further reviews.",
							status: 409,
						});
					r.comments.push(comment);
					r.requests[nonce] = comment.id;
					await atomic({
						path: metadata(r),
						data: r,
					});
					return Response.json(publicView(r), { headers: privateHeaders() });
				},
			}),
	});
}
export function privateHeaders() {
	return {
		"Cache-Control": "private, no-store",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
		"X-Robots-Tag": "noindex, nofollow",
	};
}
export async function reviewMedia({
	request,
	token,
}: {
	request: Request;
	token: string;
}) {
	const r = await byToken(token);
	if (
		!authorized({
			request: request,
			r: r,
		})
	)
		throw new ReviewError({
			message: "Enter the review password first",
			status: 401,
		});
	const path = join(
			dir({
				accountId: r.accountId,
				id: r.share.shareId,
			}),
			"video",
		),
		size = (await stat(path)).size;
	const range = request.headers.get("range");
	let start = 0,
		end = size - 1;
	if (range) {
		const match = /^bytes=(\d*)-(\d*)$/.exec(range);
		if (!match || (!match[1] && !match[2]))
			throw new ReviewError({
				message: "Invalid video range",
				status: 416,
			});
		if (match[1]) {
			start = Number(match[1]);
			end = match[2] ? Math.min(Number(match[2]), end) : end;
		} else start = Math.max(0, size - Number(match[2]));
		if (
			!Number.isSafeInteger(start) ||
			start < 0 ||
			start >= size ||
			end < start
		)
			return new Response(null, {
				status: 416,
				headers: { "Content-Range": `bytes */${size}`, ...privateHeaders() },
			});
	}
	const headers = {
		...privateHeaders(),
		"Content-Type": r.mime,
		"Content-Length": String(end - start + 1),
		"Accept-Ranges": "bytes",
		...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
	};
	const nativeBody =
		request.method === "HEAD"
			? null
			: Readable.toWeb(createReadStream(path, { start, end }));
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Node returns a WHATWG byte stream; its Node type declaration differs from the DOM Response declaration.
	const body = nativeBody as unknown as ReadableStream | null;
	return new Response(body, { status: range ? 206 : 200, headers });
}
export async function reviewResponse(
	action: () => Promise<Response | unknown>,
) {
	try {
		const value = await action();
		return value instanceof Response
			? value
			: Response.json(value, { headers: privateHeaders() });
	} catch (error) {
		return Response.json(
			{
				error:
					error instanceof ReviewError
						? error.message
						: "Review could not be completed. Please try again.",
			},
			{
				status: error instanceof ReviewError ? error.status : 500,
				headers: privateHeaders(),
			},
		);
	}
}
