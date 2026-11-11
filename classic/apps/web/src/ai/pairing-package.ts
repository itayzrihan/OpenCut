import { createZipBlob } from "@/project/archive/zip";
import { companionSetupSchema, type CompanionSetup } from "./companion/setup";

const companion = "pocut-companion-v2";
export const PAIRING_PACKAGE_NAME = "POCUT-Pairing-Instructions.zip";

const instructions = `# Set up the POCUT AI companion

For the AI assistant receiving this ZIP: perform the steps below on the computer
where the user has POCUT open. A remote terminal cannot install a local companion.

1. Extract the three files together. Check for Node.js 22 or later and the official
   CLI for the provider the user wants to connect. If needed, install them using
   the official instructions for this computer.
   - Node.js: https://nodejs.org/en/download
   - OpenAI Codex CLI: https://learn.chatgpt.com/docs/codex/cli
   - Claude Code CLI: https://code.claude.com/docs/en/quickstart
2. In the extracted folder, run:

       node pocut-companion.mjs POCUT-Setup.json --install

   Wait for the companion to report that it is ready. If the package expired
   before pairing, ask the user to download a fresh ZIP. If another companion
   is already running, check the existing connection in POCUT. For a confirmed
   older POCUT companion, stop it using its original terminal or service and
   retry the install. Leave unrelated processes alone.
3. Ask the user to return to the POCUT tab that downloaded the ZIP and allow
   local-network access if the browser prompts.
   - **Codex:** Have the user click **Continue with ChatGPT** and complete the
     official sign-in. Use **Check Codex connection** if it is already signed in.
   - **Claude:** Have the user click **Check Claude connection**. Then run this
     command in a local terminal the user can interact with:

         node pocut-companion.mjs POCUT-Setup.json --login-claude

     The user completes Claude's official sign-in. Check the connection again
     in POCUT if it has not updated automatically.

The companion stays running in the background. The same setup supports both
providers on this device. Confirm the connection in POCUT before reporting
completion. Let the user enter credentials and approve requests directly in
their provider's sign-in interface. Keep credentials and local pairing data out
of the conversation.
`;

export async function createPairingPackage({
	setup,
	signal,
}: {
	setup: CompanionSetup;
	signal: AbortSignal;
}) {
	const config = companionSetupSchema.parse(setup);
	const [release, script] = await Promise.all([
		fetch(`/downloads/${companion}.json`, { signal, cache: "no-store" }),
		fetch(`/downloads/${companion}.mjs`, { signal, cache: "no-store" }),
	]);
	if (!release.ok || !script.ok)
		throw new Error("Pairing instructions are unavailable. Try again.");
	const manifest = await release.json();
	const binary = await script.arrayBuffer();
	const digest = await crypto.subtle.digest("SHA-256", binary);
	const sha256 = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	if (
		manifest?.version !== 2 ||
		manifest.filename !== `${companion}.mjs` ||
		manifest.bytes !== binary.byteLength ||
		manifest.sha256 !== sha256
	)
		throw new Error("Pairing instructions could not be verified. Try again.");
	signal.throwIfAborted();
	return createZipBlob({
		entries: [
			{ path: "README.md", data: instructions },
			{
				path: "POCUT-Setup.json",
				data: JSON.stringify(config, null, 2) + "\n",
			},
			{ path: "pocut-companion.mjs", data: binary },
		],
	});
}
