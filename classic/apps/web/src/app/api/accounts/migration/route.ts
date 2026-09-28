import { canImportLegacy, withAccount } from "@/accounts/server";
import { inspectLegacyImport } from "@/accounts/migration";
import { cancelMigration, migrationJob, startMigration } from "@/accounts/migration-jobs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const GET = withAccount(async () => {
	try {
		const allowed = await canImportLegacy();
		return Response.json({ allowed, job: await migrationJob(), inventory: allowed ? await inspectLegacyImport() : null });
	} catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
});
export const POST = withAccount(async (request: Request) => {
	try {
		if (!await canImportLegacy()) return Response.json({ error: "This account does not own the legacy import grant" }, { status: 403 });
		const body = await request.json();
		if (body.action === "cancel") { cancelMigration(); return Response.json({ job: await migrationJob() }); }
		if (body.action !== "import") throw new Error("Unknown migration action");
		return Response.json({ job: await startMigration() }, { status: 202 });
	} catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 }); }
});
