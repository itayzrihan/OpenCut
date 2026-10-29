/* Earshot v1: dedicated worker inside an opaque sandbox iframe. No network. */
(() => {
  const send = self.postMessage.bind(self);
  const nativeFetch = self.fetch.bind(self);
  const nativeImport = self.importScripts.bind(self);
  let pyodide;
  let initialized = false;
  const urls = new Map();
  const decoder = new TextDecoder();
  const mime = (name) => name.endsWith('.js') ? 'text/javascript' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
  const fileName = (value) => {
    const url = typeof value === 'string' ? value : value?.url || String(value);
    return String(url).split('/').at(-1).split('?')[0];
  };
  const locate = (input) => {
    const name = fileName(input);
    const url = urls.get(name);
    if (!url) throw new Error(`Earshot network access denied: ${name}`);
    return url;
  };
  self.fetch = (input) => nativeFetch(locate(input));
  self.importScripts = (...inputs) => nativeImport(...inputs.map(locate));
  self.onmessage = async ({ data }) => {
    try {
      if (data.type === 'initialize') {
        if (initialized) throw new Error('Already initialized');
        initialized = true;
        const assets = new Map(data.assets.map(({ file, bytes }) => [file, bytes]));
        for (const [file, bytes] of assets) urls.set(file, URL.createObjectURL(new Blob([bytes], { type: mime(file) })));
        nativeImport(locate('pyodide.js'));
        pyodide = await self.loadPyodide({
          indexURL: 'https://earshot.invalid/runtime/',
          packageBaseUrl: 'https://earshot.invalid/runtime/',
          lockFileContents: JSON.parse(decoder.decode(assets.get('pyodide-lock.json'))),
          jsglobals: Object.create(null),
          stdout: () => {}, stderr: () => {},
        });
        await pyodide.loadPackage(['numpy', 'scipy']);
        const sourceFiles = JSON.parse(decoder.decode(assets.get('source-files.json')));
        for (const [path, source] of Object.entries(sourceFiles)) {
          if (path.startsWith('/') || path.split('/').includes('..')) throw new Error('Invalid source path');
          const full = '/earshot-project/' + path;
          pyodide.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
          pyodide.FS.writeFile(full, source);
        }
        pyodide.runPython("import sys; sys.path.insert(0, '/earshot-project')");
        nativeImport(locate('kernels.js'));
        pyodide.globals.set('_earshot_kernels', self.earshotKernels);
        pyodide.runPython(decoder.decode(assets.get('renderer.py')));
        send({ type: 'ready' });
      } else if (data.type === 'render') {
        if (!pyodide) throw new Error('Renderer is not ready');
        pyodide.globals.set('_clip_spec_json', JSON.stringify(data.spec));
        const result = pyodide.runPython('render_clip(json.loads(_clip_spec_json))');
        let buffer;
        try {
          buffer = result.getBuffer('f32');
          const count = buffer.shape[0];
          const frames = buffer.shape[1];
          if ((count !== 1 && count !== 2) || frames > 1440000 || frames < 1) throw new Error('Invalid sound output');
          const channels = Array.from({ length: count }, (_, channel) => new Float32Array(buffer.data.subarray(channel * frames, (channel + 1) * frames)));
          for (const channel of channels) for (const v of channel) if (!Number.isFinite(v) || Math.abs(v) > 1.001) throw new Error('Invalid sound sample');
          send({ type: 'result', id: data.id, sampleRate: 48000, channels }, channels.map(channel => channel.buffer));
        } finally {
          buffer?.release();
          result.destroy();
        }
      }
    } catch (error) {
      send({ type: 'error', id: data.id, error: String(error?.message || error).slice(0, 1600) });
    }
  };
})();
