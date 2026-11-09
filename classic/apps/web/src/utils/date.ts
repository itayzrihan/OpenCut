export function formatDate({
	date,
	locale = "en-US",
}: {
	date: Date;
	locale?: string;
}): string {
	return date.toLocaleDateString(locale === "en" ? "en-US" : locale, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}
