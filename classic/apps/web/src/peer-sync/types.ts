export type PeerDevice = {
	id: string;
	name: string;
	publicKey: string;
	lastSeenAt: number;
};
export type PullRequest = {
	projectId: string;
	mediaId: string;
	deviceId: string;
	operationId: string;
	expectedBindingRevision: number;
};
export type PullManifest = {
	projectId: string;
	mediaId: string;
	fileName: string;
	mimeType: string;
	bytes: number;
	sha256: string;
	lastModified: number;
};
export type PullJob = PullRequest & {
	status: "running" | "ready" | "cancelled" | "failed";
	phase: "checking-source" | "downloading" | "verifying" | "ready";
	receivedBytes: number;
	totalBytes: number;
	updatedAt: number;
	manifest?: PullManifest;
	source?: string;
	error?: string;
	sourceVersion?: {
		size: number;
		mtimeMs: number;
		ctimeMs: number;
		ino: number;
	};
};
export type PeerStatus = {
	enabled: boolean;
	configured: boolean;
	linked: boolean;
	connected: boolean;
	deviceId: string;
	deviceName: string;
	devices: PeerDevice[];
	error: string | null;
};
