import { expect, test } from "bun:test";
import { appendDictation, dictationLanguage } from "./dictation";

test("dictation chooses Hebrew or English from a draft, then UI or browser language", () => {
	expect(
		dictationLanguage({ draft: "שלום", locale: "en", browser: "en-US" }),
	).toBe("he-IL");
	expect(
		dictationLanguage({ draft: "Edit this", locale: "he", browser: "he-IL" }),
	).toBe("en-US");
	expect(dictationLanguage({ draft: "", locale: "he", browser: "en-US" })).toBe(
		"he-IL",
	);
	expect(
		dictationLanguage({ draft: "123", locale: "en", browser: "he-IL" }),
	).toBe("he-IL");
	expect(dictationLanguage({ draft: "", locale: "en", browser: "en-US" })).toBe(
		"en-US",
	);
});

test("final dictation appends to the existing draft and preserves whitespace", () => {
	expect(appendDictation({ draft: "מוכן", transcript: " לעריכה " })).toBe(
		"מוכן לעריכה",
	);
	expect(
		appendDictation({ draft: "First line\n", transcript: "Second line" }),
	).toBe("First line\nSecond line");
	expect(appendDictation({ draft: "Ready", transcript: "." })).toBe("Ready.");
	expect(appendDictation({ draft: "Ready", transcript: "   " })).toBe("Ready");
	expect(
		appendDictation({ draft: "x".repeat(99999), transcript: "overflow" }),
	).toHaveLength(100000);
});
