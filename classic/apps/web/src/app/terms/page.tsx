import type { Metadata } from "next";
import type { LegalRouteProps } from "@/legal/documents";
import { englishLegal } from "@/legal/en";
import { LegalPage } from "@/legal/page";

export const metadata: Metadata = {
	title: "Terms of use - POCUT",
	description: englishLegal.documents.terms.description,
	robots: { index: false },
};

export default async function TermsPage({ searchParams }: LegalRouteProps) {
	return <LegalPage id="terms" requestedLanguage={(await searchParams).lang} />;
}
