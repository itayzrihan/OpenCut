import { expect, test, afterEach } from "bun:test";
import { useDirectorReviewFocus } from "./review-focus";
afterEach(() => useDirectorReviewFocus.getState().clear());
test("paid review focus routes explicitly and each new request clears prior batch metadata", () => {
	const store = useDirectorReviewFocus.getState();
	store.reveal({
		accountId: "a",
		projectId: "p",
		jobId: "j",
		batchId: "batch",
		surface: "agent",
	});
	expect(useDirectorReviewFocus.getState()).toMatchObject({
		surface: "agent",
		batchId: "batch",
	});
	store.reveal({ accountId: "a", projectId: "p", jobId: "k" });
	expect(useDirectorReviewFocus.getState()).toMatchObject({
		surface: "director",
		batchId: undefined,
		jobId: "k",
	});
	store.clear();
	expect(useDirectorReviewFocus.getState()).toMatchObject({
		surface: "director",
		jobId: "",
		batchId: undefined,
	});
});
