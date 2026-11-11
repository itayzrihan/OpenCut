import { createZipBlob } from "@/project/archive/zip";
import { companionSetupSchema, type CompanionSetup } from "./companion/setup";

const companion = "pocut-companion-v4";
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

   On macOS and Windows this starts the Companion, registers it to start at
   sign-in, and creates the **POCUT Companion** desktop shortcut. Reinstalling
   preserves the user's startup preference. Verify the install output before
   reporting it. If the package expired before pairing, ask for a fresh ZIP.
   If the installer detects an earlier Companion on port 43127, confirm the
   listening process is POCUT's installed companion before stopping it. Close
   only that Companion, then rerun the command. Leave unrelated processes alone.
3. After installation, give the user all of these next steps in their language:
   - “I installed POCUT Companion. It will start automatically when you sign in
     to your computer.” If automatic startup is off, report that instead.
   - “I added a POCUT Companion shortcut to your desktop. Open it to turn the
     Companion on or off or change whether it starts at sign-in.”
   - “Return to the POCUT tab where you downloaded the ZIP and click **Connect**
     under OpenAI / Codex or Claude. (Chrome or your browser may ask next to
     the address bar to allow access to your local network or computer. Click
     **Allow** to continue.)”
   - For Codex, tell the user to click **Continue with ChatGPT** in the POCUT
     dialog that opens, then complete the official OpenAI sign-in.
   - For Claude, after the user clicks **Connect** and allows local access,
     run the following in a local terminal where they can complete sign-in:

         node pocut-companion.mjs POCUT-Setup.json --login-claude

4. Confirm POCUT shows the green connected status. **Check Connection** can
   verify an existing connection. Ask the user to enter credentials directly
   with their provider. Report any remaining steps accurately. Keep credentials
   and local pairing data out of the conversation.
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
		manifest?.version !== 4 ||
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
