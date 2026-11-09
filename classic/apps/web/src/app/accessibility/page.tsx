import type { Metadata } from "next";
import type { LegalRouteProps } from "@/legal/documents";
import { englishLegal } from "@/legal/en";
import { LegalPage } from "@/legal/page";

export const metadata: Metadata = {
	title: "Accessibility statement - POCUT",
	description: englishLegal.documents.accessibility.description,
	robots: { index: false },
};

export default async function AccessibilityPage({
	searchParams,
}: LegalRouteProps) {
	return (
		<LegalPage
			id="accessibility"
			requestedLanguage={(await searchParams).lang}
		/>
	);
}
