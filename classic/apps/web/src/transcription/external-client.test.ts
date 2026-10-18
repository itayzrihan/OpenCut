import { mockFetch } from "@/test-support/mock-fetch";
import {afterEach,beforeEach,expect,test} from 'bun:test';
import {encodeSpeechWav,transcribeExternalWindow} from './external-client';
let originalWindow:PropertyDescriptor|undefined;let originalFetch:typeof fetch;
beforeEach(()=>{originalWindow=Object.getOwnPropertyDescriptor(globalThis,'window');originalFetch=globalThis.fetch;Object.defineProperty(globalThis,'window',{configurable:true,value:{__opencutAccountId:'alice'}});});
afterEach(()=>{globalThis.fetch=originalFetch;if(originalWindow)Object.defineProperty(globalThis,'window',originalWindow);else Reflect.deleteProperty(globalThis,'window');});
test('WAV uses bounded mono 16kHz PCM16',async()=>{const blob=encodeSpeechWav({samples:new Float32Array([-1,0,1])});const bytes=new DataView(await blob.arrayBuffer());expect(blob.size).toBe(50);expect(bytes.getUint16(22,true)).toBe(1);expect(bytes.getUint32(24,true)).toBe(16000);expect(bytes.getInt16(48,true)).toBe(32767);expect(()=>encodeSpeechWav({samples:new Float32Array(16000*91)})).toThrow('bounded');});
test('API requests bind account and provider version without browser credentials',async()=>{
 globalThis.fetch=mockFetch(async(_url,request)=>{expect(new Headers(request?.headers).get('X-OpenCut-Account')).toBe('alice');const body=request!.body as FormData;expect(body.get('configuration')).toBe('provider-version');expect(body.get('apiKey')).toBeNull();return Response.json({text:'hello',words:[{text:'hello',start:0,end:1}],segments:[],language:'en'});});
 const result=await transcribeExternalWindow({samples:new Float32Array(16),language:'en',signal:new AbortController().signal,configuration:'provider-version',account:'alice'});expect(result.words?.[0].text).toBe('hello');
});
test('cancellation and account changes prevent outgoing audio',async()=>{let called=false;globalThis.fetch=mockFetch(async()=>{called=true;return Response.json({});});const input={samples:new Float32Array(16),language:'en' as const,configuration:'version',account:'alice'};await expect(transcribeExternalWindow({...input,signal:AbortSignal.abort()})).rejects.toHaveProperty('name','AbortError');window.__opencutAccountId='bob';await expect(transcribeExternalWindow({...input,signal:new AbortController().signal})).rejects.toHaveProperty('name','AbortError');expect(called).toBe(false);});
