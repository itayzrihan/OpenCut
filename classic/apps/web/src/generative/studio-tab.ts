import { create } from "zustand";
/** Director navigation only; creative data belongs to the canonical runtime. */
export const useDirectorStudioTab = create<{
	tab: "video" | "audio";
	setTab: (tab: "video" | "audio") => void;
}>((set) => ({ tab: "video", setTab: (tab) => set({ tab }) }));
