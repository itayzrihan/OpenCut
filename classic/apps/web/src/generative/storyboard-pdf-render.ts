import type {
	StoryboardPdfImage,
	StoryboardPdfPlan,
} from "./storyboard-pdf-plan";
import {
	encodeStoryboardPdf,
	STORYBOARD_PDF_MAX_BYTES,
	STORYBOARD_PDF_MAX_PAGES,
	type PdfJpegPage,
} from "./storyboard-pdf-writer";
export const PDF_PAGE_WIDTH = 1600;
export const PDF_PAGE_HEIGHT = 2263;
const MARGIN = 112;
const WIDTH = PDF_PAGE_WIDTH - MARGIN * 2;
const BOTTOM = PDF_PAGE_HEIGHT - 160;
const INK = "#172b35";
const MUTED = "#526872";
const ACCENT = "#007e73";
export interface StoryboardCanvas {
	getContext(type: "2d"): CanvasRenderingContext2D | null;
	toBlob(callback: BlobCallback, type: string, quality: number): void;
}
export interface StoryboardImage {
	source: CanvasImageSource;
	width: number;
	height: number;
	close(): void;
}
/** Browser-native text shaping retains Hebrew/Arabic bidi and mixed-script text. */
export function textDirection(text: string): CanvasDirection {
	const first = /[\p{Letter}]/u.exec(text)?.[0] ?? "";
	return /[\u0590-\u08ff]/u.test(first) ? "rtl" : "ltr";
}
export function wrapCanvasText({
	ctx,
	text,
	width,
}: {
	ctx: {
		measureText(text: string): {
			width: number;
		};
	};
	text: string;
	width: number;
}): string[] {
	const lines: string[] = [];
	for (const paragraph of text.replaceAll("\r", "").split("\n")) {
		let line = "";
		for (const word of paragraph.split(/\s+/u).filter(Boolean)) {
			if (ctx.measureText(word).width > width) {
				if (line) {
					lines.push(line);
					line = "";
				}
				const segments =
					typeof Intl.Segmenter === "function"
						? Array.from(
								new Intl.Segmenter(undefined, {
									granularity: "grapheme",
								}).segment(word),
								(part) => part.segment,
							)
						: Array.from(word);
				for (const letter of segments) {
					if (line && ctx.measureText(line + letter).width > width) {
						lines.push(line);
						line = "";
					}
					line += letter;
				}
			} else if (line && ctx.measureText(`${line} ${word}`).width > width) {
				lines.push(line);
				line = word;
			} else line = line ? `${line} ${word}` : word;
		}
		lines.push(line);
	}
	return lines;
}
export async function renderStoryboardPdf({
	plan,
	signal,
	createCanvas,
	loadImage,
	fontFamily,
	onProgress = () => {},
}: {
	plan: StoryboardPdfPlan;
	signal: AbortSignal;
	createCanvas: () => StoryboardCanvas;
	loadImage: (image: StoryboardPdfImage) => Promise<StoryboardImage>;
	fontFamily: string;
	onProgress?: (pages: number) => void;
}): Promise<{
	bytes: Uint8Array;
	pageCount: number;
}> {
	const pages: PdfJpegPage[] = [];
	let imageBytes = 0;
	let canvas: StoryboardCanvas;
	let ctx!: CanvasRenderingContext2D;
	const font = (size: number) => {
		ctx.font = `${size}px "${fontFamily}", sans-serif`;
	};
	const text = ({
		value,
		y,
		size,
		color = INK,
		width = WIDTH,
		maxHeight,
	}: {
		value: string;
		y: number;
		size: number;
		color?: string;
		width?: number;
		maxHeight?: number;
	}): number => {
		font(size);
		while (
			maxHeight !== undefined &&
			size > 24 &&
			wrapCanvasText({ ctx, text: value, width }).length * size * 1.45 >
				maxHeight
		) {
			size -= 2;
			font(size);
		}
		ctx.fillStyle = color;
		ctx.direction = textDirection(value);
		ctx.textAlign = ctx.direction === "rtl" ? "right" : "left";
		for (const line of wrapCanvasText({
			ctx: ctx,
			text: value,
			width: width,
		})) {
			ctx.fillText(
				line,
				ctx.direction === "rtl" ? PDF_PAGE_WIDTH - MARGIN : MARGIN,
				y,
			);
			y += size * 1.45;
		}
		return y;
	};
	const start = (label: string) => {
		signal.throwIfAborted();
		if (pages.length >= STORYBOARD_PDF_MAX_PAGES)
			throw new Error(
				"Storyboard exceeds 120 PDF pages; shorten the proposal copy",
			);
		canvas = createCanvas();
		const context = canvas.getContext("2d");
		if (!context)
			throw new Error("This browser could not create the PDF canvas");
		ctx = context;
		ctx.fillStyle = "#ffffff";
		ctx.fillRect(0, 0, PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT);
		ctx.textBaseline = "top";
		ctx.fillStyle = ACCENT;
		ctx.fillRect(MARGIN, 91, 46, 8);
		text({
			value: "POCUT  /  STORYBOARD",
			y: 132,
			size: 23,
			color: ACCENT,
		});
		text({
			value: label,
			y: 190,
			size: 21,
			color: MUTED,
		});
		ctx.strokeStyle = "#d8e4e6";
		ctx.lineWidth = 2;
		ctx.beginPath();
		ctx.moveTo(MARGIN, PDF_PAGE_HEIGHT - 105);
		ctx.lineTo(PDF_PAGE_WIDTH - MARGIN, PDF_PAGE_HEIGHT - 105);
		ctx.stroke();
		text({
			value: "Creative proposal",
			y: PDF_PAGE_HEIGHT - 75,
			size: 19,
			color: MUTED,
		});
		ctx.textAlign = "right";
		ctx.direction = "ltr";
		font(19);
		ctx.fillText(
			String(pages.length + 1).padStart(2, "0"),
			PDF_PAGE_WIDTH - MARGIN,
			PDF_PAGE_HEIGHT - 75,
		);
	};
	const finish = async () => {
		signal.throwIfAborted();
		const blob = await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(value) =>
					value
						? resolve(value)
						: reject(new Error("Could not encode the PDF page")),
				"image/jpeg",
				0.91,
			),
		);
		signal.throwIfAborted();
		const bytes = new Uint8Array(await blob.arrayBuffer());
		imageBytes += bytes.length;
		if (imageBytes > STORYBOARD_PDF_MAX_BYTES - 100000)
			throw new Error(
				"Storyboard PDF exceeds 15 MiB; reduce the number of pages",
			);
		pages.push({ bytes, width: PDF_PAGE_WIDTH, height: PDF_PAGE_HEIGHT });
		onProgress(pages.length);
		// Yield between pages for cancellation and responsive browser controls.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	};
	const paintImage = async ({
		image,
		y,
		height,
	}: {
		image: StoryboardPdfImage;
		y: number;
		height: number;
	}) => {
		const decoded = await loadImage(image);
		try {
			signal.throwIfAborted();
			if (
				!decoded.width ||
				!decoded.height ||
				decoded.width * decoded.height > 24000000
			)
				throw new Error(
					"A storyboard image exceeds the safe browser decode size",
				);
			ctx.fillStyle = "#f2f6f6";
			ctx.fillRect(MARGIN, y, WIDTH, height);
			const scale = Math.min(WIDTH / decoded.width, height / decoded.height);
			const width = decoded.width * scale,
				scaledHeight = decoded.height * scale;
			ctx.drawImage(
				decoded.source,
				MARGIN + (WIDTH - width) / 2,
				y + (height - scaledHeight) / 2,
				width,
				scaledHeight,
			);
		} finally {
			decoded.close();
		}
	};
	const paragraphs = async ({
		value,
		initialY,
		continuation,
	}: {
		value: string;
		initialY: number;
		continuation: () => number;
	}) => {
		font(31);
		const lines = value
			.replaceAll("\r", "")
			.split("\n")
			.flatMap((paragraph) =>
				wrapCanvasText({
					ctx: ctx,
					text: paragraph,
					width: WIDTH,
				}).map((line) => ({
					line,
					direction: textDirection(paragraph),
				})),
			);
		let y = initialY;
		for (const { line, direction } of lines) {
			if (y + 45 > BOTTOM) {
				await finish();
				y = continuation();
			}
			font(31);
			ctx.direction = direction;
			ctx.textAlign = direction === "rtl" ? "right" : "left";
			ctx.fillStyle = INK;
			ctx.fillText(
				line,
				direction === "rtl" ? PDF_PAGE_WIDTH - MARGIN : MARGIN,
				y,
			);
			y += 45;
		}
	};
	start("CLIENT PROPOSAL");
	ctx.fillStyle = "#e3f3ef";
	ctx.fillRect(MARGIN, 310, WIDTH, 13);
	let y = text({
		value: plan.title,
		y: 405,
		size: 76,
		maxHeight: 600,
	});
	y =
		text({
			value: "The story we will bring to life",
			y: y + 55,
			size: 29,
			color: ACCENT,
		}) + 70;
	y =
		text({
			value: `${plan.scenes.length} planned scene${plan.scenes.length === 1 ? "" : "s"}  ·  ${plan.sheets.length} storyboard sheet${plan.sheets.length === 1 ? "" : "s"}`,
			y: y,
			size: 24,
			color: MUTED,
		}) + 55;
	if (plan.summary.trim())
		await paragraphs({
			value: plan.summary,
			initialY: y,
			continuation: () => {
				start("PROJECT OVERVIEW · CONTINUED");
				return (
					text({
						value: plan.title,
						y: 310,
						size: 48,
						maxHeight: 300,
					}) + 55
				);
			},
		});
	await finish();
	for (const [index, image] of plan.sheets.entries()) {
		start(`STORYBOARD SHEET ${String(index + 1).padStart(2, "0")}`);
		text({
			value: "Visual direction",
			y: 300,
			size: 49,
		});
		await paintImage({
			image: image,
			y: 430,
			height: 1580,
		});
		await finish();
	}
	for (const [index, scene] of plan.scenes.entries()) {
		const label = `SCENE ${String(index + 1).padStart(2, "0")}`;
		const heading = (continued = false) => {
			start(label + (continued ? " · CONTINUED" : ""));
			let top =
				text({
					value: scene.title,
					y: 300,
					size: 49,
					maxHeight: 300,
				}) + 24;
			if (scene.startSeconds !== null && scene.endSeconds !== null)
				top =
					text({
						value: `${scene.startSeconds.toLocaleString("en-US", { maximumFractionDigits: 2 })}–${scene.endSeconds.toLocaleString("en-US", { maximumFractionDigits: 2 })} sec`,
						y: top,
						size: 24,
						color: ACCENT,
					}) + 34;
			return top;
		};
		let top = heading();
		if (scene.imageReferenceId) {
			const image = plan.sceneImages.find(
				(image) => image.id === scene.imageReferenceId,
			);
			if (!image)
				throw new Error("Storyboard scene image is no longer available");
			await paintImage({
				image: image,
				y: top,
				height: 720,
			});
			top += 785;
		}
		await paragraphs({
			value: scene.description,
			initialY: top,
			continuation: () => heading(true),
		});
		await finish();
	}
	signal.throwIfAborted();
	return { bytes: encodeStoryboardPdf(pages), pageCount: pages.length };
}
