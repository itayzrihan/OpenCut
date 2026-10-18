/* eslint-disable opencut/prefer-object-params -- Internal filesystem adapters mirror platform handle, buffer and offset APIs. */
/** Disposable host IO, not editor state. Every export owns its directory, so
 * cancellation can never remove another tab's files. Files survive only while
 * a completed result is available for download. */
export class ExportScratch {
	private release?: () => void;
	private constructor(
		private parent: FileSystemDirectoryHandle,
		readonly directory: FileSystemDirectoryHandle,
		private name: string,
	) {}

	static async create(): Promise<ExportScratch> {
		if (!navigator.storage?.getDirectory)
			throw new Error(
				"Disk-backed export is unavailable in this browser. Use Chrome or the desktop app.",
			);
		const root = await navigator.storage.getDirectory();
		const parent = await root.getDirectoryHandle("opencut-exports", {
			create: true,
		});
		// Reclaim abandoned/completed exports after a day. An active export in
		// another tab is protected by its lease, including exports over 24 hours.
		if (navigator.locks) {
			for await (const name of parent.keys()) {
				const created = Number(name.split("-")[0]);
				if (!Number.isFinite(created) || Date.now() - created < 86400000)
					continue;
				await navigator.locks.request(
					`opencut-export-${name}`,
					{ ifAvailable: true },
					async (lock) => {
						if (lock)
							await parent
								.removeEntry(name, { recursive: true })
								.catch(() => undefined);
					},
				);
			}
		}
		const name = `${Date.now()}-${crypto.randomUUID()}`;
		const scratch = new ExportScratch(
			parent,
			await parent.getDirectoryHandle(name, { create: true }),
			name,
		);
		if (navigator.locks) {
			await new Promise<void>((resolve, reject) => {
				void navigator.locks
					.request(
						`opencut-export-${name}`,
						() =>
							new Promise<void>((release) => {
								scratch.release = release;
								resolve();
							}),
					)
					.catch(reject);
			});
		}
		return scratch;
	}

	async file(name: string): Promise<FileSystemFileHandle> {
		return this.directory.getFileHandle(name, { create: true });
	}

	async remove(name: string): Promise<void> {
		await this.directory.removeEntry(name).catch(() => undefined);
	}

	async dispose(): Promise<void> {
		await this.parent
			.removeEntry(this.name, { recursive: true })
			.catch(() => undefined);
		this.retain();
	}

	/** Keep a fallback download file until expiry; a download may still read it. */
	retain(): void {
		this.release?.();
		this.release = undefined;
	}
}

/** Early estimate only; every actual write still propagates quota/disk errors. */
export async function checkExportDiskSpace(bytes: number): Promise<void> {
	const { quota, usage } = await navigator.storage.estimate();
	if (quota !== undefined && usage !== undefined && quota - usage < bytes)
		throw new Error(
			`Not enough temporary disk space for export (at least ${Math.ceil(bytes / 1024 ** 3)} GB needed). Free disk space and retry.`,
		);
}
