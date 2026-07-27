const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const DEFLATE_METHOD = 8;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const MAX_UINT32 = 0xffffffff;

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

function crc32(bytes: Uint8Array): number {
	let value = 0xffffffff;
	for (const byte of bytes) {
		value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
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

function ensureUint32Size({ size, label }: { size: number; label: string }): void {
	if (!Number.isInteger(size) || size < 0 || size > MAX_UINT32) {
		throw new Error(`${label} is too large for ZIP32`);
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

async function toBytes({
	data,
}: {
	data: ZipEntryInput["data"];
}): Promise<Uint8Array> {
	if (typeof data === "string") {
		return textEncoder.encode(data);
	}
	if (data instanceof Uint8Array) {
		return data;
	}
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	return new Uint8Array(await data.arrayBuffer());
}

function buildLocalHeader({
	nameBytes,
	contentBytes,
	entryCrc32,
	date,
}: {
	nameBytes: Uint8Array;
	contentBytes: Uint8Array;
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
	writeUint32({ view, offset: 18, value: contentBytes.byteLength });
	writeUint32({ view, offset: 22, value: contentBytes.byteLength });
	writeUint16({ view, offset: 26, value: nameBytes.byteLength });
	writeUint16({ view, offset: 28, value: 0 });
	return header;
}

function buildCentralDirectoryHeader({
	nameBytes,
	contentBytes,
	entryCrc32,
	date,
	localHeaderOffset,
}: {
	nameBytes: Uint8Array;
	contentBytes: Uint8Array;
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
	writeUint32({ view, offset: 20, value: contentBytes.byteLength });
	writeUint32({ view, offset: 24, value: contentBytes.byteLength });
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

	for (const entry of entries) {
		const path = normalizeZipPath({ path: entry.path });
		const nameBytes = textEncoder.encode(path);
		const contentBytes = await toBytes({ data: entry.data });
		const entryCrc32 = crc32(contentBytes);
		const localHeaderOffset = offset;
		const modifiedAt = entry.lastModified ?? new Date();

		ensureUint32Size({
			size: contentBytes.byteLength,
			label: `${path} size`,
		});
		ensureUint32Size({
			size: localHeaderOffset,
			label: `${path} local header offset`,
		});

		const localHeader = buildLocalHeader({
			nameBytes,
			contentBytes,
			entryCrc32,
			date: modifiedAt,
		});
		fileParts.push(
			toBlobPart(localHeader),
			toBlobPart(nameBytes),
			toBlobPart(contentBytes),
		);
		offset += localHeader.byteLength + nameBytes.byteLength + contentBytes.byteLength;

		const centralDirectoryHeader = buildCentralDirectoryHeader({
			nameBytes,
			contentBytes,
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

function findEndOfCentralDirectory({ bytes }: { bytes: Uint8Array }): number {
	const minOffset = Math.max(0, bytes.byteLength - 22 - 0xffff);
	for (let offset = bytes.byteLength - 22; offset >= minOffset; offset--) {
		if (
			bytes[offset] === 0x50 &&
			bytes[offset + 1] === 0x4b &&
			bytes[offset + 2] === 0x05 &&
			bytes[offset + 3] === 0x06
		) {
			return offset;
		}
	}
	throw new Error("Invalid ZIP archive: missing central directory");
}

async function inflateRaw({ data }: { data: Uint8Array }): Promise<Uint8Array> {
	const ctor = globalThis.DecompressionStream;
	if (!ctor) {
		throw new Error("Compressed ZIP entries are not supported in this browser");
	}

	const stream = new Blob([toBlobPart(data)]).stream().pipeThrough(
		new ctor("deflate-raw" as CompressionFormat),
	);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function readEntryName({
	bytes,
	offset,
	length,
}: {
	bytes: Uint8Array;
	offset: number;
	length: number;
}): string {
	return normalizeZipPath({
		path: textDecoder.decode(bytes.slice(offset, offset + length)),
	});
}

export async function readZipEntries({
	blob,
}: {
	blob: Blob;
}): Promise<Map<string, ZipEntry>> {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const eocdOffset = findEndOfCentralDirectory({ bytes });

	if (view.getUint32(eocdOffset, true) !== END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
		throw new Error("Invalid ZIP archive");
	}

	const diskNumber = view.getUint16(eocdOffset + 4, true);
	const centralDirectoryDisk = view.getUint16(eocdOffset + 6, true);
	if (diskNumber !== 0 || centralDirectoryDisk !== 0) {
		throw new Error("Multi-disk ZIP archives are not supported");
	}

	const entryCount = view.getUint16(eocdOffset + 10, true);
	const centralDirectoryOffset = view.getUint32(eocdOffset + 16, true);
	const result = new Map<string, ZipEntry>();
	let offset = centralDirectoryOffset;

	for (let i = 0; i < entryCount; i++) {
		if (
			view.getUint32(offset, true) !== CENTRAL_DIRECTORY_HEADER_SIGNATURE
		) {
			throw new Error("Invalid ZIP archive: corrupt central directory");
		}

		const method = view.getUint16(offset + 10, true);
		const entryCrc32 = view.getUint32(offset + 16, true);
		const compressedSize = view.getUint32(offset + 20, true);
		const uncompressedSize = view.getUint32(offset + 24, true);
		const nameLength = view.getUint16(offset + 28, true);
		const extraLength = view.getUint16(offset + 30, true);
		const commentLength = view.getUint16(offset + 32, true);
		const localHeaderOffset = view.getUint32(offset + 42, true);
		const path = readEntryName({
			bytes,
			offset: offset + 46,
			length: nameLength,
		});
		offset += 46 + nameLength + extraLength + commentLength;

		if (path.endsWith("/")) {
			continue;
		}

		if (
			view.getUint32(localHeaderOffset, true) !== LOCAL_FILE_HEADER_SIGNATURE
		) {
			throw new Error(`Invalid ZIP archive: missing local header for ${path}`);
		}

		const localNameLength = view.getUint16(localHeaderOffset + 26, true);
		const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
		const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
		const compressedData = bytes.slice(dataStart, dataStart + compressedSize);
		let data: Uint8Array;

		if (method === STORE_METHOD) {
			data = compressedData;
		} else if (method === DEFLATE_METHOD) {
			data = await inflateRaw({ data: compressedData });
		} else {
			throw new Error(`Unsupported ZIP compression method ${method} for ${path}`);
		}

		if (data.byteLength !== uncompressedSize) {
			throw new Error(`Invalid ZIP archive: wrong size for ${path}`);
		}

		if (crc32(data) !== entryCrc32) {
			throw new Error(`Invalid ZIP archive: checksum mismatch for ${path}`);
		}

		const entryBlob = new Blob([toBlobPart(data)]);
		result.set(path, {
			path,
			compressedSize,
			uncompressedSize,
			crc32: entryCrc32,
			method,
			blob: entryBlob,
			text: () => entryBlob.text(),
			json: async <T = unknown>() =>
				JSON.parse(await entryBlob.text()) as T,
		});
	}

	return result;
}
