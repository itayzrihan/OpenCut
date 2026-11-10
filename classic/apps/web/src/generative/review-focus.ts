import { create } from "zustand";
/** Ephemeral UI focus only; requests and reference state remain canonical. */
export const useDirectorReviewFocus = create<{
	accountId: string;
	projectId: string;
	jobId: string;
	batchId?: string;
	surface?: "agent" | "director";
	reveal: (value: {
		accountId: string;
		projectId: string;
		jobId: string;
		batchId?: string;
		surface?: "agent" | "director";
	}) => void;
	clear: () => void;
}>((set) => ({
	accountId: "",
	projectId: "",
	jobId: "",
	surface: "director",
	reveal: (value) => set({ batchId: undefined, surface: "director", ...value }),
	clear: () =>
		set({
			accountId: "",
			projectId: "",
			jobId: "",
			batchId: undefined,
			surface: "director",
		}),
}));
