import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
function run(command, args, cwd = root) {
 const result = spawnSync(command, args, { cwd, stdio: 'inherit', env: {
  ...process.env, CARGO_TARGET_DIR: path.join(root,'.local/earshot-cargo-target'),
  CARGO_PROFILE_DEV_DEBUG:'0', CARGO_INCREMENTAL:'0', OPENCUT_EARSHOT_EXPORT_TEST:'1'
 }});
 if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.error}`);
}
run('node',['classic/scripts/prepare-earshot-runtime.mjs']);
run('node',['classic/scripts/test-earshot-runtime.mjs','--smoke']);
run('cargo',['test','-p','opencut-editor-api','--test','classic_procedural_audio']);
run('cargo',['test','-p','timeline','automatic_sound_effects'],path.join(root,'classic'));
run('cargo',['test','-p','timeline','automatic_word_animation'],path.join(root,'classic'));
run('cargo',['test','-p','timeline','full_auto_edit'],path.join(root,'classic'));
run('node',['classic/scripts/test-web.mjs','--jobs=1','--timeout=180000',
 'src/earshot/catalog.test.ts','src/earshot/__tests__/timeline-audio.test.ts','src/earshot/__tests__/export-browser.test.ts',
 'src/ai/__tests__/automatic-sound-effects.test.ts','src/ai/__tests__/earshot-repository.test.ts',
 'src/ai/__tests__/full-auto-edit-resume.test.ts','src/ai/__tests__/full-auto-edit-routed.test.ts',
 'src/ai/__tests__/full-auto-edit-takes.test.ts','src/media/__tests__/playback-audio-cache.test.ts',
 'src/core/managers/__tests__/audio-preparation.test.ts','src/export/__tests__/audio-source-windows.test.ts'
]);
run('node',['src/ai/skills/automatic-word-animation/generate.mjs','--check'],path.join(root,'classic/apps/web'));
run('node',['node_modules/typescript/bin/tsc','--noEmit','-p','tsconfig.build.json'],path.join(root,'classic/apps/web'));
console.log('Earshot canonical, synthesis, AI and timeline integration checks passed.');
