/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- The fixture implements only the stores the bridge consumes. */
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type { EditorCore } from "@/core";
import { ClassicMcpBridge } from "../classic-mcp-bridge";
import { controls, editor } from "./bridge-browser-fixture";

const root = createRoot(document.getElementById("root")!);
flushSync(() =>
	root.render(<ClassicMcpBridge editor={editor as unknown as EditorCore} />),
);
controls.unmount = () => flushSync(() => root.unmount());
