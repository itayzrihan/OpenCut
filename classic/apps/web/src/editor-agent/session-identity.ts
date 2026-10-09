/** Browser transport identity only; Rust remains the authority for ownership.
 * A Web Lock makes a sessionStorage identity exclusive to one live document,
 * including when a duplicated tab inherits sessionStorage from its opener.
 * The browser releases the lock on reload, allowing that tab to resume itself.
 */
const identities = new Map<string, Promise<string>>();

export function browserEditorSessionId({
	accountId,
	projectId,
}: {
	accountId: string;
	projectId: string;
}): Promise<string> {
	if (
		typeof window === "undefined" ||
		typeof navigator === "undefined" ||
		!navigator.locks
	)
		return Promise.resolve(crypto.randomUUID());
	const key = `opencut-editor-session:${JSON.stringify([accountId, projectId])}`;
	const existing = identities.get(key);
	if (existing) return existing;
	const identity = claimIdentity(key);
	identities.set(key, identity);
	return identity;
}

async function claimIdentity(key: string): Promise<string> {
	let candidate: string | null = null;
	try {
		candidate = window.sessionStorage.getItem(key);
	} catch {
		/* Private storage can be unavailable. */
	}
	if (!candidate || !/^[a-zA-Z0-9-]{1,128}$/.test(candidate))
		candidate = crypto.randomUUID();
	for (;;) {
		const id = candidate;
		const held = await new Promise<boolean>((resolve, reject) => {
			void navigator.locks
				.request(
					`opencut-editor-identity:${id}`,
					{ ifAvailable: true },
					async (lock) => {
						resolve(!!lock);
						if (lock) await new Promise<void>(() => {}); // Hold until this document closes.
					},
				)
				.catch(reject);
		}).catch(() => null);
		// Without browser exclusivity, use an ephemeral ID; never trust a copied ID.
		if (held === null) return crypto.randomUUID();
		if (held) {
			try {
				window.sessionStorage.setItem(key, id);
			} catch {
				/* Identity still lasts for this document. */
			}
			return id;
		}
		candidate = crypto.randomUUID();
	}
}
