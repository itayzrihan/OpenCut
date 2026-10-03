import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { webEnv } from "@/env/web";

let _db: ReturnType<typeof drizzle> | null = null;

export function getDb() {
	if (!_db) {
		if (!webEnv.DATABASE_URL) throw new Error("Hosted feedback/database service is not configured");
		const client = postgres(webEnv.DATABASE_URL);
		_db = drizzle(client, { schema });
	}

	return _db;
}

export * from "./schema";
