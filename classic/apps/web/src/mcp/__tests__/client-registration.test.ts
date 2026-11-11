import { expect, test } from "bun:test";
import { registerMcpClient } from "../../../public/mcp-install/client-cli.mjs";

const name = "pocut-1234abcd";
const relay = "path with spaces/POCUT/pocut-mcp.mjs";
for (const client of ["codex", "claude"] as const) {
	test(`registers a local stdio relay in ${client} and verifies the entry`, async () => {
		const calls: string[][] = [];
		await registerMcpClient({ client, name, relay, command: process.execPath, executable: process.execPath,
			run: async (file, args, options) => {
				expect(file).toBe(process.execPath);
				expect(options.windowsHide).toBe(true);
				calls.push(args);
				return { stdout: "" };
			},
		});
		const flags = client === "claude" ? ["--scope", "user", "--transport", "stdio"] : [];
		expect(calls).toEqual([["mcp", "add", ...flags, name, "--", process.execPath, relay], ["mcp", "get", name]]);
	});
}

test("Claude setup can resume with the same relay but never replaces an unrelated server", async () => {
	for (const installed of [relay, "some other server.mjs"]) {
		const result = registerMcpClient({ client: "claude", name, relay, command: process.execPath, executable: process.execPath,
			run: async (_file, args) => {
				if (args.includes("add")) throw new Error("duplicate");
				expect(args).toEqual(["mcp", "get", name]);
				return { stdout: `Command: ${process.execPath}\nArgs: ${installed}\n` };
			},
		});
		if (installed === relay) await result;
		else await expect(result).rejects.toThrow("could not register");
	}
});
