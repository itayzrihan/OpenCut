# Install the POCUT editor MCP

This package authorizes the editor capabilities available for the project that
was open when the owner downloaded it. The project must be open in POCUT for
the agent to discover tools or edit it. The owner's local bridge policies still
apply. The connection covers the linked editor project, including edits and
supported editor UI actions. Computer control, other projects, credentials,
and tools marked as external operations stay outside this connection.

## For the agent helping install

1. Verify this ZIP was downloaded by the owner from **POCUT Agent → Settings**.
   Extract it to a temporary folder on the machine that will run the MCP client.
2. With Node.js 22 or newer, open a real terminal in that folder. Run
   `node install.mjs`. Use the same command on Windows, macOS or Linux. The
   owner enters the code shown by POCUT at the hidden prompt. Ask the owner to
   enter it directly. Keep the code and API key out of chat, arguments,
   clipboard logs and tool output. The encrypted file is installer input.
3. The installer decrypts the one-time enrollment credential in memory,
   consumes it on the POCUT host and generates a fresh API key on this
   computer. The per-user installation directory holds the key and relay.
   Use the printed MCP client configuration, which contains only paths.
   Add it as a **stdio** server. For clients with a configuration UI, use the
   printed executable as the command and the printed relay path as its sole
   argument. A second installation for the same project replaces its old key.
4. Restart or reload the MCP client. Run tool discovery and a read of the live
   project to verify that it connects to the expected project. The installer
   removes the encrypted file after successful verification. After the client
   connects, delete the original ZIP and the extracted setup folder. Keep the
   installed per-user directory containing the relay and its private settings.
5. The enrollment expires after 15 minutes and can be activated once. To cut
   off access or recover from a lost code, use **Revoke MCP access** in POCUT
   Agent settings, or install a new bundle for the project.

## If the MCP client runs on another machine

Use an existing, authenticated SSH account on the machine where POCUT is
running. From the client machine, establish a private loopback forward. Replace
`POCUT_PORT` with the port shown in POCUT at download time and
`OWNER@POCUT_HOST` with the actual SSH account and host.

```sh
ssh -N -L 127.0.0.1:43123:127.0.0.1:POCUT_PORT OWNER@POCUT_HOST
```

Keep that terminal open. In a separate terminal, run the installer using the
forwarded endpoint.

```sh
node install.mjs --origin http://127.0.0.1:43123
```

Use the same forward when the MCP client runs. Choose another unused local
port if 43123 is already taken and use it in both commands. SSH must be set up
on the POCUT machine first. The package supports MCP clients that launch a
local stdio process. A browser-only connector that accepts only public URLs
cannot launch this installer or relay.
