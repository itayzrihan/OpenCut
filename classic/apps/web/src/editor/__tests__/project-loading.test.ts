import { describe, expect, mock, test } from "bun:test";
import { createReplacementProjectIfMissing } from "@/editor/project-loading";

describe("createReplacementProjectIfMissing", () => {
	test("creates a replacement route target for a stale project id", async () => {
		const createProject = mock(async () => "replacement-project");

		const replacementId = await createReplacementProjectIfMissing({
			projectExists: false,
			createProject,
		});

		expect(replacementId).toBe("replacement-project");
		expect(createProject).toHaveBeenCalledTimes(1);
	});

	test("keeps an existing project without creating another one", async () => {
		const createProject = mock(async () => "unused-project");

		const replacementId = await createReplacementProjectIfMissing({
			projectExists: true,
			createProject,
		});

		expect(replacementId).toBeNull();
		expect(createProject).not.toHaveBeenCalled();
	});
});
