import {randomBytes} from 'node:crypto';
import {fetchInstagramVideo,instagramSource} from './instagram-video.mjs';
import {structureTranscript} from './transcript-structure.mjs';
import {transcribeAudio,mediaType,TRANSCRIPTION_MODEL,MAX_MEDIA_BYTES} from './transcription.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
export async function setupTranscriptionJobs({pool,one}){
 for(const [name,type] of [['phase',"VARCHAR(30) NOT NULL DEFAULT ''"],['structure','LONGTEXT NULL'],['analysis_error','TEXT NULL'],['job_token',"VARCHAR(64) NOT NULL DEFAULT ''"]])if(!await one('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',['transcripts',name]))await pool.query(`ALTER TABLE transcripts ADD COLUMN ${name} ${type}`);
}
export function createTranscriptionJobs({one,run,transcribing,apiKey=()=>process.env.OPENAI_API_KEY?.trim(),getVideo=fetchInstagramVideo,transcribe=transcribeAudio,organize=structureTranscript}){
 const publicTranscript=row=>{if(!row)return null;const {job_token,...safe}=row;return safe;};
 async function execute(item,token,upload,analysisOnly){
  const set=(sql,args=[])=>run(`UPDATE transcripts SET ${sql} WHERE item_id=? AND job_token=?`,[...args,item.id,token]);
  try{
   let text=(await one('SELECT text FROM transcripts WHERE item_id=?',[item.id]))?.text||'';
   if(!analysisOnly){
    const media=upload||await getVideo(item.url);
    await set("phase='transcribing',filename=?",[media.filename]);
    const result=await transcribe({...media,apiKey:apiKey()});text=result.text;
    // Commit the original before analysis: an analysis failure never loses or retranscribes it.
    await set("text=?,warning=?,completed_at=?,phase='organizing'",[text,result.warning,new Date().toISOString()]);
   }
   try{const structure=await organize(text,{apiKey:apiKey()});await set("structure=?,state='done',phase='complete',analysis_error='',error=''",[JSON.stringify(structure)]);}
   catch(e){await set("state='done',phase='complete',analysis_error=?,error=''",[e.message||'A organização não foi concluída.']);}
  }catch(e){await set("state=IF(text='','failed','done'),phase='failed',error=?",[e.status?e.message:'Não foi possível concluir. Confira o consumo antes de tentar novamente.']).catch(()=>{});}
  finally{transcribing.delete(item.id);}
 }
 return async function handle({path,req,res,body,send,user}){
  const match=path.match(/^\/api\/items\/(\d+)\/transcription(\/analysis)?$/);if(!match)return false;
  const id=Number(match[1]),item=await one('SELECT * FROM items WHERE id=?',[id]);if(!item)fail('Conteúdo não encontrado.',404);
  const existing=await one('SELECT * FROM transcripts WHERE item_id=?',[id]);
  if(req.method==='GET'&&!match[2]){send(res,200,{transcript:publicTranscript(existing)});return true;}
  if(req.method!=='POST')fail('Ação não encontrada.',404);
  const analysisOnly=!!match[2];
  if(existing?.state==='processing'||transcribing.has(id)){req.resume();send(res,202,{transcript:publicTranscript(existing),processing:true});return true;}
  if((!analysisOnly&&existing?.text)||(analysisOnly&&existing?.structure)){req.resume();send(res,200,{transcript:publicTranscript(existing),cached:true});return true;}
  if(analysisOnly&&!existing?.text)fail('Transcreva o vídeo antes de organizar.');
  if(!apiKey())fail('Conecte sua chave da OpenAI no servidor.',503);
  if(transcribing.size>=2)fail('Há dois vídeos em processamento. Aguarde um instante.',429);
  if(existing&&Date.now()-Date.parse(existing.created_at)<15000)fail('Aguarde alguns segundos antes de tentar novamente.',429);
  transcribing.add(id);let upload;
  try{
   if(req.headers['content-type']?.startsWith('multipart/form-data;')&&!analysisOnly){
    let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>MAX_MEDIA_BYTES+100000)fail('Envie um arquivo de até 24 MB.',413);chunks.push(chunk);}
    let form;try{form=await new Request('http://localhost/upload',{method:'POST',headers:{'Content-Type':req.headers['content-type']},body:Buffer.concat(chunks)}).formData()}catch{fail('Não foi possível ler o arquivo.');}
    const file=form.get('file');if(!file||typeof file.arrayBuffer!=='function')fail('Escolha um arquivo de áudio ou vídeo.');
    upload={buffer:Buffer.from(await file.arrayBuffer()),filename:String(file.name).replace(/[^a-zA-Z0-9._-]/g,'_').slice(-160)};mediaType(upload.filename,upload.buffer);
   }else{const data=await body(req);if(!analysisOnly){if(data?.source!=='instagram')fail('Escolha a transcrição pelo Instagram.');instagramSource(item.url);}}
   const token=randomBytes(24).toString('hex'),now=new Date().toISOString();
   await run("INSERT IGNORE INTO transcripts(item_id,state,text,error,warning,source_url,filename,model,created_at,completed_at,created_by) VALUES(?,'pending','','','',?,'',?,?,'',?)",[id,item.url,TRANSCRIPTION_MODEL,now,user.email]);
   const claim=await run("UPDATE transcripts SET state='processing',phase=?,error='',analysis_error='',job_token=?,created_at=? WHERE item_id=? AND state!='processing'",[analysisOnly?'organizing':upload?'transcribing':'fetching',token,now,id]);
   if(!claim.affectedRows){transcribing.delete(id);send(res,202,{processing:true});return true;}
   send(res,202,{processing:true});void execute(item,token,upload,analysisOnly);return true;
  }catch(e){transcribing.delete(id);throw e;}
 };
}
