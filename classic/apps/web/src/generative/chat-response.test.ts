import { test, expect } from "bun:test";
import { directorReply } from "./chat-response";
test("reads the actual AI route envelope without exposing reasoning", () => {
	expect(
		directorReply({
			response: {
				output: [
					{
						type: "reasoning",
						content: [{ type: "text", text: "private reasoning" }],
					},
					{
						type: "message",
						content: [{ type: "output_text", text: "שלום, אני הבמאי שלך." }],
					},
				],
			},
		}),
	).toBe("שלום, אני הבמאי שלך.");
	expect(directorReply({ response: { output_text: "Director answer" } })).toBe(
		"Director answer",
	);
	expect(() => directorReply({ response: { output: [] } })).toThrow(
		"No directing response",
	);
});
