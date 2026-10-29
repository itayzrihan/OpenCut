/** Canonical serializable recipe. PCM is ephemeral; no audio asset is created. */
export interface EarshotSpec {
  version: 1;
  engine: "earshot";
  bankRevision: string;
  presetId: string;
  seed: number;
  duration: number;
  apex?: number;
  pitch?: number | string;
  parameters?: Record<string, number>;
  sourceCode?: string;
  echo?: { delay: number; feedback: number; mix: number };
}
export interface EarshotSound {
  id: string; name: string; category: string; duration: number; seed: number;
  onset: number; peak: number; kinds: string[]; notes: string;
  pitchable: boolean; parameters: Record<string, number>; sourcePath: string;
  knobs: { dur: string; apex: boolean; pitch: Record<string, unknown> | null; why?: string };
  source?: { id: string; title: string; author: string; license: string; url: string };
}
export const EARSHOT_REVISION = "591fa3e028032e6dce56620a20e932e35667e8d8";
export const EARSHOT_MAX_SECONDS = 30;
export function validateEarshotSpec(value: unknown): EarshotSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Earshot recipe.");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Every serialized field is validated below before returning a clone.
  const s = value as EarshotSpec;
  const allowed = new Set(["version", "engine", "bankRevision", "presetId", "seed", "duration", "apex", "pitch", "parameters", "sourceCode", "echo"]);
  if (Object.keys(s).some(key => !allowed.has(key))) throw new Error("Unknown Earshot recipe field.");
  const number = ({ value, min, max }: { value: unknown; min: number; max: number }) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
  if (s.version !== 1 || s.engine !== "earshot" || s.bankRevision !== EARSHOT_REVISION) throw new Error("Unsupported Earshot recipe version.");
  if (typeof s.presetId !== "string" || s.presetId.length > 128 || !/^[a-z0-9_.-]+(?:\/[a-z0-9_.-]+){1,2}$/.test(s.presetId)) throw new Error("Invalid Earshot preset.");
  if (!number({ value: s.seed, min: 0, max: 4294967295 }) || !Number.isInteger(s.seed)) throw new Error("Invalid Earshot seed.");
  if (!number({ value: s.duration, min: 0.02, max: EARSHOT_MAX_SECONDS })) throw new Error("Sound duration must be between 0.02 and 30 seconds.");
  if (s.apex !== undefined && !number({ value: s.apex, min: 0, max: s.duration })) throw new Error("The sound peak must be inside the clip.");
  if (s.pitch !== undefined && !(number({ value: s.pitch, min: 20, max: 20000 }) || (typeof s.pitch === "string" && s.pitch.length <= 24 && /^(?:[A-Ga-g](?:#|b|s)?[0-9]|[0-9]+(?:\.[0-9]+)?(?:hz)?)$/.test(s.pitch)))) throw new Error("Invalid sound pitch.");
  if (typeof s.pitch === "string") {
    const note = /^([A-Ga-g])([#bs]?)([0-9])$/.exec(s.pitch);
    const pitchHz = note ? 440 * 2 ** (((Number(note[3]) + 1) * 12 + ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[note[1].toUpperCase()] ?? 0) + (note[2] === "b" ? -1 : note[2] ? 1 : 0) - 69) / 12) : Number(s.pitch.replace(/hz$/, ""));
    if (!number({ value: pitchHz, min: 20, max: 20000 })) throw new Error("Sound pitch must be between 20 and 20,000 Hz.");
  }
  if (s.parameters !== undefined) {
    if (!s.parameters || typeof s.parameters !== "object" || Array.isArray(s.parameters) || Object.keys(s.parameters).length > 64) throw new Error("Invalid synthesis parameters.");
    for (const [key, v] of Object.entries(s.parameters)) if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key) || !number({ value: v, min: -1e6, max: 1e6 })) throw new Error("Invalid synthesis parameter.");
  }
  if (s.sourceCode !== undefined && (typeof s.sourceCode !== "string" || !s.sourceCode.trim() || s.sourceCode.includes("\0") || new TextEncoder().encode(s.sourceCode).length > 32768)) throw new Error("Sound code is limited to 32 KiB.");
  if (s.echo !== undefined && (!s.echo || typeof s.echo !== "object" || Array.isArray(s.echo) || Object.keys(s.echo).some(key => !["delay", "feedback", "mix"].includes(key)) || !number({ value: s.echo.delay, min: 0.005, max: 2 }) || !number({ value: s.echo.feedback, min: 0, max: 0.9 }) || !number({ value: s.echo.mix, min: 0, max: 1 }))) throw new Error("Invalid echo settings.");
  return structuredClone(s);
}
