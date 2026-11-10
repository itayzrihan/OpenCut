/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Minimal synthetic browser host. */
import type { EditorCore } from "@/core";
import { performStoryboardPdfEffect } from "./storyboard-pdf-effect";

export async function runPdfFixture(
	mode: "success" | "account" | "revision" | "cancel",
) {
	window.__opencutAccountId = "fixture-account";
	const controller = new AbortController();
	let revision = 7;
	let stored = 0;
	let download: Blob | undefined;
	const reference = {
		id: "a".repeat(32),
		name: "synthetic.png",
		kind: "image",
		mime: "image/png",
		bytes: 1,
		storyboard: true,
	};
	const description =
		"בכל סצנה נראה את הדרך מהרעיון אל הסרט: נפתח במבט רחב על הבית, נתקרב לאנשים ונציג את התוצאה. המעבר שומר על רצף ברור ומעניק לצופה זמן להבין את הסיפור. POCUT מציג תכנון מדויק ללקוח, עם תנועה עדינה וקצב נעים. ";
	const plan = {
		projectId: "fixture-project",
		revision: 7,
		title: "הסיפור שלנו מתחיל כאן",
		summary:
			"הצעה יצירתית לסרט קצר שמחבר בין אנשים, מקומות ורגעים.\nA client-ready storyboard proposal with complete scene images and clear descriptions.",
		sheets: [reference],
		scenes: [
			{
				id: "one",
				title: "פותחים את הדלת",
				description,
				startSeconds: 0,
				endSeconds: 4,
				imageReferenceId: reference.id,
			},
			{
				id: "two",
				title: "מה אנחנו מתכננים לצלם?",
				description: description.repeat(18),
				startSeconds: 4,
				endSeconds: 8,
				imageReferenceId: null,
			},
		],
		sceneImages: [reference],
		digest: "b".repeat(64),
	};
	const editor = {
		project: {
			getActiveOrNull: () => ({ metadata: { id: "fixture-project" } }),
		},
		command: {
			getCanonicalRevision: () => revision,
			storeCanonicalStoryboardPdf: () => {
				stored++;
				return { id: "pdf-artifact" };
			},
		},
	} as unknown as EditorCore;
	const originalFetch = window.fetch;
	window.fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
		const response = await originalFetch(...args);
		if (String(args[0]).startsWith("/api/generative")) {
			if (mode === "account") window.__opencutAccountId = "different-account";
			if (mode === "revision") revision++;
			if (mode === "cancel") controller.abort();
		}
		return response;
	}, originalFetch);
	try {
		const result = await performStoryboardPdfEffect({
			effect: {
				id: 1,
				adapter: "storyboardPdf",
				projectId: "fixture-project",
				request: { plan },
			},
			editor,
			accountId: "fixture-account",
			signal: controller.signal,
			onExport: (value) => {
				download = value.blob;
			},
		});
		const bytes = download
			? new Uint8Array(await download.arrayBuffer())
			: new Uint8Array();
		let binary = "";
		for (let offset = 0; offset < bytes.length; offset += 16384)
			binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
		return { result, stored, pdfBase64: btoa(binary) };
	} finally {
		window.fetch = originalFetch;
	}
}
