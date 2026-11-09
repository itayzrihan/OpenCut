import { join } from "node:path";
import { accountsRoot, requireAccount } from "@/accounts/server";
import type { DirectorReference } from "../types";
import * as store from "./store";
export function publicOrigin() {
	const value = process.env.OPENCUT_PUBLIC_ORIGIN;
	if (!value) return null;
	const u = new URL(value);
	if (
		u.protocol !== "https:" ||
		u.hostname === "localhost" ||
		u.username ||
		u.password
	)
		throw new Error(
			"Temporary sharing requires this app's public HTTPS origin",
		);
	return u.origin;
}
export async function share({
	projectId,
	reference,
}: {
	projectId: string;
	reference: DirectorReference;
}) {
	const origin = publicOrigin();
	if (!origin)
		throw new Error(
			"Original audio/video needs temporary HTTPS hosting. Add an exact POCAST download link or configure this POCUT host's public HTTPS origin.",
		);
	const token = store.id() + store.id();
	await store.saveJson({
		root: join(accountsRoot(), "generative-shares"),
		name: token + ".json",
		value: {
			accountId: requireAccount().id,
			projectId,
			fileId: reference.id,
			expires: Date.now() + 3600_000,
		},
	});
	return origin + "/api/generative/share/" + token;
}
export async function sharedArtifact(token: string) {
	if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Link unavailable");
	const info = await store.json<{
		accountId: string;
		projectId: string;
		fileId: string;
		expires: number;
	}>({
		root: join(accountsRoot(), "generative-shares"),
		name: token + ".json",
	});
	if (
		info.expires < Date.now() ||
		!/^[a-zA-Z0-9_-]{1,128}$/.test(info.accountId)
	)
		throw new Error("Link expired");
	return store.file({
		root: join(accountsRoot(), "data", info.accountId, "generative"),
		fileId: info.fileId,
		projectId: info.projectId,
	});
}
