const FONT_LOAD_SAMPLE_TEXTS = [
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
	"אבגדהוזחטיכלמנסעפצקרשת",
];

export async function loadDocumentFontSamples({
	font,
}: {
	font: string;
}): Promise<boolean> {
	const loadedFaces = await Promise.all(
		FONT_LOAD_SAMPLE_TEXTS.map((sampleText) =>
			document.fonts.load(font, sampleText),
		),
	);
	return loadedFaces.some((faces) => faces.length > 0);
}
