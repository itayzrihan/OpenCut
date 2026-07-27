import { describe, expect, test } from "bun:test";
import {
	requestStoragePersistence,
	resolveInitialPersistenceReason,
} from "@/services/storage/use-storage-persistence";

describe("storage persistence prompting", () => {
	test("reports unavailable storage APIs", async () => {
		expect(
			await resolveInitialPersistenceReason({
				storage: undefined,
				browserIsFirefox: false,
			}),
		).toBe("error");
		expect(
			await resolveInitialPersistenceReason({
				storage: {},
				browserIsFirefox: false,
			}),
		).toBe("error");
		expect(await requestStoragePersistence(undefined)).toBe("error");
	});

	test("does not prompt or request again when storage is already persisted", async () => {
		let requestCount = 0;
		const reason = await resolveInitialPersistenceReason({
			storage: {
				persisted: async () => true,
				persist: async () => {
					requestCount += 1;
					return true;
				},
			},
			browserIsFirefox: false,
		});

		expect(reason).toBeNull();
		expect(requestCount).toBe(0);
	});

	test("lets Firefox explain the request before opening its permission prompt", async () => {
		let requestCount = 0;
		const reason = await resolveInitialPersistenceReason({
			storage: {
				persisted: async () => false,
				persist: async () => {
					requestCount += 1;
					return true;
				},
			},
			browserIsFirefox: true,
		});

		expect(reason).toBe("request");
		expect(requestCount).toBe(0);
	});

	test("surfaces automatic request denial and errors", async () => {
		expect(
			await resolveInitialPersistenceReason({
				storage: {
					persisted: async () => false,
					persist: async () => false,
				},
				browserIsFirefox: false,
			}),
		).toBe("denied");

		expect(
			await resolveInitialPersistenceReason({
				storage: {
					persisted: async () => {
						throw new Error("blocked");
					},
					persist: async () => true,
				},
				browserIsFirefox: false,
			}),
		).toBe("error");
	});

	test("keeps the dialog actionable until a retry is granted", async () => {
		expect(
			await requestStoragePersistence({ persist: async () => false }),
		).toBe("denied");
		expect(
			await requestStoragePersistence({
				persist: async () => {
					throw new Error("blocked");
				},
			}),
		).toBe("error");
		expect(
			await requestStoragePersistence({ persist: async () => true }),
		).toBeNull();
	});
});
