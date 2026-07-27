/**
 * UI state for the timeline
 * For core logic, use EditorCore instead.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	IDLE_TIMELINE_RANGE_SELECTION,
	normalizeTimelineRange,
	type TimelineRangeSelection,
} from "@/timeline/range-selection";
import type { MediaTime } from "@/wasm";

interface TimelineStore {
	snappingEnabled: boolean;
	toggleSnapping: () => void;
	rippleEditingEnabled: boolean;
	toggleRippleEditing: () => void;
	expandedElementIds: Set<string>;
	toggleElementExpanded: (elementId: string) => void;
	aiRangeSelection: TimelineRangeSelection;
	armRangeSelection: () => void;
	startRangeSelection: (time: MediaTime) => void;
	updateRangeSelection: (time: MediaTime) => void;
	completeRangeSelection: (time: MediaTime) => void;
	cancelRangeSelection: () => void;
	setRangePromptOpen: (open: boolean) => void;
}

export const useTimelineStore = create<TimelineStore>()(
	persist(
		(set) => ({
			snappingEnabled: true,

			toggleSnapping: () => {
				set((state) => ({ snappingEnabled: !state.snappingEnabled }));
			},

			rippleEditingEnabled: false,

			toggleRippleEditing: () => {
				set((state) => ({
					rippleEditingEnabled: !state.rippleEditingEnabled,
				}));
			},

			expandedElementIds: new Set<string>(),

			toggleElementExpanded: (elementId) => {
				set((state) => {
					const next = new Set(state.expandedElementIds);
					if (next.has(elementId)) {
						next.delete(elementId);
					} else {
						next.add(elementId);
					}
					return { expandedElementIds: next };
				});
			},

			aiRangeSelection: IDLE_TIMELINE_RANGE_SELECTION,

			armRangeSelection: () => {
				set((state) => ({
					aiRangeSelection:
						state.aiRangeSelection.mode === "idle"
							? {
									...IDLE_TIMELINE_RANGE_SELECTION,
									mode: "armed",
									isTimelineLocked: true,
								}
							: IDLE_TIMELINE_RANGE_SELECTION,
				}));
			},

			startRangeSelection: (time) => {
				set({
					aiRangeSelection: {
						mode: "selecting",
						startTime: time,
						endTime: time,
						anchorTime: time,
						isTimelineLocked: true,
						isPromptOpen: false,
					},
				});
			},

			updateRangeSelection: (time) => {
				set((state) => {
					if (
						state.aiRangeSelection.mode !== "selecting" ||
						state.aiRangeSelection.anchorTime === null
					) {
						return {};
					}
					const range = normalizeTimelineRange({
						startTime: state.aiRangeSelection.anchorTime,
						endTime: time,
					});
					return {
						aiRangeSelection: {
							...state.aiRangeSelection,
							startTime: range.startTime,
							endTime: range.endTime,
						},
					};
				});
			},

			completeRangeSelection: (time) => {
				set((state) => {
					if (
						state.aiRangeSelection.mode !== "selecting" ||
						state.aiRangeSelection.anchorTime === null
					) {
						return {};
					}
					const range = normalizeTimelineRange({
						startTime: state.aiRangeSelection.anchorTime,
						endTime: time,
					});
					if (range.duration <= 0) {
						return {
							aiRangeSelection: {
								...IDLE_TIMELINE_RANGE_SELECTION,
								mode: "armed",
								isTimelineLocked: true,
							},
						};
					}
					return {
						aiRangeSelection: {
							mode: "selected",
							startTime: range.startTime,
							endTime: range.endTime,
							anchorTime: state.aiRangeSelection.anchorTime,
							isTimelineLocked: true,
							isPromptOpen: true,
						},
					};
				});
			},

			cancelRangeSelection: () => {
				set({ aiRangeSelection: IDLE_TIMELINE_RANGE_SELECTION });
			},

			setRangePromptOpen: (open) => {
				set((state) => ({
					aiRangeSelection: {
						...state.aiRangeSelection,
						isPromptOpen: open,
						...(open ? {} : { isTimelineLocked: state.aiRangeSelection.mode !== "idle" }),
					},
				}));
			},
		}),
		{
			name: "timeline-store",
			partialize: (state) => ({
				snappingEnabled: state.snappingEnabled,
				rippleEditingEnabled: state.rippleEditingEnabled,
			}),
		},
	),
);
