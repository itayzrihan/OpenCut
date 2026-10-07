import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	randomUUID,
} from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";

const connectionSchema = z
	.object({
		version: z.literal(1),
		clientId: z.string().min(1).max(256).optional(),
		subject: z.string().min(1).max(512).optional(),
		email: z.string().max(512).optional(),
		name: z.string().max(512).optional(),
		scopes: z.array(z.string().max(256)),
		accessToken: z.string().max(64_000).optional(),
		refreshToken: z.string().max(64_000).optional(),
		idToken: z.string().max(64_000).optional(),
		expiresAt: z.number().finite().optional(),
		// A rotating refresh response is persisted before identity verification.
		pendingRefresh: z
			.object({
				accessToken: z.string().min(1).max(64_000),
				refreshToken: z.string().min(1).max(64_000),
				idToken: z.string().max(64_000).optional(),
				expiresAt: z.number().finite(),
				scopes: z.array(z.string().max(256)),
				receivedAt: z.number().finite(),
			})
			.optional(),
	})
	.strict();

export type ChatGPTConnection = z.infer<typeof connectionSchema>;

/** Host IO adapter. The server chooses the authenticated account and key.
 * Ciphertext is bound to that owner; copying a file cannot grant another user
 * access. No method returning credentials is exposed as an HTTP operation. */
export class ChatGPTVault {
	constructor(
		private config: { directory: string; accountId: string; key: Buffer },
	) {}

	async locked<T>(
		operation: (store: {
			read: () => Promise<ChatGPTConnection>;
			write: (value: ChatGPTConnection) => Promise<void>;
		}) => Promise<T>,
	): Promise<T> {
		await mkdir(this.config.directory, { recursive: true, mode: 0o700 });
		let compromised = false;
		const release = await lockfile.lock(this.config.directory, {
			realpath: false,
			stale: 120_000,
			update: 20_000,
			retries: { retries: 30, minTimeout: 100, maxTimeout: 1000 },
			onCompromised: () => {
				compromised = true;
			},
		});
		const assertLock = () => {
			if (compromised)
				throw new Error(
					"ChatGPT credential lock was lost; reconnect before continuing",
				);
		};
		const file = join(this.config.directory, "connection.enc");
		const aad = Buffer.from(`opencut-chatgpt-v1:${this.config.accountId}`);
		try {
			return await operation({
				read: async () => {
					assertLock();
					let bytes: Buffer;
					try {
						bytes = await readFile(file);
					} catch (error) {
						if (
							error instanceof Error &&
							"code" in error &&
							error.code === "ENOENT"
						)
							return { version: 1, scopes: [] };
						throw error;
					}
					if (bytes.length < 28 || bytes.length > 1_000_000)
						throw new Error("Saved ChatGPT connection is invalid");
					const decipher = createDecipheriv(
						"aes-256-gcm",
						this.config.key,
						bytes.subarray(0, 12),
					);
					decipher.setAAD(aad);
					decipher.setAuthTag(bytes.subarray(12, 28));
					const plain = Buffer.concat([
						decipher.update(bytes.subarray(28)),
						decipher.final(),
					]);
					return connectionSchema.parse(JSON.parse(plain.toString("utf8")));
				},
				write: async (value) => {
					assertLock();
					const serialized = JSON.stringify(connectionSchema.parse(value));
					const iv = randomBytes(12);
					const cipher = createCipheriv("aes-256-gcm", this.config.key, iv);
					cipher.setAAD(aad);
					const encrypted = Buffer.concat([
						cipher.update(serialized, "utf8"),
						cipher.final(),
					]);
					const temp = join(
						this.config.directory,
						`connection-${randomUUID()}.tmp`,
					);
					try {
						await writeFile(
							temp,
							Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
							{ flag: "wx", mode: 0o600 },
						);
						assertLock();
						await rename(temp, file);
					} finally {
						await unlink(temp).catch((error: NodeJS.ErrnoException) => {
							if (error.code !== "ENOENT") throw error;
						});
					}
				},
			});
		} finally {
			await release();
		}
	}
}
