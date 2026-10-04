/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Test adapter for the DOM parser shipped with pinned HyperFrames. */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(
	import.meta.resolve("@hyperframes/core/gsap-parser-acorn"),
);
export const { parseHTML } = (await import(
	pathToFileURL(require.resolve("linkedom")).href
)) as { parseHTML: (html: string) => { document: Document } };
