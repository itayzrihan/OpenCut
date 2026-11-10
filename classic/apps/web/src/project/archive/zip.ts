const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const DEFLATE_METHOD = 8;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const MAX_UINT32 = 0xffffffff;
const MAX_DIRECTORY_BYTES = 16 * 1024 * 1024;
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 20_001;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface ZipEntryInput {
	path: string;
	data: Blob | ArrayBuffer | Uint8Array | string;
	lastModified?: Date;
}

export interface ZipEntry {
	path: string;
	compressedSize: number;
	uncompressedSize: number;
	crc32: number;
	method: number;
	blob: Blob;
	text: () => Promise<string>;
	json: <T = unknown>() => Promise<T>;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < table.length; i++) {
		let value = i;
		for (let bit = 0; bit < 8; bit++) {
			value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[i] = value >>> 0;
	}
	return table;
})();

function boundedBlobStream(blob: Blob): ReadableStream<Uint8Array<ArrayBuffer>> {
	let offset = 0;
	return new ReadableStream({
		async pull(controller) {
			if (offset >= blob.size) {
				controller.close();
				return;
			}
			const end = Math.min(blob.size, offset + 1024 * 1024);
			controller.enqueue(
				new Uint8Array(await blob.slice(offset, end).arrayBuffer()),
			);
			offset = end;
		},
	});
}

async function crc32(blob: Blob): Promise<number> {
	let value = 0xffffffff;
	const reader = boundedBlobStream(blob).getReader();
	try {
		for (;;) {
			const { done, value: chunk } = await reader.read();
			if (done) break;
			for (const byte of chunk)
				value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	return (value ^ 0xffffffff) >>> 0;
}

function normalizeZipPath({ path }: { path: string }): string {
	const normalized = path.replaceAll("\\", "/").trim();
	if (!normalized || normalized.startsWith("/") || normalized.includes("\0")) {
		throw new Error(`Invalid ZIP path: ${path}`);
	}

	const parts = normalized.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) {
		throw new Error(`Invalid ZIP path: ${path}`);
	}

	return parts.join("/");
}

function ensureUint32Size({
	size,
	label,
}: {
	size: number;
	label: string;
}): void {
	if (!Number.isInteger(size) || size < 0 || size > MAX_UINT32) {
		throw new Error(
			`${label} is too large for ZIP32; use metadata XML and relink the original files`,
		);
	}
}

function writeUint16({
	view,
	offset,
	value,
}: {
	view: DataView;
	offset: number;
	value: number;
}): void {
	view.setUint16(offset, value, true);
}

function writeUint32({
	view,
	offset,
	value,
}: {
	view: DataView;
	offset: number;
	value: number;
}): void {
	view.setUint32(offset, value >>> 0, true);
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

function getDosDateTime({ date }: { date: Date }): {
	time: number;
	date: number;
} {
	const year = Math.max(1980, date.getFullYear());
	const month = date.getMonth() + 1;
	const day = date.getDate();
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const seconds = Math.floor(date.getSeconds() / 2);

	return {
		time: (hours << 11) | (minutes << 5) | seconds,
		date: ((year - 1980) << 9) | (month << 5) | day,
	};
}

function toBlob(data: ZipEntryInput["data"]): Blob {
	if (data instanceof Blob) return data;
	return new Blob([data instanceof Uint8Array ? toBlobPart(data) : data]);
}

function buildLocalHeader({
	nameBytes,
	contentSize,
	entryCrc32,
	date,
}: {
	nameBytes: Uint8Array;
	contentSize: number;
	entryCrc32: number;
	date: Date;
}): Uint8Array {
	const { time, date: dosDate } = getDosDateTime({ date });
	const header = new Uint8Array(30);
	const view = new DataView(header.buffer);
	writeUint32({ view, offset: 0, value: LOCAL_FILE_HEADER_SIGNATURE });
	writeUint16({ view, offset: 4, value: 20 });
	writeUint16({ view, offset: 6, value: UTF8_FLAG });
	writeUint16({ view, offset: 8, value: STORE_METHOD });
	writeUint16({ view, offset: 10, value: time });
	writeUint16({ view, offset: 12, value: dosDate });
	writeUint32({ view, offset: 14, value: entryCrc32 });
	writeUint32({ view, offset: 18, value: contentSize });
	writeUint32({ view, offset: 22, value: contentSize });
	writeUint16({ view, offset: 26, value: nameBytes.byteLength });
	writeUint16({ view, offset: 28, value: 0 });
	return header;
}

function buildCentralDirectoryHeader({
	nameBytes,
	contentSize,
	entryCrc32,
	date,
	localHeaderOffset,
}: {
	nameBytes: Uint8Array;
	contentSize: number;
	entryCrc32: number;
	date: Date;
	localHeaderOffset: number;
}): Uint8Array {
	const { time, date: dosDate } = getDosDateTime({ date });
	const header = new Uint8Array(46);
	const view = new DataView(header.buffer);
	writeUint32({ view, offset: 0, value: CENTRAL_DIRECTORY_HEADER_SIGNATURE });
	writeUint16({ view, offset: 4, value: 20 });
	writeUint16({ view, offset: 6, value: 20 });
	writeUint16({ view, offset: 8, value: UTF8_FLAG });
	writeUint16({ view, offset: 10, value: STORE_METHOD });
	writeUint16({ view, offset: 12, value: time });
	writeUint16({ view, offset: 14, value: dosDate });
	writeUint32({ view, offset: 16, value: entryCrc32 });
	writeUint32({ view, offset: 20, value: contentSize });
	writeUint32({ view, offset: 24, value: contentSize });
	writeUint16({ view, offset: 28, value: nameBytes.byteLength });
	writeUint16({ view, offset: 30, value: 0 });
	writeUint16({ view, offset: 32, value: 0 });
	writeUint16({ view, offset: 34, value: 0 });
	writeUint16({ view, offset: 36, value: 0 });
	writeUint32({ view, offset: 38, value: 0 });
	writeUint32({ view, offset: 42, value: localHeaderOffset });
	return header;
}

function buildEndOfCentralDirectory({
	entryCount,
	centralDirectorySize,
	centralDirectoryOffset,
}: {
	entryCount: number;
	centralDirectorySize: number;
	centralDirectoryOffset: number;
}): Uint8Array {
	if (entryCount > 0xffff) {
		throw new Error("Too many files for ZIP32");
	}

	const record = new Uint8Array(22);
	const view = new DataView(record.buffer);
	writeUint32({ view, offset: 0, value: END_OF_CENTRAL_DIRECTORY_SIGNATURE });
	writeUint16({ view, offset: 4, value: 0 });
	writeUint16({ view, offset: 6, value: 0 });
	writeUint16({ view, offset: 8, value: entryCount });
	writeUint16({ view, offset: 10, value: entryCount });
	writeUint32({ view, offset: 12, value: centralDirectorySize });
	writeUint32({ view, offset: 16, value: centralDirectoryOffset });
	writeUint16({ view, offset: 20, value: 0 });
	return record;
}

export async function createZipBlob({
	entries,
}: {
	entries: ZipEntryInput[];
}): Promise<Blob> {
	const fileParts: BlobPart[] = [];
	const centralDirectoryParts: BlobPart[] = [];
	let offset = 0;
	let centralDirectorySize = 0;
	const paths = new Set<string>();
	if (entries.length > MAX_ENTRIES)
		throw new Error("Too many archive files; use metadata XML");

	for (const entry of entries) {
		const path = normalizeZipPath({ path: entry.path });
		if (paths.has(path)) throw new Error("Duplicate ZIP path: " + path);
		paths.add(path);
		const nameBytes = textEncoder.encode(path);
		if (nameBytes.length > 0xffff) throw new Error("ZIP path is too long");
		const content = toBlob(entry.data);
		const contentSize = content.size;
		const localHeaderOffset = offset;
		const modifiedAt = entry.lastModified ?? new Date();

		ensureUint32Size({
			size: contentSize,
			label: `${path} size`,
		});
		ensureUint32Size({
			size: localHeaderOffset,
			label: `${path} local header offset`,
		});
		ensureUint32Size({
			size:
				offset +
				contentSize +
				30 +
				nameBytes.length +
				centralDirectorySize +
				46 +
				nameBytes.length +
				22,
			label: "Project archive",
		});
		const entryCrc32 = await crc32(content);

		const localHeader = buildLocalHeader({
			nameBytes,
			contentSize,
			entryCrc32,
			date: modifiedAt,
		});
		fileParts.push(toBlobPart(localHeader), toBlobPart(nameBytes), content);
		offset += localHeader.byteLength + nameBytes.byteLength + contentSize;

		const centralDirectoryHeader = buildCentralDirectoryHeader({
			nameBytes,
			contentSize,
			entryCrc32,
			date: modifiedAt,
			localHeaderOffset,
		});
		centralDirectoryParts.push(
			toBlobPart(centralDirectoryHeader),
			toBlobPart(nameBytes),
		);
		centralDirectorySize +=
			centralDirectoryHeader.byteLength + nameBytes.byteLength;
	}

	ensureUint32Size({
		size: offset,
		label: "Central directory offset",
	});
	ensureUint32Size({
		size: centralDirectorySize,
		label: "Central directory size",
	});

	if (centralDirectorySize > MAX_DIRECTORY_BYTES)
		throw new Error("ZIP directory exceeds its limit; use metadata XML");
	ensureUint32Size({
		size: offset + centralDirectorySize + 22,
		label: "Project archive",
	});
	const endRecord = buildEndOfCentralDirectory({
		entryCount: entries.length,
		centralDirectorySize,
		centralDirectoryOffset: offset,
	});

	return new Blob(
		[...fileParts, ...centralDirectoryParts, toBlobPart(endRecord)],
		{
			type: "application/zip",
		},
	);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let i = bytes.length - 22; i >= 0; i--) {
		if (
			view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE &&
			i + 22 + view.getUint16(i + 20, true) === bytes.length
		)
			return i;
	}
	throw new Error("Invalid ZIP archive: missing central directory");
}
async function inflateRaw({
	data,
	expected,
}: {
	data: Blob;
	expected: number;
}): Promise<Blob> {
	if (!globalThis.DecompressionStream)
		throw new Error("Compressed ZIP entries are not supported in this browser");
	const reader = boundedBlobStream(data)
		.pipeThrough(new DecompressionStream("deflate-raw" as CompressionFormat))
		.getReader();
	const chunks: BlobPart[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > expected || size > MAX_INFLATED_BYTES)
				throw new Error("ZIP inflated data exceeds its declared limit");
			chunks.push(toBlobPart(value));
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	if (size !== expected)
		throw new Error("Invalid ZIP archive: wrong inflated size");
	return new Blob(chunks);
}

/** STORE entries remain Blob slices; only bounded headers and compressed data are materialized. */
export async function readZipEntries({
	blob,
}: {
	blob: Blob;
}): Promise<Map<string, ZipEntry>> {
	if (blob.size < 22 || blob.size > MAX_UINT32)
		throw new Error(
			"Unsupported ZIP32 size; use metadata XML and relink the original files",
		);
	const tailStart = Math.max(0, blob.size - 22 - 0xffff);
	const tail = new Uint8Array(await blob.slice(tailStart).arrayBuffer());
	const end = findEndOfCentralDirectory(tail),
		endView = new DataView(tail.buffer, tail.byteOffset + end, 22);
	if (
		endView.getUint16(4, true) ||
		endView.getUint16(6, true) ||
		endView.getUint16(8, true) !== endView.getUint16(10, true)
	)
		throw new Error("Multi-disk ZIP archives are not supported");
	const count = endView.getUint16(10, true),
		directorySize = endView.getUint32(12, true),
		directoryOffset = endView.getUint32(16, true);
	if (
		count > MAX_ENTRIES ||
		directorySize > MAX_DIRECTORY_BYTES ||
		directoryOffset + directorySize !== tailStart + end
	)
		throw new Error("ZIP central directory exceeds its bounds");
	const directory = new Uint8Array(
		await blob
			.slice(directoryOffset, directoryOffset + directorySize)
			.arrayBuffer(),
	);
	const view = new DataView(
		directory.buffer,
		directory.byteOffset,
		directory.byteLength,
	);
	const result = new Map<string, ZipEntry>(),
		paths = new Set<string>();
	const ranges: Array<{ start: number; end: number }> = [];
	let offset = 0,
		inflated = 0;
	for (let i = 0; i < count; i++) {
		if (
			offset + 46 > directory.length ||
			view.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE
		)
			throw new Error("Invalid ZIP central directory");
		const flags = view.getUint16(offset + 8, true),
			method = view.getUint16(offset + 10, true),
			checksum = view.getUint32(offset + 16, true),
			compressedSize = view.getUint32(offset + 20, true),
			size = view.getUint32(offset + 24, true),
			nameLength = view.getUint16(offset + 28, true),
			extra = view.getUint16(offset + 30, true),
			comment = view.getUint16(offset + 32, true),
			localOffset = view.getUint32(offset + 42, true);
		if (
			flags & ~(UTF8_FLAG | 8) ||
			view.getUint16(offset + 34, true) ||
			![STORE_METHOD, DEFLATE_METHOD].includes(method)
		)
			throw new Error("Unsupported ZIP encryption, disk or compression method");
		if (
			!nameLength ||
			offset + 46 + nameLength + extra + comment > directory.length
		)
			throw new Error("Invalid ZIP directory entry bounds");
		const rawName = textDecoder.decode(
			directory.subarray(offset + 46, offset + 46 + nameLength),
		);
		const isDirectory = rawName.endsWith("/");
		const path = normalizeZipPath({
			path: isDirectory ? rawName.slice(0, -1) : rawName,
		});
		if (paths.has(path)) throw new Error("Duplicate ZIP path: " + path);
		paths.add(path);
		offset += 46 + nameLength + extra + comment;
		if (localOffset + 30 > directoryOffset)
			throw new Error("ZIP local header is outside its bounds");
		const local = new Uint8Array(
				await blob.slice(localOffset, localOffset + 30).arrayBuffer(),
			),
			localView = new DataView(local.buffer);
		if (
			localView.getUint32(0, true) !== LOCAL_FILE_HEADER_SIGNATURE ||
			localView.getUint16(6, true) !== flags ||
			localView.getUint16(8, true) !== method
		)
			throw new Error("ZIP local and central headers differ");
		const localName = localView.getUint16(26, true),
			localExtra = localView.getUint16(28, true),
			dataStart = localOffset + 30 + localName + localExtra;
		if (
			dataStart + compressedSize > directoryOffset ||
			dataStart > directoryOffset
		)
			throw new Error("ZIP entry data is outside its bounds");
		if (
			textDecoder.decode(
				await blob
					.slice(localOffset + 30, localOffset + 30 + localName)
					.arrayBuffer(),
			) !== rawName
		)
			throw new Error("ZIP entry paths differ between headers");
		if (
			!(flags & 8) &&
			(localView.getUint32(14, true) !== checksum ||
				localView.getUint32(18, true) !== compressedSize ||
				localView.getUint32(22, true) !== size)
		)
			throw new Error("ZIP entry sizes or checksums differ between headers");
		ranges.push({ start: localOffset, end: dataStart + compressedSize });
		if (isDirectory) {
			if (size || compressedSize)
				throw new Error("ZIP directory contains data");
			continue;
		}
		if (method === STORE_METHOD && size !== compressedSize)
			throw new Error("Invalid stored ZIP entry size");
		if (method === DEFLATE_METHOD) {
			inflated += size;
			if (inflated > MAX_INFLATED_BYTES)
				throw new Error(
					"Compressed ZIP expansion exceeds256MiB; use an uncompressed project ZIP or metadata XML",
				);
		}
		const raw = blob.slice(dataStart, dataStart + compressedSize);
		const content =
			method === STORE_METHOD
				? raw
				: await inflateRaw({ data: raw, expected: size });
		if ((await crc32(content)) !== checksum)
			throw new Error("Invalid ZIP archive: checksum mismatch for " + path);
		result.set(path, {
			path,
			compressedSize,
			uncompressedSize: size,
			crc32: checksum,
			method,
			blob: content,
			text: () => content.text(),
			json: async <T = unknown>() => JSON.parse(await content.text()) as T,
		});
	}
	if (offset !== directory.length)
		throw new Error("Unexpected ZIP directory data");
	ranges.sort((a, b) => a.start - b.start);
	for (let i = 1; i < ranges.length; i++)
		if (ranges[i]!.start < ranges[i - 1]!.end)
			throw new Error("ZIP entries overlap");
	return result;
}
