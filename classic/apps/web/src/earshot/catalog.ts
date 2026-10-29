import catalog from "./catalog-data.json";
import { EARSHOT_REVISION, type EarshotSound, type EarshotSpec } from "./types";
export const EARSHOT_BANK_REVISION = EARSHOT_REVISION;
// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Generated pinned bank rows are checked by catalog and all-preset WASM tests.
export const EARSHOT_SOUNDS: readonly EarshotSound[] = Object.freeze((catalog as unknown as EarshotSound[]).map((row) => Object.freeze({ ...row, pitchable: Boolean(row.knobs.pitch) }) as EarshotSound));
const byId = new Map(EARSHOT_SOUNDS.map((sound) => [sound.id, sound]));
export function getEarshotSound(id: string): EarshotSound | undefined { return byId.get(id); }
export function createEarshotSpec(id: string): EarshotSpec {
  const sound = getEarshotSound(id);
  if (!sound) throw new Error(`Unknown Earshot sound: ${id}`);
  return { version: 1, engine: "earshot", bankRevision: EARSHOT_BANK_REVISION, presetId: id, seed: sound.seed, duration: Math.max(0.02, Math.min(30, sound.duration)) };
}

/** A short editable module that faithfully starts with the selected bank entry. */
export function createEarshotSourceCode(id: string): string {
  if (!getEarshotSound(id)) throw new Error(`Unknown Earshot sound: ${id}`);
  return `from earshot.forge import bank, dsp, fx
import numpy as np

def render(params, r):
    # params contains this clip's duration, seed and editable recipe parameters.
    entry = bank.get(${JSON.stringify(id)})
    if entry.get("type", "forge") == "forge":
        entry["params"].update({key: value for key, value in params.items() if key in entry["params"]})
    # source_spec is an immutable copy of this clip's canonical recipe.
    sound, _ = bank.render(entry, seed=source_spec["seed"],
        dur=source_spec["duration"], apex=source_spec.get("apex"),
        pitch=source_spec.get("pitch"), checks=False)
    # Add synthesis, layering, envelopes or fx here; return 48 kHz mono/stereo PCM.
    return sound
`;
}
