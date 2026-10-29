import { getEarshotSound } from './catalog';
import { createEarshotWorkerSession, type EarshotWorkerSession } from './runtime';
import { validateEarshotSpec, type EarshotSpec } from './types';
export interface EarshotPCM { channels: Float32Array[]; sampleRate: number }
let shared: EarshotWorkerSession | undefined;
let serial: Promise<unknown> = Promise.resolve();
let nextId = 1;
export function disposeEarshotRenderer(): void { shared?.dispose(); shared = undefined; }
export function renderEarshotSound({ spec: input, signal }: { spec: EarshotSpec; signal?: AbortSignal }): Promise<EarshotPCM> {
  const spec = validateEarshotSpec(input);
  if (!getEarshotSound(spec.presetId)) return Promise.reject(new Error(`Unknown Earshot sound: ${spec.presetId}`));
  const task = serial.catch(() => {}).then(async () => {
    signal?.throwIfAborted();
    // Custom code never shares a Python heap with another clip or a trusted bank render.
    const custom = Boolean(spec.sourceCode);
    const session = custom ? await createEarshotWorkerSession(signal) : shared ??= await createEarshotWorkerSession(signal);
    const id = nextId++;
    try {
      return await new Promise<EarshotPCM>((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error('Sound synthesis exceeded its time limit. Simplify the code or shorten the effect.')), custom ? 45000 : 180000);
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); session.port.onmessage = null; };
        const fail = (error: Error) => { cleanup(); session.dispose(); if (shared === session) shared = undefined; reject(error); };
        const abort = () => fail(new DOMException('Sound synthesis cancelled.', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        session.port.onmessage = ({ data }) => {
          if (data.type === 'error') return fail(new Error(String(data.error).slice(0, 1600)));
          if (data.type !== 'result' || data.id !== id) return;
          const frames = Math.round(spec.duration * 48000);
          if (data.sampleRate !== 48000 || !Array.isArray(data.channels) || ![1, 2].includes(data.channels.length) || data.channels.some((c: unknown) => !(c instanceof Float32Array) || c.length !== frames || c.some(v => !Number.isFinite(v) || Math.abs(v) > 1.001))) return fail(new Error('Sound synthesis returned invalid PCM.'));
          cleanup();
          resolve({ channels: data.channels, sampleRate: 48000 });
        };
        session.port.postMessage({ type: 'render', id, spec });
      });
    } finally { if (custom) session.dispose(); }
  });
  serial = task;
  if (!signal) return task;
  return new Promise<EarshotPCM>((resolve, reject) => {
    const abort = () => reject(new DOMException('Sound synthesis cancelled.', 'AbortError'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
