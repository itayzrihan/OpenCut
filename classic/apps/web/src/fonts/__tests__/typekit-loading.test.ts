import { mockFetch } from "@/test-support/mock-fetch";
import { expect, spyOn, test } from "bun:test";
import { loadTypekitFonts } from "@/fonts/typekit-fonts";

test("a stalled font provider settles and a later request can recover", async () => {
	const timeout = AbortSignal.timeout.bind(AbortSignal);
	const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(() =>
		timeout(10),
	);
	const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(mockFetch(
		(_input, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(init.signal?.reason),
				);
			}),
	));
	try {
		expect(await loadTypekitFonts()).toEqual([]);
		expect(timeoutSpy).toHaveBeenCalledWith(8_000);
		fetchSpy.mockResolvedValue(
			new Response(
				'@font-face { font-family: "recovered"; font-weight: 400; }',
			),
		);
		expect((await loadTypekitFonts())[0]?.family).toBe("recovered");
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	} finally {
		fetchSpy.mockRestore();
		timeoutSpy.mockRestore();
	}
});
