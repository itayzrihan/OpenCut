import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { EARSHOT_SOUNDS, createEarshotSpec, getEarshotSound } from './catalog';
import { validateEarshotSpec } from './types';
import { EARSHOT_SANDBOX_HTML } from './runtime';

describe('Earshot recipe contract', () => {
  test('every one of the 252 shipped presets produces a canonical valid recipe', () => {
    expect(EARSHOT_SOUNDS).toHaveLength(252);
    expect(new Set(EARSHOT_SOUNDS.map(s => s.id)).size).toBe(252);
    for (const sound of EARSHOT_SOUNDS) {
      const spec = createEarshotSpec(sound.id);
      expect(validateEarshotSpec(spec)).toEqual(spec);
      expect(getEarshotSound(sound.id)).toBe(sound);
      expect(sound.sourcePath.startsWith('earshot/')).toBe(true);
    }
  });
  test('the browser validator agrees with the shared Rust capability contract fixture', () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('../../../../../crates/editor-api/tests/fixtures/earshot-source-contract.json', import.meta.url), 'utf8'));
    for (const { patch, valid } of fixture.cases) {
      let accepted = true;
      try { validateEarshotSpec({ ...fixture.base, ...patch }); } catch { accepted = false; }
      expect(accepted, JSON.stringify(patch)).toBe(valid);
    }
  });
  test('rejects oversized code, excessive parameters, null echo and non-finite inputs', () => {
    const base = createEarshotSpec('ui_pop/soft');
    for (const patch of [{ duration: NaN }, { sourceCode: 'x'.repeat(32769) }, { sourceCode: 'א'.repeat(17000) }, { parameters: Object.fromEntries(Array.from({length:65},(_,i)=>['p'+i,1])) }, { echo:null }]) expect(() => validateEarshotSpec({...base,...patch})).toThrow();
  });
  test('the execution document forbids network and does not grant same-origin privileges', () => {
    expect(EARSHOT_SANDBOX_HTML).toContain("connect-src blob:");
    expect(EARSHOT_SANDBOX_HTML).toContain("default-src 'none'");
    expect(EARSHOT_SANDBOX_HTML).not.toContain('allow-same-origin');
  });
});
