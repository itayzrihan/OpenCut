import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	assetKey,
	exchangeSchema,
	hashExchangeFile,
	parseProjectXml,
	serializeProjectXml,
	suggestExchangeFiles,
	verifyExchangeFile,
	type ExchangeAsset,
	type ProjectExchange,
} from "./exchange-format";

const asset: ExchangeAsset = {
	kind: "media",
	id: "camera-1",
	name: "Camera",
	fileName: "camera.mp4",
	mimeType: "video/mp4",
	size: 3,
	lastModified: 123,
	metadata: {},
};
const fixture = (): ProjectExchange => ({
	schema: "pocut.project.exchange",
	version: 1,
	projectId: "qa-source",
	projectName: "XML QA",
	exportedAt: "2026-11-10T00:00:00Z",
	archive: {
		notes: ['עברית & العربية <cut> "quoted" &lt; >', "\u0000\nnext line"],
		futureSupportedMetadata: { timing: 0.125, versions: [1, 2] },
	},
	assets: [asset],
});

describe("portable project XML", () => {
	test("round-trips multilingual notes, literal XML and supported metadata without double decoding", () => {
		const project = fixture();
		const xml = serializeProjectXml(project);
		expect(xml).toContain("&amp;lt;");
		expect(xml).not.toContain("<cut>");
		expect(parseProjectXml(xml)).toEqual(project);
	});

	test("rejects external entities, processing instructions, unknown entities and foreign formats", () => {
		const xml = serializeProjectXml(fixture());
		for (const candidate of [
			'<!DOCTYPE x [<!ENTITY external SYSTEM "file:///private/secret">]>' + xml,
			'<?xml-stylesheet href="https://example.invalid/remote"?>' + xml,
			xml.replace("XML QA", "&external;"),
			xml.replace("XML QA", "&#65;"),
			xml.replace('version="1" format=', 'version="9" format='),
			"<premiere-project />",
		]) {
			expect(() => parseProjectXml(candidate)).toThrow();
		}
	});

	test("rejects duplicate identities and path-bearing asset IDs before import", () => {
		expect(() =>
			exchangeSchema.parse({ ...fixture(), assets: [asset, { ...asset }] }),
		).toThrow("Duplicate archive asset identity");
		for (const id of ["../other", "folder/file", "C:\\file", ".", "a\u0000b"]) {
			expect(() =>
				exchangeSchema.parse({ ...fixture(), assets: [{ ...asset, id }] }),
			).toThrow();
		}
	});

	test("keeps the public transcript while reporting omitted legacy binary transport fields", () => {
		const project = {
			...fixture(),
			conversation: {
				message: "Keep this caption and script",
				toolInput: { dataBase64: "aW1hZ2U=", label: "Reference A" },
			},
		};
		const xml = serializeProjectXml(project);
		expect(xml).not.toContain("aW1hZ2U=");
		const parsed = parseProjectXml(xml);
		expect(parsed.omittedBinaryFields).toContain("dataBase64");
		expect(parsed.conversation).toEqual({
			message: "Keep this caption and script",
			toolInput: {
				dataBase64: "[binary media omitted from metadata XML]",
				label: "Reference A",
			},
		});
	});
});

describe("explicit original file relinking", () => {
	test("leaves duplicate filename/size matches unresolved and verifies actual bytes", async () => {
		const good = new File(["abc"], asset.fileName);
		const wrong = new File(["xyz"], asset.fileName);
		const fingerprint = {
			...asset,
			sha256: createHash("sha256").update("abc").digest("hex"),
		};
		expect(suggestExchangeFiles([fingerprint], [good, wrong]).size).toBe(0);
		expect(
			suggestExchangeFiles([fingerprint], [good]).get(assetKey(asset)),
		).toBe(good);
		await verifyExchangeFile(fingerprint, good);
		await expect(verifyExchangeFile(fingerprint, wrong)).rejects.toThrow(
			"SHA-256",
		);
		await expect(
			verifyExchangeFile(fingerprint, new File(["abcd"], asset.fileName)),
		).rejects.toThrow("different size");
	});

	test("hashes streams without whole-file buffers and obeys cancellation", async () => {
		class StreamingBlob extends Blob {
			override arrayBuffer(): Promise<ArrayBuffer> {
				throw new Error("Do not buffer the whole original file");
			}
		}
		const bytes = new Uint8Array(2 * 1024 * 1024).fill(29);
		expect(await hashExchangeFile(new StreamingBlob([bytes]))).toBe(
			createHash("sha256").update(bytes).digest("hex"),
		);
		const controller = new AbortController();
		controller.abort();
		await expect(
			hashExchangeFile(new Blob([bytes]), controller.signal),
		).rejects.toThrow();
	});
});
