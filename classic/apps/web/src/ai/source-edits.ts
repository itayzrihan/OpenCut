/**
 * openclaw-style exact-text edits for the timeline source document.
 * Semantics mirror a code edit tool: exact match first, fuzzy fallback for
 * quote/dash/space and trailing-whitespace differences, uniqueness required,
 * overlap detection, all edits matched against the same original content and
 * applied in reverse offset order. Error messages teach the model how to fix
 * its call.
 */

export interface SourceEdit {
	oldText: string;
	newText: string;
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeCharForFuzzyMatch(char: string): string {
	if (/[\u2018\u2019\u201A\u201B]/u.test(char)) return "'";
	if (/[\u201C\u201D\u201E\u201F]/u.test(char)) return '"';
	if (/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/u.test(char)) return "-";
	if (/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/u.test(char)) return " ";
	return char;
}

function normalizeForFuzzyMatch(text: string): string {
	return text
		.split("\n")
		.map((line) =>
			Array.from(line.trimEnd()).map(normalizeCharForFuzzyMatch).join(""),
		)
		.join("\n");
}

function buildFuzzyIndex(content: string): {
	text: string;
	offsets: number[];
} {
	const lines = content.split("\n");
	const parts: string[] = [];
	const offsets: number[] = [];
	let sourceOffset = 0;

	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex] ?? "";
		const trimmedLength = line.replace(/[ \t]+$/u, "").length;
		for (let charIndex = 0; charIndex < trimmedLength; charIndex += 1) {
			parts.push(normalizeCharForFuzzyMatch(line.charAt(charIndex)));
			offsets.push(sourceOffset + charIndex);
		}
		sourceOffset += line.length;
		if (lineIndex < lines.length - 1) {
			parts.push("\n");
			offsets.push(sourceOffset);
			sourceOffset += 1;
		}
	}

	return { text: parts.join(""), offsets };
}

function countOccurrences({
	content,
	oldText,
}: {
	content: string;
	oldText: string;
}): number {
	return content.split(oldText).length - 1;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

/**
 * Apply one or more exact-text replacements to the timeline source.
 * Throws with an instructive message when a match fails.
 */
export function applySourceEdits({
	content,
	edits,
}: {
	content: string;
	edits: SourceEdit[];
}): string {
	if (edits.length === 0) {
		throw new Error("No edits provided. Pass edits: [{oldText, newText}].");
	}
	const normalizedContent = normalizeToLF(content);
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText ?? ""),
		newText: normalizeToLF(edit.newText ?? ""),
	}));

	for (let i = 0; i < normalizedEdits.length; i += 1) {
		if (normalizedEdits[i].oldText.length === 0) {
			throw new Error(
				`edits[${i}].oldText must not be empty. To insert new lines, include an adjacent existing line in oldText and repeat it in newText with the new line added.`,
			);
		}
	}

	const fuzzyIndex = buildFuzzyIndex(normalizedContent);
	const matched: MatchedEdit[] = [];
	for (let i = 0; i < normalizedEdits.length; i += 1) {
		const edit = normalizedEdits[i];
		const exactIndex = normalizedContent.indexOf(edit.oldText);
		const exactOccurrences =
			exactIndex === -1
				? 0
				: countOccurrences({
						content: normalizedContent,
						oldText: edit.oldText,
					});
		if (exactOccurrences > 1) {
			throw new Error(
				`Found ${exactOccurrences} occurrences of edits[${i}].oldText in the timeline source. Each oldText must be unique - include more surrounding context (e.g. the full line with its unique "id").`,
			);
		}
		if (exactIndex !== -1) {
			matched.push({
				editIndex: i,
				matchIndex: exactIndex,
				matchLength: edit.oldText.length,
				newText: edit.newText,
			});
			continue;
		}

		const fuzzyNeedle = normalizeForFuzzyMatch(edit.oldText);
		const fuzzyMatchIndex = fuzzyIndex.text.indexOf(fuzzyNeedle);
		if (fuzzyMatchIndex === -1) {
			throw new Error(
				`Could not find edits[${i}].oldText in the timeline source. The oldText must match the source exactly, including whitespace. Copy the line(s) verbatim from OPENCUT_TIMELINE_SOURCE or timeline.read_source.`,
			);
		}
		const fuzzyOccurrences = countOccurrences({
			content: fuzzyIndex.text,
			oldText: fuzzyNeedle,
		});
		if (fuzzyOccurrences > 1) {
			throw new Error(
				`Found ${fuzzyOccurrences} fuzzy occurrences of edits[${i}].oldText in the timeline source. Each oldText must be unique - include more surrounding context (e.g. the full line with its unique "id").`,
			);
		}
		const lastFuzzyOffset = fuzzyMatchIndex + fuzzyNeedle.length - 1;
		const originalStart = fuzzyIndex.offsets[fuzzyMatchIndex];
		const originalEnd =
			fuzzyIndex.offsets[lastFuzzyOffset] === undefined
				? undefined
				: fuzzyIndex.offsets[lastFuzzyOffset] + 1;
		if (originalStart === undefined || originalEnd === undefined) {
			throw new Error(
				`Could not map edits[${i}].oldText back to the timeline source. Copy the exact line from timeline.read_source and try again.`,
			);
		}
		matched.push({
			editIndex: i,
			matchIndex: originalStart,
			matchLength: originalEnd - originalStart,
			newText: edit.newText,
		});
	}

	matched.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matched.length; i += 1) {
		const previous = matched[i - 1];
		const current = matched[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	let result = normalizedContent;
	for (let i = matched.length - 1; i >= 0; i -= 1) {
		const edit = matched[i];
		result =
			result.slice(0, edit.matchIndex) +
			edit.newText +
			result.slice(edit.matchIndex + edit.matchLength);
	}

	if (result === normalizedContent) {
		throw new Error(
			"The edits produced identical content. oldText and newText must differ.",
		);
	}
	return result;
}
