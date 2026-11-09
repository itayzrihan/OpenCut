export function directorPrompt({
	kind,
	direction,
	transcript,
	instructions,
	aspectRatio,
}: {
	kind: "storyboard" | "video";
	direction: string;
	transcript: string;
	instructions: string;
	aspectRatio: string;
}): string {
	if (!direction.trim()) throw new Error("Enter a directing brief first");
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(direction.trim());
	let structured: Record<string, unknown> | undefined;
	try {
		const value: unknown = JSON.parse(fenced?.[1] ?? direction);
		if (value && typeof value === "object" && !Array.isArray(value))
			structured = Object.fromEntries(Object.entries(value));
	} catch {
		// A directing brief can also be plain text or Markdown.
	}
	if (kind === "storyboard") {
		const explicitPrompt = structured?.storyboard_prompt;
		if (typeof explicitPrompt === "string" && explicitPrompt.trim())
			return explicitPrompt;
		return [
			`Draw one storyboard sheet for a ${aspectRatio} video. Use chronological panels, consistent subjects and locations, and indicate the intended camera moves and cuts. Follow this directing brief:`,
			direction,
		].join("\n\n");
	}
	return JSON.stringify({
		...(structured ?? { direction }),
		priority_instructions: instructions,
		original_transcript: transcript || structured?.spoken_script,
	});
}
