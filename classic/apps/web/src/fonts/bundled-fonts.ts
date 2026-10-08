import { isProjectFontLoaded, loadProjectFont } from "./custom-fonts";

/** Static bold face, served with the app, including Hebrew and Latin glyphs. */
export const BUNDLED_ASSISTANT_BOLD = "Assistant Bold";

export async function loadBundledAssistantBold(): Promise<string> {
	await loadProjectFont({
		font: {
			family: BUNDLED_ASSISTANT_BOLD,
			sourceUrl: "/fonts/assistant/Assistant-Bold.ttf",
		},
	});
	if (!isProjectFontLoaded({ family: BUNDLED_ASSISTANT_BOLD }))
		throw new Error(
			"Could not load the bundled Assistant Bold font. Retry Full Auto Edit.",
		);
	return BUNDLED_ASSISTANT_BOLD;
}
