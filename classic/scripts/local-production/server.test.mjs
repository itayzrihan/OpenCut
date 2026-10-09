import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';

async function freePort() {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function eventually(check) {
  for (let i=0;i<100;i++) { if (await check()) return; await new Promise(r=>setTimeout(r,50)); }
  assert.fail('Condition timed out');
}
test('loopback launcher authenticates commands, preserves release on update rejection, and stops its processes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencut-launcher-test-'));
  const panelPort = await freePort(), appPort = await freePort();
  const releaseRoot = join(root, 'releases/test'), appRoot = join(releaseRoot, 'server/apps/web');
  await mkdir(appRoot, { recursive: true });
  await writeFile(join(root, 'config.json'), JSON.stringify({ node:process.execPath,path:process.env.PATH,accountsRoot:join(root,'accounts'),panelPort,appPort }));
  await writeFile(join(root, 'current.json'), JSON.stringify({ id:'test',appRoot,commit:'abcdef1234' }));
  await writeFile(join(appRoot,'server.js'), `process.on('SIGTERM',()=>process.exit(143));require('node:http').createServer((q,s)=>s.end('production')).listen(Number(process.env.PORT),'127.0.0.1');`);
  await writeFile(join(releaseRoot,'opencut-mcp'), '#!/bin/sh\nexec cat > /dev/null\n', { mode:0o755 });
  const controller = spawn(process.execPath,[join(import.meta.dirname,'server.mjs')],{env:{...process.env,OPENCUT_LOCAL_DEPLOYMENT_DIR:root},stdio:'pipe'});
  let logs='';controller.stderr.on('data',chunk=>logs+=chunk);
  const origin=`http://127.0.0.1:${panelPort}`;
  try {
    await eventually(async()=>{try{return(await fetch(origin+'/health')).ok}catch{return false}});
    const page=await fetch(origin);const html=await page.text();
    assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
    const token=html.match(/X-OpenCut-Launcher':'([a-f0-9]+)'/)[1];
    const headers={'X-OpenCut-Launcher':token,Origin:origin};
    assert.equal((await fetch(origin+'/start',{method:'POST'})).status,403);
    assert.equal((await fetch(origin+'/start',{method:'POST',headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
    const badHost = await new Promise(resolve => { const q = request(origin+'/health', { headers: { Host:'untrusted.example' } }, r => { r.resume(); resolve(r.statusCode); }); q.end(); });
    assert.equal(badHost,403);
    assert.equal((await fetch(origin+'/shell',{method:'POST',headers})).status,404);
    assert.equal((await fetch(origin+'/start',{method:'POST',headers})).status,200);
    assert.equal((await fetch(origin+'/start',{method:'POST',headers})).status,200);
    const running=await(await fetch(origin+'/status',{headers})).json();assert.equal(running.running,true);
    assert.equal((await fetch(origin+'/update',{method:'POST',headers})).status,400);
    assert.equal((await fetch(origin+'/quit',{method:'POST',headers})).status,400);
    assert.equal((await fetch(origin+'/stop',{method:'POST',headers})).status,200);
    const stopped=await(await fetch(origin+'/status',{headers})).json();
    assert.equal(stopped.running,false);assert.equal(stopped.error,null);
    await assert.rejects(fetch(`http://127.0.0.1:${appPort}`));
    const exit=once(controller,'exit');
    assert.equal((await fetch(origin+'/quit',{method:'POST',headers})).status,200);
    await exit;assert.equal(controller.exitCode,0,logs);
  } finally { controller.kill();await rm(root,{recursive:true,force:true}); }
});
