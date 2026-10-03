/** Host detector transport. The recipe decides whether centered-cover fallback is allowed. */
export async function requestSubjectDetections({
	frames,
	signal,
}: {
	frames: string[];
	signal: AbortSignal;
}): Promise<
	{ available: true; data: unknown } | { available: false; error: string }
> {
	const response = await fetch("/api/local-subject-framing", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ frames }),
		signal,
	});
	const data = await response.json();
	if (response.status === 503)
		return {
			available: false,
			error: data.error || "Subject detector unavailable",
		};
	if (!response.ok) throw new Error(data.error || "Local detector failed");
	return { available: true, data };
}
