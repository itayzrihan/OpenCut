import { test, expect } from "bun:test";
import { readByteRange } from "../http-range";
test("private media supports seeking, suffixes and bounded HTTP ranges", () => {
	expect(readByteRange({ header: null, size: 100 })).toBeNull();
	expect(readByteRange({ header: "bytes=20-39", size: 100 })).toEqual({ invalid: false, start: 20, end: 39 });
	expect(readByteRange({ header: "bytes=-20", size: 100 })).toEqual({ invalid: false, start: 80, end: 99 });
	expect(readByteRange({ header: "bytes=80-", size: 100 })).toEqual({ invalid: false, start: 80, end: 99 });
	expect(readByteRange({ header: "bytes=0-200", size: 100 })).toEqual({ invalid: false, start: 0, end: 99 });
	for (const range of ["bytes=100-", "bytes=-0", "bytes=4-3", "bytes=-", "bytes=0-2,4-8", "bytes=9007199254740992-"]) expect(readByteRange({ header: range, size: 100 })).toEqual({ invalid: true });
});
