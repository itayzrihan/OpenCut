export interface ProjectNote {
	id: string;
	title: string;
	body: string;
	version: number;
	createdAt: string;
	updatedAt: string;
}

export const PROJECT_NOTES_LIMIT = 200;
export const NOTE_BODY_LIMIT = 20_000;
