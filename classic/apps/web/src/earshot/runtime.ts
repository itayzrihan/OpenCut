/** Browser adapter only. Project recipes live in the canonical EditorDocument. */
export interface EarshotRuntimeAsset { file: string; bytes: ArrayBuffer }
let assetsPromise: Promise<EarshotRuntimeAsset[]> | undefined;
const MAX_RUNTIME_BYTES = 64 * 1024 * 1024;
export function loadEarshotRuntimeAssets(): Promise<EarshotRuntimeAsset[]> {
  if (!assetsPromise) assetsPromise = (async () => {
    const base = new URL('/earshot/runtime/', window.location.origin);
    const response = await fetch(new URL('manifest.json', base), { credentials: 'omit' });
    if (!response.ok) throw new Error('Earshot synthesis runtime is not installed. Run the application asset preparation step.');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- The local build manifest is bounded and each resource is validated before use.
    const manifest = await response.json() as { version: number; pyodide: string; assets: { file: string; size: number; sha256: string }[] };
    if (manifest.version !== 1 || manifest.pyodide !== '0.28.3' || !Array.isArray(manifest.assets) || manifest.assets.length > 20 || manifest.assets.reduce((n, a) => n + a.size, 0) > MAX_RUNTIME_BYTES) throw new Error('Invalid Earshot runtime manifest.');
    return Promise.all(manifest.assets.map(async (asset) => {
      if (!/^[A-Za-z0-9_.-]+$/.test(asset.file) || !/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_RUNTIME_BYTES) throw new Error('Invalid Earshot runtime resource.');
      const r = await fetch(new URL(asset.file, base), { credentials: 'omit' });
      if (!r.ok) throw new Error(`Earshot runtime resource is missing: ${asset.file}`);
      const bytes = await r.arrayBuffer();
      if (bytes.byteLength !== asset.size) throw new Error(`Earshot runtime resource has the wrong size: ${asset.file}`);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hash = Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('');
      if (hash !== asset.sha256) throw new Error(`Earshot runtime integrity check failed: ${asset.file}`);
      return { file: asset.file, bytes };
    }));
  })().catch((error) => { assetsPromise = undefined; throw error; });
  return assetsPromise;
}

// Opaque origin is essential: a same-origin worker would expose the app's authenticated APIs to Python's JS bridge.
export const EARSHOT_SANDBOX_HTML = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src blob:; child-src blob:; connect-src blob:; img-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><script>
addEventListener('message', function initialize(event) {
  if (event.source !== parent || event.data?.type !== 'earshot-initialize' || !event.ports[0]) return;
  removeEventListener('message', initialize);
  const port = event.ports[0];
  const assets = event.data.assets;
  const script = assets.find(asset => asset.file === 'worker.js');
  const worker = new Worker(URL.createObjectURL(new Blob([script.bytes], {type: 'text/javascript'})));
  worker.onmessage = ({data}) => {
    const transfers = data.type === 'result' ? data.channels.map(channel => channel.buffer) : [];
    port.postMessage(data, transfers);
  };
  worker.onerror = event => port.postMessage({type:'error',error:event.message || 'Sound worker failed.'});
  port.onmessage = ({data}) => { if (data.type === 'render') worker.postMessage(data); else if (data.type === 'close') worker.terminate(); };
  port.start();
  worker.postMessage({type:'initialize',assets}, assets.map(asset => asset.bytes));
});
</script>`;

export interface EarshotWorkerSession { port: MessagePort; dispose(): void }
export async function createEarshotWorkerSession(signal?: AbortSignal): Promise<EarshotWorkerSession> {
  signal?.throwIfAborted();
  const originals = await loadEarshotRuntimeAssets();
  signal?.throwIfAborted();
  const assets = originals.map(({ file, bytes }) => ({ file, bytes: bytes.slice(0) }));
  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.display = 'none';
  const channel = new MessageChannel();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    channel.port1.postMessage({ type: 'close' });
    channel.port1.close(); channel.port2.close(); frame.remove();
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Earshot runtime initialization timed out.')), 120000);
      const done = (error?: Error) => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
      const abort = () => done(new DOMException('Sound synthesis cancelled.', 'AbortError'));
      signal?.addEventListener('abort', abort, { once: true });
      channel.port1.onmessage = ({ data }) => { if (data.type === 'ready') done(); else if (data.type === 'error') done(new Error(String(data.error))); };
      channel.port1.start();
      frame.onload = () => frame.contentWindow?.postMessage({ type: 'earshot-initialize', assets }, '*', [channel.port2, ...assets.map(asset => asset.bytes)]);
      frame.srcdoc = EARSHOT_SANDBOX_HTML;
      document.body.appendChild(frame);
    });
    return { port: channel.port1, dispose };
  } catch (error) { dispose(); throw error; }
}
