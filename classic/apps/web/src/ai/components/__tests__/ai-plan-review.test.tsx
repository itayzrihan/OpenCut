import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AiPlanReview } from "../ai-plan-review";

describe("AiPlanReview", () => {
	test("renders a repeated plan note only once", () => {
		const repeatedNote = "Repeated creative quality warning";
		const markup = renderToStaticMarkup(
			<AiPlanReview
				plan={{
					title: "Creative edit",
					summary: "Review the treatment",
					operations: [],
					notes: [repeatedNote, repeatedNote],
				}}
				onApply={() => {}}
				onDiscard={() => {}}
			/>,
		);

		expect(markup.split(repeatedNote)).toHaveLength(2);
	});

	test("renders a repeated validation error only once", () => {
		const repeatedError = "Repeated validation error";
		const markup = renderToStaticMarkup(
			<AiPlanReview
				plan={null}
				errors={[repeatedError, repeatedError]}
				onApply={() => {}}
				onDiscard={() => {}}
			/>,
		);

		expect(markup.split(repeatedError)).toHaveLength(2);
	});
});
