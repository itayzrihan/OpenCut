import { accountConfigureStorage, accountValidateSnapshot } from "opencut-wasm";
import { withAccount, importLocked, requireAccount } from "@/accounts/server";
import { configureStorageFolder, readStorageProfile, listAccountSnapshots, type StoragePolicy } from "@/accounts/storage-host";
import { cancelStorageJob, startStorageJob, storageJob } from "@/accounts/storage-jobs";
import { exportAccountIdentity } from "@/accounts/identity-transfer";
import { readBoundedBody } from "@/accounts/request-body";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const policy: StoragePolicy = { configure: accountConfigureStorage, validate: accountValidateSnapshot };
export const GET = withAccount(async (request: Request) => {
	try {
		if (new URL(request.url).searchParams.has("status")) return Response.json({ job: await storageJob() });
		return Response.json({ profile: await readStorageProfile(), snapshots: await listAccountSnapshots(policy), job: await storageJob() });
	} catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
});
export const POST = withAccount(async (request: Request) => {
	try {
		const body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 8192)));
		if (body.action === "cancel") { cancelStorageJob(); return Response.json({ job: await storageJob() }); }
		if (await importLocked(requireAccount().id)) throw new Error("Wait for the current account storage operation to finish");
		if (body.action === "configure" && (body.folder === null || typeof body.folder === "string")) return Response.json({ profile: await configureStorageFolder(body.folder, policy) });
		if (body.action === "publish") return Response.json({ job: await startStorageJob("publish", policy) }, { status: 202 });
		if (body.action === "restore" && typeof body.snapshotId === "string") return Response.json({ job: await startStorageJob("restore", policy, body.snapshotId, body.preserveExisting === true) }, { status: 202 });
		if (body.action === "export-identity" && typeof body.password === "string") return Response.json(await exportAccountIdentity(body.password), { headers: { "Content-Disposition": 'attachment; filename="OpenCut-account-recovery.json"' } });
		throw new Error("Unknown storage action");
	} catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
});
