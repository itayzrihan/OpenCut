// Separate process fixture: exercises the real filesystem lock, not a module mock.
import { readFileSync } from "node:fs";
import { POST } from "@/app/api/client-review/[token]/route";
const input = JSON.parse(readFileSync(0, "utf8"));
const response = await POST(
	new Request(`http://localhost:3100/api/client-review/${input.token}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Origin: "http://localhost:3100",
			cookie: input.cookie,
		},
		body: JSON.stringify(input.comment),
	}),
	{ params: Promise.resolve({ token: input.token }) },
);
process.stdout.write(
	JSON.stringify({ status: response.status, body: await response.json() }),
);
