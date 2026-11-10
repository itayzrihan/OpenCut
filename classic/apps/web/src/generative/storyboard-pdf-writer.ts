/** Minimal binary PDF image-page container. Rendering/bidi is delegated to Canvas.
 * No HTML, scripts, remote resources, annotations or arbitrary PDF syntax. */
export const STORYBOARD_PDF_MAX_BYTES = 15 * 1024 * 1024;
export const STORYBOARD_PDF_MAX_PAGES = 120;
export interface PdfJpegPage {
	bytes: Uint8Array;
	width: number;
	height: number;
}
export function encodeStoryboardPdf(pages: PdfJpegPage[]): Uint8Array {
	if (!pages.length || pages.length > STORYBOARD_PDF_MAX_PAGES)
		throw new Error("Storyboard PDF must contain between 1 and 120 pages");
	const chunks: Uint8Array[] = [];
	const offsets = [0];
	let length = 0;
	const append = (value: string | Uint8Array) => {
		const bytes =
			typeof value === "string" ? new TextEncoder().encode(value) : value;
		length += bytes.length;
		if (length > STORYBOARD_PDF_MAX_BYTES)
			throw new Error(
				"Storyboard PDF exceeds 15 MiB; use smaller reference images or fewer scenes",
			);
		chunks.push(bytes);
	};
	const begin = (id: number) => {
		offsets[id] = length;
		append(`${id} 0 obj\n`);
	};
	append("%PDF-1.4\n");
	append(new Uint8Array([37, 226, 227, 207, 211, 10]));
	begin(1);
	append("<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
	begin(2);
	append(
		`<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ")}] >>\nendobj\n`,
	);
	for (const [index, page] of pages.entries()) {
		if (
			!Number.isInteger(page.width) ||
			!Number.isInteger(page.height) ||
			page.width < 1 ||
			page.height < 1 ||
			page.width > 4096 ||
			page.height > 4096 ||
			page.bytes[0] !== 255 ||
			page.bytes[1] !== 216 ||
			page.bytes[2] !== 255
		)
			throw new Error("Invalid storyboard JPEG page");
		const id = 3 + index * 3;
		begin(id);
		append(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /PageImage ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>\nendobj\n`,
		);
		begin(id + 1);
		append(
			`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`,
		);
		append(page.bytes);
		append("\nendstream\nendobj\n");
		const content = "q\n595.28 0 0 841.89 0 0 cm\n/PageImage Do\nQ\n";
		begin(id + 2);
		append(
			`<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`,
		);
	}
	const xref = length;
	append(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
	for (const offset of offsets.slice(1))
		append(`${String(offset).padStart(10, "0")} 00000 n \n`);
	append(
		`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
	);
	const output = new Uint8Array(length);
	let position = 0;
	for (const chunk of chunks) {
		output.set(chunk, position);
		position += chunk.length;
	}
	return output;
}
