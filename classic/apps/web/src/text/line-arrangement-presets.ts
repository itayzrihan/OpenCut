import { useSyncExternalStore } from "react";

export interface TextLineArrangementPreset {
	id: string;
	name: string;
	lines: Array<{
		x: number;
		y: number;
	}>;
	createdAt: string;
}

const STORAGE_KEY = "text-line-arrangement-presets";
const listeners = new Set<() => void>();
let snapshot: TextLineArrangementPreset[] = readFromStorage();

function isPreset(value: unknown): value is TextLineArrangementPreset {
	if (!value || typeof value !== "object") return false;
	const candidate = value as TextLineArrangementPreset;
	return (
		typeof candidate.id === "string" &&
		typeof candidate.name === "string" &&
		typeof candidate.createdAt === "string" &&
		Array.isArray(candidate.lines) &&
		candidate.lines.every(
			(line) =>
				typeof line?.x === "number" &&
				Number.isFinite(line.x) &&
				typeof line.y === "number" &&
				Number.isFinite(line.y),
		)
	);
}

function sortPresets(presets: TextLineArrangementPreset[]) {
	return [...presets].sort(
		(left, right) =>
			left.lines.length - right.lines.length ||
			left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
	);
}

function readFromStorage(): TextLineArrangementPreset[] {
	if (typeof window === "undefined") return [];
	try {
		const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return sortPresets(parsed.filter(isPreset));
	} catch {
		return [];
	}
}

function writeToStorage(presets: TextLineArrangementPreset[]) {
	snapshot = sortPresets(presets);
	if (typeof window !== "undefined") {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
	}
	listeners.forEach((listener) => listener());
}

export function useTextLineArrangementPresets() {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => snapshot,
		() => [],
	);
}

export function saveTextLineArrangementPreset({
	name,
	lines,
}: {
	name: string;
	lines: TextLineArrangementPreset["lines"];
}) {
	const trimmedName = name.trim();
	if (!trimmedName || lines.length === 0) return;
	const preset: TextLineArrangementPreset = {
		id: `text-line-arrangement-${Date.now()}`,
		name: trimmedName,
		lines: lines.map((line) => ({
			x: Math.round(line.x * 100) / 100,
			y: Math.round(line.y * 100) / 100,
		})),
		createdAt: new Date().toISOString(),
	};
	writeToStorage([...snapshot, preset]);
}

export function removeTextLineArrangementPreset({ id }: { id: string }) {
	writeToStorage(snapshot.filter((preset) => preset.id !== id));
}
