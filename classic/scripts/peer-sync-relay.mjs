#!/usr/bin/env node
import { createPeerRelay } from "../apps/web/src/peer-sync/relay.mjs";
const port = Number(process.env.OPENCUT_PEER_RELAY_PORT || 3010);
const hostname = process.env.OPENCUT_PEER_RELAY_HOST || "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535)
	throw new Error("Invalid relay port");
const server = createPeerRelay();
server.listen(port, hostname, () =>
	console.log(`OpenCut encrypted peer relay listening on ${hostname}:${port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => {
		server.closeAllConnections();
		server.close();
	});
