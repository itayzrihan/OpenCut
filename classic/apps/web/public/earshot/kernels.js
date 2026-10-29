/* MIT Leon Lin / Earshot: numerical equivalents of its optional numba kernels.
 * NumPy/scipy recipes stay upstream; only sequential loops execute in JS in WASM builds.
 * No filesystem/network/browser references are exposed by this object. */
(() => {
 const call = (args, fn) => { const buffers=[]; try { const a=args.map(v=>{if(v?.getBuffer){const b=v.getBuffer('f64');buffers.push(b);return {data:b.data,shape:Array.from(b.shape)};}return v;});return fn(...a); } finally {for(const b of buffers)b.release();} };
 const vector=(name,fn)=>(...a)=>call(a,fn);
 const blep=(t,dt)=>t<dt?(t/=dt,t+t-t*t-1):t>1-dt?(t=(t-1)/dt,t*t+t+t+1):0;
 globalThis.earshotKernels=Object.freeze({
  svf:vector('svf',(x,fc,q,mode)=>{let i1=0,i2=0;const y=new Float64Array(x.data.length);for(let i=0;i<y.length;i++){const g=Math.tan(Math.PI*fc.data[i]/48000),k=1/Math.max(q.data[i],.05),a1=1/(1+g*(g+k)),a2=g*a1,a3=g*a2,v3=x.data[i]-i2,v1=a1*i1+a2*v3,v2=i2+a2*i1+a3*v3;i1=2*v1-i1;i2=2*v2-i2;y[i]=mode===0?v2:mode===1?v1:mode===3?k*v1:x.data[i]-k*v1-v2;}return y;}),
  osc:vector('osc',(f,shape,ph)=>{const y=new Float64Array(f.data.length);for(let i=0;i<y.length;i++){const dt=Math.min(Math.max(f.data[i]/48000,1e-9),.49);y[i]=shape===0?Math.sin(2*Math.PI*ph):shape===1?2*ph-1-blep(ph,dt):(ph<.5?1:-1)+blep(ph,dt)-blep((ph+.5)%1,dt);ph+=dt;if(ph>=1)ph-=1;}return y;}),
  allpass:vector('allpass',(x,d,g)=>{const y=new Float64Array(x.data.length),buf=new Float64Array(d);let j=0;for(let i=0;i<y.length;i++){const v=buf[j],u=x.data[i]+g*v;y[i]=v-g*u;buf[j]=u;j++;if(j>=d)j=0;}return y;}),
  follow:vector('follow',(x,att,rel)=>{const y=new Float64Array(x.data.length);let e=0;for(let i=0;i<y.length;i++){const a=x.data[i]>e?att:rel;e=a*e+(1-a)*x.data[i];y[i]=e;}return y;}),
  rise:vector('rise',(x,att)=>{const y=new Float64Array(x.data.length);let s=0;for(let i=0;i<y.length;i++){s=att*s+(1-att)*x.data[i];s=Math.min(s,x.data[i]);y[i]=s;}return y;}),
  release:vector('release',(x,rel)=>{const y=new Float64Array(x.data.length);let s=1;for(let i=0;i<y.length;i++){s=1-(1-s)*rel;s=Math.min(x.data[i],s);y[i]=s;}return y;}),
  fdn:vector('fdn',(xin,B,C,dl,depth,rate,phase,lb0,lb1,la1,hb0,hb1,ha1,nout)=>{
   const N=dl.data.length,nin=xin.shape[0],nc=xin.shape[1],nchannels=C.shape[1];let L=1;
   while(L<Math.floor(Math.max(...dl.data)+Math.max(...depth.data)+8))L*=2;
   const mask=L-1,buf=new Float64Array(N*L),zl=new Float64Array(N),zh=new Float64Array(N),ya=new Float64Array(N),v=new Float64Array(N),out=new Float64Array(nout*nchannels),sc=1/Math.sqrt(N);let w=0;
   for(let i=0;i<nout;i++){
    for(let k=0;k<N;k++){const d=dl.data[k]+depth.data[k]*Math.sin(2*Math.PI*rate.data[k]*i/48000+phase.data[k]),M=Math.floor(d-.5),fd=d-M,eta=(1-fd)/(1+fd),y=eta*buf[k*L+((w-M)&mask)]+buf[k*L+((w-M-1)&mask)]-eta*ya[k];ya[k]=y;const t=lb0.data[k]*y+zl[k];zl[k]=lb1.data[k]*y-la1.data[k]*t;const u=hb0.data[k]*t+zh[k];zh[k]=hb1.data[k]*t-ha1.data[k]*u;v[k]=u;}
    for(let c=0;c<nchannels;c++){let s=0;for(let k=0;k<N;k++)s+=C.data[k*nchannels+c]*v[k];out[i*nchannels+c]=s;}
    for(let h=1;h<N;h*=2)for(let a=0;a<N;a+=2*h)for(let b=a;b<a+h;b++){const p=v[b],q=v[b+h];v[b]=p+q;v[b+h]=p-q;}
    for(let k=0;k<N;k++){let s=v[k]*sc;if(i<nin)for(let c=0;c<nc;c++)s+=B.data[c*N+k]*xin.data[i*nc+c];buf[k*L+(w&mask)]=s;}w++;
   }return out;
  })
 });
})();
