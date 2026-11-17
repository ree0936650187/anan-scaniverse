/* ANAN Polycam importer. No network/CDN or external dependency.
 * Supports GLTF 2.0 (.gltf + .bin or data URI), GLB and Polycam ZIP.
 * Geometry only: the existing Black Glass viewer renders meshes without source textures.
 * GLTF's conventional length unit is meters; model scale is initially set to 1000 mm/unit.
 * This scale MUST be verified against a caliper measurement on physical parts.
 */
(function(global){
'use strict';
const utf8=new TextDecoder();
const MAX_ARCHIVE_FILES=700, MAX_GEOMETRY_BYTES=450*1024*1024;
const ext=x=>(x.split('.').pop()||'').toLowerCase();
const normalized=x=>x.replace(/\\/g,'/').replace(/^\.\//,'').replace(/^\/+/, '');
const basename=x=>normalized(x).split('/').pop().toLowerCase();
function pickByPath(files,path){
  let clean=normalized(decodeURIComponent(path.split('?')[0])).toLowerCase();
  let exact=files.find(f=>normalized(f.name).toLowerCase()===clean);
  if(exact)return exact;
  let b=basename(clean),same=files.filter(f=>basename(f.name)===b);
  if(same.length===1)return same[0];
  throw Error('ไม่พบไฟล์ประกอบโมเดล '+path+' — โปรดเลือก .gltf และ .bin พร้อมกัน');
}
async function arraybuf(file){return await file.arrayBuffer();}
async function unzip(file){
  const bytes=new Uint8Array(await arraybuf(file));
  const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const min=Math.max(0,bytes.length-65557);let end=-1;
  for(let i=bytes.length-22;i>=min;i--)if(dv.getUint32(i,true)===0x06054b50){end=i;break;}
  if(end<0)throw Error('ZIP ไม่สมบูรณ์หรือมีรูปแบบที่ไม่รองรับ');
  const n=dv.getUint16(end+10,true),offset=dv.getUint32(end+16,true);
  if(n>MAX_ARCHIVE_FILES)throw Error('ZIP มีไฟล์มากเกินไป');
  const result=[];let p=offset,outputBytes=0;
  for(let i=0;i<n;i++){
    if(p+46>bytes.length||dv.getUint32(p,true)!==0x02014b50)throw Error('ZIP directory ไม่ถูกต้อง');
    const method=dv.getUint16(p+10,true),csize=dv.getUint32(p+20,true),usize=dv.getUint32(p+24,true),len=dv.getUint16(p+28,true),elen=dv.getUint16(p+30,true),clen=dv.getUint16(p+32,true),local=dv.getUint32(p+42,true);
    const flags=dv.getUint16(p+8,true),name=utf8.decode(bytes.subarray(p+46,p+46+len));p+=46+len+elen+clen;
    if(name.endsWith('/')||/^__MACOSX\//i.test(name))continue;
    // Textures, previews and MTL are not needed for geometric measurements.
    if(!['gltf','glb','bin','stl','obj','ply','off'].includes(ext(name)))continue;
    if(flags&1)throw Error('ZIP เข้ารหัส ไม่รองรับ');
    if(usize>MAX_GEOMETRY_BYTES||outputBytes+usize>MAX_GEOMETRY_BYTES)throw Error('ZIP แตกไฟล์ใหญ่เกินขนาดที่ Safari เหมาะสม');
    if(local+30>bytes.length||dv.getUint32(local,true)!==0x04034b50)throw Error('ZIP local header ไม่ถูกต้อง');
    const start=local+30+dv.getUint16(local+26,true)+dv.getUint16(local+28,true),stop=start+csize;
    if(stop>bytes.length)throw Error('ZIP ข้อมูลถูกตัดขาด');
    let payload=bytes.subarray(start,stop),unpacked;
    if(method===0)unpacked=payload;
    else if(method===8){
      if(typeof DecompressionStream==='undefined')throw Error('Safari ต้องอัปเดตเพื่อเปิด ZIP หรือแตกไฟล์ก่อนนำเข้า');
      try{const stream=new Blob([payload]).stream().pipeThrough(new DecompressionStream('deflate-raw'));unpacked=new Uint8Array(await new Response(stream).arrayBuffer());}
      catch(e){throw Error('ไม่สามารถแตก ZIP ใน Safari: '+e.message+' (ลองแตก ZIP ในแอป Files ก่อน)');}
    }else throw Error('ZIP ใช้การบีบอัดที่ไม่รองรับ: '+method);
    if(unpacked.length!==usize)throw Error('ZIP ความยาวไม่ตรงกับข้อมูลในไฟล์');
    outputBytes+=usize;
    result.push({name:normalized(name),arrayBuffer:async()=>unpacked.buffer.slice(unpacked.byteOffset,unpacked.byteOffset+unpacked.byteLength),text:async()=>utf8.decode(unpacked)});
  }
  return result;
}
function byteDataUri(uri){
  const comma=uri.indexOf(','),meta=uri.slice(0,comma),body=uri.slice(comma+1);
  if(comma<0)throw Error('data URI ไม่ถูกต้อง');
  if(meta.includes(';base64')){const raw=atob(body),b=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)b[i]=raw.charCodeAt(i);return b.buffer;}
  return new TextEncoder().encode(decodeURIComponent(body)).buffer;
}
const identity=()=>[1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
function matmul(a,b){const r=new Array(16).fill(0);for(let c=0;c<4;c++)for(let row=0;row<4;row++)for(let k=0;k<4;k++)r[c*4+row]+=a[k*4+row]*b[c*4+k];return r;}
function localMatrix(node){
  if(node.matrix)return node.matrix;
  const [x,y,z,w]=node.rotation||[0,0,0,1],t=node.translation||[0,0,0],s=node.scale||[1,1,1];
  const xx=x*x,yy=y*y,zz=z*z,xy=x*y,xz=x*z,yz=y*z,wx=w*x,wy=w*y,wz=w*z;
  return [(1-2*(yy+zz))*s[0],2*(xy+wz)*s[0],2*(xz-wy)*s[0],0,
  2*(xy-wz)*s[1],(1-2*(xx+zz))*s[1],2*(yz+wx)*s[1],0,
  2*(xz+wy)*s[2],2*(yz-wx)*s[2],(1-2*(xx+yy))*s[2],0,
  t[0],t[1],t[2],1];
}
function transform(p,m){const x=p[0],y=p[1],z=p[2];let w=m[3]*x+m[7]*y+m[11]*z+m[15];w=w||1;return [(m[0]*x+m[4]*y+m[8]*z+m[12])/w,(m[1]*x+m[5]*y+m[9]*z+m[13])/w,(m[2]*x+m[6]*y+m[10]*z+m[14])/w];}
async function meshFromGLTF(doc,files,glbBin){
  if(doc.asset?.version!=='2.0')throw Error('รองรับ GLTF 2.0 เท่านั้น');
  if(doc.extensionsRequired?.length)throw Error('ไฟล์นี้ใช้ส่วนขยาย GLTF ที่ยังไม่รองรับ: '+doc.extensionsRequired.join(', '));
  let bins=[];
  for(let i=0;i<(doc.buffers||[]).length;i++){
    const b=doc.buffers[i];let data;
    if(b.uri?.startsWith('data:'))data=byteDataUri(b.uri);
    else if(b.uri)data=await arraybuf(pickByPath(files,b.uri));
    else if(i===0&&glbBin)data=glbBin;
    else throw Error('GLTF ไม่มีข้อมูล buffer หมายเลข '+i);
    if(data.byteLength<b.byteLength)throw Error('ข้อมูล GLTF buffer สั้นกว่าที่ระบุ');
    bins.push(new DataView(data));
  }
  const specs={5120:[1,'getInt8'],5121:[1,'getUint8'],5122:[2,'getInt16'],5123:[2,'getUint16'],5125:[4,'getUint32'],5126:[4,'getFloat32']};
  function accessor(i){
    const a=doc.accessors?.[i];if(!a||a.bufferView===undefined||a.sparse)throw Error('GLTF accessor แบบ sparse/ไม่มี bufferView ยังไม่รองรับ');
    const v=doc.bufferViews[a.bufferView],buf=bins[v.buffer];if(!buf)throw Error('ไม่พบ GLTF buffer');
    const spec=specs[a.componentType],components={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type];
    if(!spec||!components)throw Error('ชนิดข้อมูล GLTF ไม่รองรับ');
    const [unit,read]=spec,step=v.byteStride||components*unit,at=(v.byteOffset||0)+(a.byteOffset||0),data=[];
    if(a.count*components>25000000)throw Error('โมเดลใหญ่เกินหน่วยความจำ Safari');
    for(let k=0;k<a.count;k++)for(let c=0;c<components;c++){
      const off=at+k*step+c*unit;if(off+unit>buf.byteLength)throw Error('GLTF accessor out of bounds');
      let val=buf[read](off,true);
      if(a.normalized&&a.componentType!==5126){
        if(a.componentType===5120)val=Math.max(-1,val/127); else if(a.componentType===5121)val/=255;
        else if(a.componentType===5122)val=Math.max(-1,val/32767); else if(a.componentType===5123)val/=65535; else if(a.componentType===5125)val/=4294967295;
      }
      data.push(val);
    }
    return {data,count:a.count,components};
  }
  let vertices=[],faces=[];
  function addMesh(index,world){
    const primitives=doc.meshes?.[index]?.primitives||[];
    for(let prim of primitives){
      if(prim.mode!==undefined&&prim.mode!==4)continue;
      if(prim.attributes?.POSITION===undefined)continue;
      const positions=accessor(prim.attributes.POSITION);
      if(positions.components!==3)throw Error('GLTF POSITION ต้องเป็น VEC3');
      const base=vertices.length/3;
      for(let i=0;i<positions.count;i++)vertices.push(...transform(positions.data.slice(i*3,i*3+3),world));
      let inds=prim.indices===undefined?Array.from({length:positions.count},(_,i)=>i):accessor(prim.indices).data;
      if(inds.length%3)throw Error('GLTF triangle indices ไม่ครบ');
      for(let i of inds)if(!Number.isInteger(i)||i<0||i>=positions.count)throw Error('GLTF triangle index เกินขอบเขต');
      for(let i of inds)faces.push(base+i);
    }
  }
  const nodes=doc.nodes||[];
  if(nodes.length){
    const scene=doc.scenes?.[doc.scene||0];
    let roots=scene?.nodes;
    if(!roots){let childSet=new Set(nodes.flatMap(n=>n.children||[]));roots=nodes.map((_,i)=>i).filter(i=>!childSet.has(i));}
    let visited=0;
    function walk(idx,parent,path){
      if(path.includes(idx)||++visited>100000)throw Error('GLTF node graph ไม่ถูกต้อง');
      const node=nodes[idx];if(!node)throw Error('GLTF node index ผิด');
      const world=matmul(parent,localMatrix(node));
      if(node.mesh!==undefined)addMesh(node.mesh,world);
      for(let c of node.children||[])walk(c,world,[...path,idx]);
    }
    for(let id of roots)walk(id,identity(),[]);
  }else for(let i=0;i<(doc.meshes||[]).length;i++)addMesh(i,identity());
  if(!faces.length)throw Error('ไม่พบตาข่ายสามเหลี่ยมใน GLTF (อาจเป็น Gaussian Splat/Draco ที่ไม่รองรับ)');
  return global.ANANMesh.ensureModel({vertices:new Float32Array(vertices),indices:new Uint32Array(faces)});
}
function readGLB(arraybuffer){
  const dv=new DataView(arraybuffer);if(dv.byteLength<20||dv.getUint32(0,true)!==0x46546c67)throw Error('GLB ไม่ถูกต้อง');
  if(dv.getUint32(4,true)!==2)throw Error('รองรับ GLB 2.0');
  let p=12,doc=null,bin=null;
  while(p+8<=dv.byteLength){const len=dv.getUint32(p,true),type=dv.getUint32(p+4,true);p+=8;if(p+len>dv.byteLength)throw Error('GLB ถูกตัดขาด');
    if(type===0x4e4f534a)doc=JSON.parse(utf8.decode(new Uint8Array(arraybuffer,p,len)));
    if(type===0x004e4942)bin=arraybuffer.slice(p,p+len);p+=len;
  }
  if(!doc)throw Error('GLB ไม่มีข้อมูล GLTF');return {doc,bin};
}
async function importFiles(input){
  if(!input?.length)throw Error('ยังไม่ได้เลือกไฟล์โมเดล');
  let items=Array.from(input);
  if(items.some(x=>ext(x.name)==='zip')){
    let zip=items.find(x=>ext(x.name)==='zip');items=await unzip(zip);
  }
  const gltf=items.find(x=>ext(x.name)==='gltf'),glb=items.find(x=>ext(x.name)==='glb');
  if(gltf){const doc=JSON.parse(await gltf.text());return {model:await meshFromGLTF(doc,items,null),scale:1000,format:'GLTF',note:'สเกลตั้งต้นอิงมาตรฐาน GLTF = เมตร โปรดตรวจสอบด้วยเวอร์เนียร์'};}
  if(glb){const {doc,bin}=readGLB(await glb.arrayBuffer());return {model:await meshFromGLTF(doc,items,bin),scale:1000,format:'GLB',note:'สเกลตั้งต้นอิงมาตรฐาน GLTF = เมตร โปรดตรวจสอบด้วยเวอร์เนียร์'};}
  const model=items.find(x=>['stl','obj','ply','off'].includes(ext(x.name)));
  if(model)return {model:await global.ANANMesh.readModel({name:basename(model.name),arrayBuffer:()=>model.arrayBuffer()}),scale:null,format:ext(model.name).toUpperCase(),note:'ไฟล์นี้ไม่ระบุหน่วยอย่างแน่นอน ต้องปรับสเกลก่อนส่งออก'};
  throw Error('ไม่พบไฟล์ .gltf / .glb / .stl / .obj / .ply ในชุดที่เลือก');
}
global.ANANPolycam={importFiles,unzip,meshFromGLTF};
})(typeof window==='undefined'?globalThis:window);
