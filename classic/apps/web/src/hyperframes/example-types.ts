export interface ExampleHit {
	id: string;
	kind: "block" | "component" | "example";
	title: string;
	description: string;
	tags: string[];
	verified: boolean;
	reviewStatus: string;
}
export interface ExampleQueryEmbedding {
	query: string;
	normalizedQuery: string;
	modelRevision: string;
	vectorRevision: string;
	vector: number[];
}
export interface ExampleSearch {
	upstreamCommit: string;
	searchMode: string;
	normalizedQuery?: string;
	fallbackReason?: string;
	totalCatalogItems: number;
	totalVerified: number;
	totalMatches: number;
	nextOffset: number | null;
	items: ExampleHit[];
}
export interface ExampleManifest {
	upstreamCommit: string;
	item: Omit<ExampleHit, "verified" | "reviewStatus"> & {
		sourceUrl: string;
		files: Array<{ path: string; bytes: number; sha256: string }>;
		parameters: unknown[];
		variables: unknown;
		preview: { video?: string; poster?: string } | null;
		prepared: {
			status: string;
			entryFile: string;
			sourceSha256: string;
			files: Array<{ path: string; bytes: number; sha256: string }>;
			evidence: {
				frames: Array<{
					file: string;
					sha256: string;
					timeSeconds: number;
					transparentPixels: boolean;
				}>;
			};
		} | null;
		registryDependencies: string[];
		licensePaths: string[];
		prompt: { status: string; text: string | null; provenance: unknown };
		verification: {
			status: string;
			missingDeclaredFiles: string[];
			reviewNote: string | null;
			dependencyClosure: boolean;
			preview: boolean;
			import: boolean;
			reopen: boolean;
		};
	};
}
export interface ExampleSourcePage {
	id: string;
	upstreamCommit: string;
	filePath: string;
	sha256: string;
	bytes: number;
	offset: number;
	totalCharacters: number;
	nextOffset: number | null;
	text: string;
}
