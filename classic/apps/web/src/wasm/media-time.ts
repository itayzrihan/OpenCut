import type { FrameRate, TimeCodeFormat } from "opencut-wasm";

const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_MINUTE = 60;
const CENTISECONDS_PER_SECOND = 100;
const TICKS_PER_CENTISECOND = 1_200;

/**
 * Integer-tick time. Mirrors `MediaTime(i64)` in `rust/crates/time/src/media_time.rs`.
 *
 * `opencut-wasm` exposes `MediaTime` as a bare `number` alias because tsify
 * collapses tuple structs. The brand here is the TS-side discipline that
 * recovers the invariant: a `MediaTime` is an integer count of ticks, and the
 * only legal way to construct one from a fractional `number` is `roundMediaTime`
 * (or `mediaTimeFromSeconds`, which rounds inside the wasm boundary).
 *
 * Reading is free — `MediaTime` is assignable to `number`. Writing is gated —
 * a bare `number` is not assignable to `MediaTime`.
 */
export type MediaTime = number & { readonly __mediaTime: unique symbol };

export const TICKS_PER_SECOND = 120_000;

function isMediaTime(value: number): value is MediaTime {
	return Number.isInteger(value);
}

function requireMediaTime({
	value,
	context,
}: {
	value: number;
	context: string;
}): MediaTime {
	if (!isMediaTime(value)) {
		throw new Error(`${context}: expected an integer tick count, got ${value}`);
	}
	return value;
}

export const ZERO_MEDIA_TIME = requireMediaTime({
	value: 0,
	context: "ZERO_MEDIA_TIME",
});

/**
 * Construct a `MediaTime` from a known-integer tick count. Use `roundMediaTime`
 * when the input may be fractional.
 */
export function mediaTime({ ticks }: { ticks: number }): MediaTime {
	return requireMediaTime({
		value: ticks,
		context: "mediaTime()",
	});
}

/**
 * Project a fractional value onto the integer-tick lattice.
 *
 * Rounds half away from zero (`-1.5 → -2`, `1.5 → 2`) and normalises `-0` to
 * `0`. The away-from-zero rule matches Rust's `.round()` and avoids the
 * `Math.round(-0.5) === -0` quirk that propagates `-0` into stored data.
 */
export function roundMediaTime({ time }: { time: number }): MediaTime {
	const roundedMagnitude = Math.round(Math.abs(time));
	if (roundedMagnitude === 0) {
		return ZERO_MEDIA_TIME;
	}
	return requireMediaTime({
		value: time < 0 ? -roundedMagnitude : roundedMagnitude,
		context: "roundMediaTime()",
	});
}

export function mediaTimeFromSeconds({
	seconds,
}: {
	seconds: number;
}): MediaTime {
	if (!Number.isFinite(seconds)) {
		throw new Error(
			`mediaTimeFromSeconds: expected a finite second value, got ${seconds}`,
		);
	}

	return roundMediaTime({ time: seconds * TICKS_PER_SECOND });
}

export function mediaTimeToSeconds({ time }: { time: MediaTime }): number {
	return time / TICKS_PER_SECOND;
}

/**
 * Sum `MediaTime` values. Inputs are integer ticks, so the sum is integer too.
 */
export function addMediaTime({
	a,
	b,
}: {
	a: MediaTime;
	b: MediaTime;
}): MediaTime {
	return requireMediaTime({
		value: a + b,
		context: "addMediaTime()",
	});
}

export function subMediaTime({
	a,
	b,
}: {
	a: MediaTime;
	b: MediaTime;
}): MediaTime {
	return requireMediaTime({
		value: a - b,
		context: "subMediaTime()",
	});
}

export function maxMediaTime({
	a,
	b,
}: {
	a: MediaTime;
	b: MediaTime;
}): MediaTime {
	return a > b ? a : b;
}

export function minMediaTime({
	a,
	b,
}: {
	a: MediaTime;
	b: MediaTime;
}): MediaTime {
	return a < b ? a : b;
}

export function clampMediaTime({
	time,
	min,
	max,
}: {
	time: MediaTime;
	min: MediaTime;
	max: MediaTime;
}): MediaTime {
	if (time < min) return min;
	if (time > max) return max;
	return time;
}

function ticksPerFrame(fps: FrameRate): number | null {
	const { numerator, denominator } = fps;

	if (
		!Number.isInteger(numerator) ||
		!Number.isInteger(denominator) ||
		numerator <= 0 ||
		denominator <= 0
	) {
		return null;
	}

	const tickNumerator = TICKS_PER_SECOND * denominator;
	if (tickNumerator % numerator !== 0) {
		return null;
	}

	return tickNumerator / numerator;
}

function toFrameRound({ time, fps }: { time: number; fps: FrameRate }) {
	const frameTicks = ticksPerFrame(fps);
	if (frameTicks == null) {
		return null;
	}

	const floor = Math.floor(time / frameTicks);
	const remainder = time - floor * frameTicks;
	return remainder * 2 >= frameTicks ? floor + 1 : floor;
}

function toFrameFloor({ time, fps }: { time: number; fps: FrameRate }) {
	const frameTicks = ticksPerFrame(fps);
	if (frameTicks == null) {
		return null;
	}

	return Math.floor(time / frameTicks);
}

function frameNumberUpperBound(fps: FrameRate): number | null {
	const { numerator, denominator } = fps;

	if (
		!Number.isInteger(numerator) ||
		!Number.isInteger(denominator) ||
		numerator <= 0 ||
		denominator <= 0
	) {
		return null;
	}

	return Math.ceil(numerator / denominator);
}

export function roundFrameTime({
	time,
	fps,
}: {
	time: MediaTime;
	fps: FrameRate;
}): MediaTime {
	const frame = toFrameRound({ time, fps });
	const frameTicks = ticksPerFrame(fps);
	if (frame == null || frameTicks == null) {
		return time;
	}

	return mediaTime({ ticks: frame * frameTicks });
}

export function roundFrameTicks({
	ticks,
	fps,
}: {
	ticks: number;
	fps: FrameRate;
}): number {
	const frame = toFrameRound({ time: ticks, fps });
	const frameTicks = ticksPerFrame(fps);
	if (frame == null || frameTicks == null) {
		return ticks;
	}

	return frame * frameTicks;
}

export function snapSeekMediaTime({
	time,
	duration,
	fps,
}: {
	time: MediaTime;
	duration: MediaTime;
	fps: FrameRate;
}): MediaTime {
	return clampMediaTime({
		time: roundFrameTime({ time, fps }),
		min: ZERO_MEDIA_TIME,
		max: duration,
	});
}

export function lastFrameMediaTime({
	duration,
	fps,
}: {
	duration: MediaTime;
	fps: FrameRate;
}): MediaTime {
	if (duration <= ZERO_MEDIA_TIME) {
		return ZERO_MEDIA_TIME;
	}

	const frame = toFrameFloor({ time: duration - 1, fps });
	const frameTicks = ticksPerFrame(fps);
	if (frame == null || frameTicks == null) {
		return duration;
	}

	return mediaTime({ ticks: frame * frameTicks });
}

export function parseMediaTimecode({
	timeCode,
	format,
	fps,
}: {
	timeCode: string;
	format: TimeCodeFormat;
	fps: FrameRate;
}): MediaTime | null {
	if (timeCode.trim().length === 0) {
		return null;
	}

	const parts = timeCode
		.trim()
		.split(":")
		.map((part) => {
			if (!/^\d+$/.test(part)) {
				return null;
			}

			const value = Number(part);
			return Number.isSafeInteger(value) ? value : null;
		});

	if (parts.some((part) => part == null)) {
		return null;
	}

	const readPart = ({ index }: { index: number }): number | null => {
		const part = parts[index];
		return typeof part === "number" ? part : null;
	};

	switch (format) {
		case "MM:SS": {
			const minutes = readPart({ index: 0 });
			const seconds = readPart({ index: 1 });
			if (
				parts.length !== 2 ||
				minutes == null ||
				seconds == null ||
				seconds >= SECONDS_PER_MINUTE
			) {
				return null;
			}

			return mediaTime({
				ticks: (minutes * SECONDS_PER_MINUTE + seconds) * TICKS_PER_SECOND,
			});
		}
		case "HH:MM:SS": {
			const hours = readPart({ index: 0 });
			const minutes = readPart({ index: 1 });
			const seconds = readPart({ index: 2 });
			if (
				parts.length !== 3 ||
				hours == null ||
				minutes == null ||
				seconds == null ||
				minutes >= SECONDS_PER_MINUTE ||
				seconds >= SECONDS_PER_MINUTE
			) {
				return null;
			}

			return mediaTime({
				ticks:
					(hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds) *
					TICKS_PER_SECOND,
			});
		}
		case "HH:MM:SS:CS": {
			const hours = readPart({ index: 0 });
			const minutes = readPart({ index: 1 });
			const seconds = readPart({ index: 2 });
			const centiseconds = readPart({ index: 3 });
			if (
				parts.length !== 4 ||
				hours == null ||
				minutes == null ||
				seconds == null ||
				centiseconds == null ||
				minutes >= SECONDS_PER_MINUTE ||
				seconds >= SECONDS_PER_MINUTE ||
				centiseconds >= CENTISECONDS_PER_SECOND
			) {
				return null;
			}

			return mediaTime({
				ticks:
					(hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds) *
						TICKS_PER_SECOND +
					centiseconds * TICKS_PER_CENTISECOND,
			});
		}
		case "HH:MM:SS:FF": {
			const hours = readPart({ index: 0 });
			const minutes = readPart({ index: 1 });
			const seconds = readPart({ index: 2 });
			const frames = readPart({ index: 3 });
			const frameUpperBound = frameNumberUpperBound(fps);
			const frameTicks = ticksPerFrame(fps);
			if (
				parts.length !== 4 ||
				hours == null ||
				minutes == null ||
				seconds == null ||
				frames == null ||
				frameUpperBound == null ||
				frameTicks == null ||
				minutes >= SECONDS_PER_MINUTE ||
				seconds >= SECONDS_PER_MINUTE ||
				frames >= frameUpperBound
			) {
				return null;
			}

			return mediaTime({
				ticks:
					(hours * SECONDS_PER_HOUR + minutes * SECONDS_PER_MINUTE + seconds) *
						TICKS_PER_SECOND +
					frames * frameTicks,
			});
		}
	}
}
