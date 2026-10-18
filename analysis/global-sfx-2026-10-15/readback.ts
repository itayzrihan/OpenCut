import { readGlobalAudio, globalAudioFile, withGlobalAudio } from '../../classic/apps/web/src/shared-library/global-library';
import { readFile } from 'node:fs/promises';
const expected = JSON.parse(await readFile(new URL('./catalog.json',import.meta.url),'utf8')).audioAssets;
const global = await readGlobalAudio();
for(const a of expected) {
 const item = global.find(x=>x.id===a.id);
 if(!item || item.visibility!=='global')throw Error('Missing global '+a.name);
 if(!await globalAudioFile(['shared-library','audio','sfx',a.fileName]))throw Error('No route target '+a.name);
}
const merged=await withGlobalAudio({version:1,audioAssets:[],stickerAssets:[],categories:[],generatedBackgrounds:[],generatedEffects:[],generatedUiElements:[],captionPresets:[],updatedAt:''});
if(!expected.every((a:any)=>merged.audioAssets.some(x=>x.id===a.id)))throw Error('Account merge missing assets');
console.log(JSON.stringify({globalCount:global.length,readbackVerified:expected.length,accountMergeVerified:true}));
