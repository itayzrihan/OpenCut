import type { DirectorJob } from "./types";
import { formatMessage, type Translate } from "@/i18n/locales";

const elapsedMessages = {
	waiting: [
		"Less than a minute waiting",
		"1 minute waiting",
		"{v0} minutes waiting",
	],
	processing: [
		"Less than a minute in progress",
		"1 minute in progress",
		"{v0} minutes in progress",
	],
} as const;

function elapsed({
	now,
	since,
	phase,
	t,
}: {
	now: number;
	since: number;
	phase: keyof typeof elapsedMessages;
	t: Translate;
}) {
	const minutes = Math.max(0, Math.floor((now - since) / 60_000));
	return t(elapsedMessages[phase][Math.min(minutes, 2)], { v0: minutes });
}

export function directorJobProgress({
	job,
	now,
	t = (message, values) => formatMessage({ catalog: {}, message, values }),
}: {
	job: DirectorJob;
	now: number;
	t?: Translate;
}) {
	if (job.status === "submitting") {
		return job.provider === "chatgpt"
			? { label: t("Generating image in ChatGPT") }
			: { label: t("Submitting to provider") };
	}
	if (job.status === "pending") {
		const since = job.providerStatusAt ?? job.submittedAt;
		return {
			label: t("Queued by provider"),
			detail:
				since === undefined
					? undefined
					: elapsed({ now, since, phase: "waiting", t }),
		};
	}
	if (job.status === "processing") {
		if (job.providerStatus === "completed")
			return { label: t("Downloading video") };
		return {
			label: t("Generating with provider"),
			detail:
				job.providerStatusAt === undefined
					? undefined
					: elapsed({
							now,
							since: job.providerStatusAt,
							phase: "processing",
							t,
						}),
		};
	}
}
