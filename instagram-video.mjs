import {MAX_MEDIA_BYTES,mediaType} from './transcription.mjs';
const failure=(message,status=422)=>Object.assign(new Error(message),{status});
export function instagramSource(value){
 let u;try{u=new URL(value)}catch{throw failure('Esta referência não tem um link válido do Instagram.');}
 const m=u.pathname.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?$/);
 if(u.protocol!=='https:'||!['instagram.com','www.instagram.com','m.instagram.com'].includes(u.hostname)||u.port||u.username||u.password||!m)throw failure('Use o link de uma publicação do Instagram.');
 return {url:`https://www.instagram.com/${m[1]==='reels'?'reel':m[1]}/${m[2]}/`,code:m[2]};
}
export function mediaUrl(value){let u;try{u=new URL(value)}catch{throw failure('O Instagram não disponibilizou o arquivo deste vídeo.');}if(u.protocol!=='https:'||u.port||u.username||u.password||!['.cdninstagram.com','.fbcdn.net'].some(s=>u.hostname.endsWith(s)))throw failure('Endereço de vídeo não permitido.');return u.href;}
export function extractVideo(html,code){
 let found;let visited=0;
 function walk(o,depth=0){if(found||!o||depth>25||++visited>40000)return;if(typeof o==='string'&&o.includes('video_url')){try{walk(JSON.parse(o),depth+1)}catch{}return;}if(typeof o!=='object')return;
  if(o.shortcode===code&&o.is_video===true&&typeof o.video_url==='string'){found={url:mediaUrl(o.video_url),duration:Number(o.video_duration)||null};return;}
  for(const v of Object.values(o))walk(v,depth+1);
 }
 for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)){
  const script=match[1];if(!script.includes('video_url'))continue;
  try{walk(JSON.parse(script))}catch{}
  // Instagram also serializes metadata as a JSON string in a script. Never execute it.
  for(const token of script.matchAll(/"(?:\\.|[^"\\])*"/g)){if(!token[0].includes('video_url'))continue;try{walk(JSON.parse(token[0]))}catch{}}
  if(found)return found;
 }
 throw failure('O Instagram não liberou o vídeo para leitura automática. Você pode enviar o arquivo abaixo.');
}
async function download(url,limit,timeout,fetchImpl){
 const response=await fetchImpl(url,{redirect:'error',signal:AbortSignal.timeout(timeout),headers:{'User-Agent':'Mozilla/5.0 (compatible; TassitaniContent/1.0)'}});
 if(!response.ok)throw failure('O Instagram não liberou este vídeo agora. Tente novamente mais tarde ou envie o arquivo.');
 if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw failure('Vídeo grande demais. Envie apenas o áudio ou um trecho de até 24 MB.');}
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw failure('Vídeo grande demais. Envie apenas o áudio ou um trecho de até 24 MB.');chunks.push(value);}}catch(e){await reader.cancel();throw e;}finally{reader.releaseLock();}
 return Buffer.concat(chunks);
}
export async function fetchInstagramVideo(value,{fetchImpl=fetch}={}){
 const source=instagramSource(value);let video;
 try{const html=await download(source.url+'embed/',3_000_000,20000,fetchImpl);video=extractVideo(html.toString('utf8'),source.code);}catch(e){throw e.status?e:failure('Não foi possível acessar o vídeo no Instagram. Tente mais tarde ou envie o arquivo.');}
 if(video.duration>600)throw failure('Para vídeos com mais de 10 minutos, envie o áudio em trechos menores.');
 let buffer;try{buffer=await download(video.url,MAX_MEDIA_BYTES,60000,fetchImpl)}catch(e){throw e.status?e:failure('O download do vídeo não terminou. Tente novamente ou envie o arquivo.');}
 const filename=source.code+'.mp4';mediaType(filename,buffer);return {buffer,filename,source_url:source.url};
}
