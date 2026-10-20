/** Provider/checkpoint IO only. Rust chooses stages, tools, review and repairs. */
import type {
	PodcastOptions,
	PodcastSource,
	PodcastVideo,
} from "./podcast-types";
export async function runPodcastEditorial({
	source,
	options,
	ask,
	assertCurrent,
	onStage,
	cache,
	onResume,
	onReport,
}: {
	source: PodcastSource;
	options: PodcastOptions;
	ask: (input: { instructions: string; prompt: string }) => Promise<string>;
	assertCurrent: () => void;
	onStage: (stage: string) => void;
	onResume?: (savedResponses: number) => void;
	onReport?: (report: Record<string, unknown>) => void;
	cache?: {
		key: string;
		storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
	};
}): Promise<PodcastVideo[]> {
	if (!source.editorial)
		throw new Error(
			"Reload OpenCut to load the podcast editorial runtime. No scenes were changed.",
		);
	const key = cache ? `${cache.key}:editorial-v1` : null;
	let responses: Record<string, unknown> = {};
	if (cache && key) {
		try {
			const raw = cache.storage.getItem(key);
			if (raw && raw.length <= 2_000_000) {
				const saved = JSON.parse(raw);
				if (
					saved.version === 1 &&
					saved.responses &&
					typeof saved.responses === "object" &&
					!Array.isArray(saved.responses)
				)
					responses = saved.responses;
				// One-time migration from the old exhausted journal. The v4
				// canonical policy can continue its targeted repair rounds.
				try {
					if (options.mode === "teleprompter") {
						const failedRaw = cache.storage.getItem(`${key}:failure`);
						if (failedRaw && failedRaw.length <= 2_100_000) {
							const failed = JSON.parse(failedRaw);
							if (
								failed.version === 1 &&
								(!failed.policyVersion ||
									failed.policyVersion === "teleprompter-v3") &&
								failed.responses &&
								typeof failed.responses === "object" &&
								!Array.isArray(failed.responses)
							) {
								responses = { ...failed.responses, ...responses };
								cache.storage.setItem(
									key,
									JSON.stringify({ version: 1, responses }),
								);
								cache.storage.removeItem(`${key}:failure`);
							}
						}
					}
				} catch {
					/* Keep the valid live checkpoint if legacy forensic IO is unavailable. */
				}
			}
		} catch {
			cache.storage.removeItem(key);
		}
	}
	if (Object.keys(responses).length) onResume?.(Object.keys(responses).length);
	// Bound a malformed host/runtime conversation as well as model retries.
	for (let exchange = 0; exchange < 200; exchange++) {
		assertCurrent();
		const step = source.editorial({ options, responses });
		if (
			step.policyVersion !==
			(options.mode === "teleprompter"
				? "teleprompter-v4"
				: options.mode === "teaser"
					? "strategic-teaser-v1"
					: "podcast-shorts-v2")
		)
			throw new Error(
				"Podcast runtime version changed; reload before retrying.",
			);
		onReport?.(step.report);
		if (step.complete) {
			if (cache && key)
				cache.storage.setItem(`${key}:report`, JSON.stringify(step.report));
			return step.videos;
		}
		if (typeof step.report.error === "string") {
			// Keep one bounded forensic checkpoint BEFORE clearing repair keys.
			// Retry still reuses valid maps; the failed drafts no longer disappear.
			if (cache && key) {
				try {
					cache.storage.setItem(
						`${key}:failure`,
						JSON.stringify({
							version: 1,
							policyVersion: step.policyVersion,
							report: step.report,
							responses,
						}),
					);
					cache.storage.setItem(`${key}:report`, JSON.stringify(step.report));
				} catch {
					// Optional forensic storage must not replace the canonical error.
				}
			}
			if (Array.isArray(step.report.resetKeys)) {
				for (const failedKey of step.report.resetKeys)
					if (typeof failedKey === "string") delete responses[failedKey];
				if (cache && key)
					cache.storage.setItem(key, JSON.stringify({ version: 1, responses }));
			}
			throw new Error(step.report.error);
		}
		if (!step.requests.length || step.requests.length > 2)
			throw new Error("Invalid bounded podcast request batch");
		const labels: Record<string, string> = {
			inventory:
				options.mode === "teleprompter"
					? "מיפוי תסריטים, משפטים וטייקים חוזרים"
					: "מיפוי רגעים קצרים מכל הפרק",
			compose:
				options.mode === "teleprompter"
					? "ניקוי תסריטים ושמירת טייקים חלופיים"
					: "בניית רצף וסדר עריכתי",
			critique: "ביקורת תוכן והקשר",
		};
		onStage(
			`${labels[step.requests[0].stage] ?? "בדיקת הקשר נוסף"} · ${step.report.windowsReviewed ?? 0}/${step.report.windowsTotal ?? source.windows.length} · סבב ${Number(step.report.round ?? 0) + 1}`,
		);
		// Checkpoint each success immediately, including when its sibling fails.
		const results = await Promise.allSettled(
			step.requests.map(async (job) => {
				assertCurrent();
				const raw = await ask({
					instructions: job.instructions,
					prompt: JSON.stringify(job.prompt),
				});
				assertCurrent();
				let parsed: unknown;
				try {
					const text = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? raw;
					parsed = JSON.parse(
						text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1),
					);
				} catch {
					parsed = { invalidJson: raw.slice(0, 4000) };
				}
				responses[job.key] = parsed;
				if (cache && key) {
					const raw = JSON.stringify({ version: 1, responses });
					if (raw.length > 2_000_000)
						throw new Error(
							"Podcast analysis exceeds its bounded resume cache",
						);
					cache.storage.setItem(key, raw);
				}
			}),
		);
		const failure = results.find((r) => r.status === "rejected");
		if (failure?.status === "rejected") throw failure.reason;
	}
	throw new Error(
		"Podcast analysis reached its bounded request limit. Reviewed work remains saved.",
	);
}

/** Consume successful draft artifacts only after the editor has saved output. */
export function consumePodcastEditorialDraft({
	storage,
	key,
}: {
	storage: Pick<Storage, "getItem" | "setItem">;
	key: string;
}) {
	const cacheKey = `${key}:editorial-v1`;
	const raw = storage.getItem(cacheKey);
	if (!raw) return;
	try {
		const checkpoint = JSON.parse(raw);
		if (checkpoint.version !== 1 || !checkpoint.responses) return;
		checkpoint.responses = Object.fromEntries(
			Object.entries(checkpoint.responses).filter(([k]) =>
				k.startsWith("inventory:"),
			),
		);
		storage.setItem(cacheKey, JSON.stringify(checkpoint));
	} catch {
		/* A corrupt optional checkpoint cannot invalidate a saved scene. */
	}
}
