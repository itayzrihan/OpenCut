import type { Metadata } from "next";
import type { LegalRouteProps } from "@/legal/documents";
import { englishLegal } from "@/legal/en";
import { LegalPage } from "@/legal/page";

export const metadata: Metadata = {
	title: "Privacy policy - POCUT",
	description: englishLegal.documents.privacy.description,
	robots: { index: false },
};

export default async function PrivacyPage({ searchParams }: LegalRouteProps) {
	return (
		<LegalPage id="privacy" requestedLanguage={(await searchParams).lang} />
	);
}
