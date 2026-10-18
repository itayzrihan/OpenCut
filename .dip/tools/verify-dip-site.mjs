import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
const origin='https://dip.vxu.me';
function get(path){return execFileSync('curl',['--fail','--silent','--show-error','--max-time','30',origin+path]);}
const html=get('/').toString();
assert(html.includes('The archaeology') && html.includes('npm install -g github:vxu-labs/dip'));
assert(html.includes('https://dip.vxu.me/'));
for(const path of ['/style.css','/script.js','/assets/dashboard.png','/assets/favicon.svg','/robots.txt','/sitemap.xml']){
 assert.deepEqual(get(path),readFileSync('sites/dip-public/public'+path),path+' differs from deployed source');
}
console.log('PASS: public HTTPS page, expected DIP content and all six deployed assets match local source.');

const session=JSON.parse(get('/api/dashboard'));assert.equal(session.user,null);assert.equal(typeof session.configured,'boolean');assert(get('/dashboard').toString().includes('Your projects'));
