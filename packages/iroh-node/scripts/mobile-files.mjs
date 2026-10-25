import { createHash,randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir,open,rename,rm } from "node:fs/promises";
import { join,resolve } from "node:path";
import { inflateRawSync } from "node:zlib";

/** Build-time only. Each fixed upstream input has an exact size and SHA-256. */
export async function downloadMobileInput(input,directory,signal){
  const destination=resolve(directory);await mkdir(destination,{recursive:true});
  const filename=join(destination,input.sha256);
  try{const hash=createHash("sha256");let bytes=0;for await(const chunk of createReadStream(filename)){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>input.bytes)break;hash.update(chunk);}if(bytes===input.bytes&&hash.digest("hex")===input.sha256)return filename;}catch(error){if(signal?.aborted)throw error;}
  const response=await fetch(input.url,{signal,headers:{"accept-encoding":"identity"}});
  if(!response.ok||!response.body)throw new Error("The fixed native SDK input could not be fetched.");
  const length=response.headers.get("content-length");if(length!==null&&Number(length)!==input.bytes){await response.body.cancel();throw new Error("The fixed native SDK input size changed.");}
  const temporary=`${filename}.${randomUUID()}.partial`;let file;
  try{file=await open(temporary,"wx");const hash=createHash("sha256");let bytes=0;
    for await(const chunk of response.body){signal?.throwIfAborted();bytes+=chunk.length;if(bytes>input.bytes)throw new Error("The fixed native SDK input exceeded its exact size.");hash.update(chunk);await file.writeFile(chunk);}
    if(bytes!==input.bytes||hash.digest("hex")!==input.sha256)throw new Error("The fixed native SDK input failed integrity verification.");
    await file.close();file=undefined;await rename(temporary,filename);return filename;
  }finally{await file?.close();await rm(temporary,{force:true});}
}

/** Extract only selected fixed ZIP entries. No archive paths reach the filesystem. */
export function readMobileZip(bytes,select=()=>true){
  let end=-1;for(let offset=bytes.length-22;offset>=Math.max(0,bytes.length-65557);offset--)if(bytes.readUInt32LE(offset)===0x06054b50){end=offset;break;}
  if(end<0||bytes.readUInt16LE(end+4)!==0||bytes.readUInt16LE(end+6)!==0||bytes.readUInt16LE(end+8)!==bytes.readUInt16LE(end+10))throw new Error("Unsupported fixed SDK ZIP directory.");
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12);let offset=bytes.readUInt32LE(end+16),total=0;
  if(offset+size>end)throw new Error("Invalid fixed SDK ZIP bounds.");const result=new Map();
  for(let index=0;index<count;index++){
    if(offset+46>bytes.length||bytes.readUInt32LE(offset)!==0x02014b50)throw new Error("Invalid fixed SDK ZIP entry.");
    const method=bytes.readUInt16LE(offset+10),compressed=bytes.readUInt32LE(offset+20),uncompressed=bytes.readUInt32LE(offset+24),nameBytes=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42);
    const name=bytes.subarray(offset+46,offset+46+nameBytes).toString("utf8");offset+=46+nameBytes+extra+comment;
    if(name.endsWith("/")||!select(name))continue;
    if(result.has(name)||name.includes("\\")||name.split("/").some(part=>!part||part==="."||part==="..")||local+30>bytes.length||bytes.readUInt32LE(local)!==0x04034b50)throw new Error("Invalid fixed SDK ZIP path.");
    total+=uncompressed;if(uncompressed>128*1024*1024||total>256*1024*1024)throw new Error("The fixed SDK ZIP output exceeded its bound.");
    const data=local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28);
    if(data+compressed>bytes.length)throw new Error("Invalid fixed SDK ZIP data bounds.");
    const packed=bytes.subarray(data,data+compressed);const value=method===0?packed:method===8?inflateRawSync(packed,{maxOutputLength:uncompressed+1}):undefined;
    if(!value||value.length!==uncompressed)throw new Error("Unsupported or malformed fixed SDK ZIP compression.");result.set(name,value);
  }
  return result;
}
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^(0xedb88320&-(value&1));}return(value^0xffffffff)>>>0;}
/** Repackage API classes without the upstream JAR's unrelated desktop natives. */
export function createMobileJar(entries){
  const locals=[],central=[];let offset=0;
  for(const[name,value]of [...entries].sort(([a],[b])=>a.localeCompare(b))){
    const filename=Buffer.from(name),crc=crc32(value),local=Buffer.alloc(30),header=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt16LE(0x21,12);local.writeUInt32LE(crc,14);local.writeUInt32LE(value.length,18);local.writeUInt32LE(value.length,22);local.writeUInt16LE(filename.length,26);
    header.writeUInt32LE(0x02014b50);header.writeUInt16LE(20,4);header.writeUInt16LE(20,6);header.writeUInt16LE(0x800,8);header.writeUInt16LE(0x21,14);header.writeUInt32LE(crc,16);header.writeUInt32LE(value.length,20);header.writeUInt32LE(value.length,24);header.writeUInt16LE(filename.length,28);header.writeUInt32LE(offset,42);
    locals.push(local,filename,value);central.push(header,filename);offset+=local.length+filename.length+value.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.size,8);end.writeUInt16LE(entries.size,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,directory,end]);
}

/** Reject wrong ABI inputs and 64-bit libraries that cannot load on Android16KB. */
export function verifyAndroidLibrary(bytes,abi){
  const machines={"arm64-v8a":183,"armeabi-v7a":40,"x86_64":62,"x86":3},wide=abi==="arm64-v8a"||abi==="x86_64";
  if(bytes.length<64||bytes.readUInt32BE(0)!==0x7f454c46||bytes[4]!== (wide?2:1)||bytes[5]!==1||bytes.readUInt16LE(18)!==machines[abi])throw new Error("The native SDK library does not match its selected Android ABI.");
  if(!wide)return;
  const offset=Number(bytes.readBigUInt64LE(32)),size=bytes.readUInt16LE(54),count=bytes.readUInt16LE(56);
  if(!Number.isSafeInteger(offset)||size<56||count===0||offset+size*count>bytes.length)throw new Error("Invalid fixed Android library program headers.");
  let loads=0;
  for(let index=0;index<count;index++){
    const start=offset+index*size;if(bytes.readUInt32LE(start)!==1)continue;loads++;
    const alignment=bytes.readBigUInt64LE(start+48),file=bytes.readBigUInt64LE(start+8),virtual=bytes.readBigUInt64LE(start+16);
    if(alignment<16384n||(alignment&(alignment-1n))!==0n||file%16384n!==virtual%16384n)throw new Error("The selected native SDK library does not support Android16KB load segment alignment.");
  }
  if(loads===0)throw new Error("The selected native SDK library has no loadable segments.");
}
