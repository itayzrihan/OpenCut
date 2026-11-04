import { create } from "zustand";
/** Ephemeral UI focus only; requests and reference state remain canonical. */
export const useDirectorReviewFocus = create<{
	accountId: string;
	projectId: string;
	jobId: string;
	reveal: (value: {
		accountId: string;
		projectId: string;
		jobId: string;
	}) => void;
	clear: () => void;
}>((set) => ({
	accountId: "",
	projectId: "",
	jobId: "",
	reveal: (value) => set(value),
	clear: () => set({ accountId: "", projectId: "", jobId: "" }),
}));
