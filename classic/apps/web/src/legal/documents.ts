export const legalRoutes = {
	privacy: {
		href: "/privacy",
		label: "Privacy policy",
		hebrewLabel: "מדיניות פרטיות",
	},
	terms: { href: "/terms", label: "Terms of use", hebrewLabel: "תנאי שימוש" },
	accessibility: {
		href: "/accessibility",
		label: "Accessibility",
		hebrewLabel: "נגישות",
	},
} as const;

export type LegalPageId = keyof typeof legalRoutes;
export type LegalLanguage = "en" | "he";
export type LegalRouteProps = {
	searchParams: Promise<{ lang?: string | string[] }>;
};

export type LegalSection = {
	heading: string;
	paragraphs?: readonly string[];
	items?: readonly string[];
};

export type LegalDocument = {
	title: string;
	description: string;
	sections: Readonly<Record<string, LegalSection>>;
};

export type LegalEdition = {
	draft: string;
	development: string;
	contents: string;
	documents: Record<LegalPageId, LegalDocument>;
};

export const legalReferences: Partial<
	Record<
		LegalPageId,
		Record<string, readonly { label: string; href: string }[]>
	>
> = {
	privacy: {
		"external-ai": [
			{
				label: "OpenAI",
				href: "https://openai.com/policies/row-privacy-policy/",
			},
			{
				label: "OpenRouter",
				href: "https://openrouter.ai/docs/guides/privacy/data-collection",
			},
		],
		rights: [
			{
				label: "Israel Privacy Protection Authority",
				href: "https://www.gov.il/he/departments/the_privacy_protection_authority/govil-landing-page",
			},
		],
	},
	accessibility: {
		"standards-and-status": [
			{ label: "WCAG 2.2", href: "https://www.w3.org/TR/WCAG22/" },
		],
	},
};
