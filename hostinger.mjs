import {setupInstagram,createInstagram} from './insta-analytics.mjs';
import {setupTeam,createTeam} from './team-workspace.mjs';
import {setupTranscriptionJobs,createTranscriptionJobs} from './transcription-jobs.mjs';
import {setupPageReferences,handlePageReferences} from './page-references.mjs';
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {creatorFromHtml,normalizeCreator} from './reference-metadata.mjs';
import {createAuth,OWNER} from './auth.mjs';
import {readFileSync,existsSync} from 'node:fs';
import {dirname,join,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import mysql from 'mysql2/promise';
import {parsePublicMetrics} from './public-metrics.mjs';
import {transcribeAudio,mediaType,TRANSCRIPTION_MODEL,MAX_MEDIA_BYTES} from './transcription.mjs';

const root=dirname(fileURLToPath(import.meta.url));
const required=['MYSQL_HOST','MYSQL_DATABASE','MYSQL_USER','MYSQL_PASSWORD'];
const missing=required.filter(k=>!process.env[k]?.trim());
if(missing.length)throw new Error(`Variáveis ausentes: ${missing.join(', ')}`);
const pool=mysql.createPool({host:process.env.MYSQL_HOST,port:Number(process.env.MYSQL_PORT||3306),database:process.env.MYSQL_DATABASE,user:process.env.MYSQL_USER,password:process.env.MYSQL_PASSWORD,waitForConnections:true,connectionLimit:5,charset:'utf8mb4'});
const one=async(sql,args=[])=>{const [rows]=await pool.execute(sql,args);return rows[0]||null};
const all=async(sql,args=[])=>{const [rows]=await pool.execute(sql,args);return rows};
const run=async(sql,args=[])=>{const [result]=await pool.execute(sql,args);return result};
const tx=async fn=>{const c=await pool.getConnection();try{await c.beginTransaction();const result=await fn(c);await c.commit();return result}catch(e){await c.rollback();throw e}finally{c.release()}};
const cats=['carrosseis','reels','react','mindset','formatos'];
const statuses=['pending','producing','done'];

async function setup(){
 await pool.query(`CREATE TABLE IF NOT EXISTS meta (\`key\` VARCHAR(100) PRIMARY KEY,value TEXT NOT NULL) CHARACTER SET utf8mb4`);
 await pool.query(`CREATE TABLE IF NOT EXISTS items (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,title VARCHAR(1000) NOT NULL,notes LONGTEXT NOT NULL,url VARCHAR(700) NOT NULL DEFAULT '',category VARCHAR(30) NOT NULL,status VARCHAR(30) NOT NULL DEFAULT 'pending',thumbnail VARCHAR(255) NOT NULL DEFAULT '',source VARCHAR(255) NOT NULL DEFAULT '',source_url VARCHAR(700) NOT NULL DEFAULT '',created_at VARCHAR(40) NOT NULL,updated_at VARCHAR(40) NOT NULL,version INT NOT NULL DEFAULT 1,template_name VARCHAR(255) NOT NULL DEFAULT '',visual_description LONGTEXT NOT NULL,visual_basis VARCHAR(500) NOT NULL DEFAULT '',template_slides LONGTEXT NOT NULL,INDEX idx_category_status(category,status)) CHARACTER SET utf8mb4`);
 await pool.query(`CREATE TABLE IF NOT EXISTS transcripts (item_id INT UNSIGNED PRIMARY KEY,state VARCHAR(30) NOT NULL,text LONGTEXT NOT NULL,error TEXT NOT NULL,warning TEXT NOT NULL,source_url VARCHAR(700) NOT NULL,filename VARCHAR(255) NOT NULL,model VARCHAR(100) NOT NULL,created_at VARCHAR(40) NOT NULL,completed_at VARCHAR(40) NOT NULL) CHARACTER SET utf8mb4`);
 await pool.query(`CREATE TABLE IF NOT EXISTS public_metrics (item_id INT UNSIGNED PRIMARY KEY,likes BIGINT NULL,comments BIGINT NULL,shares BIGINT NULL,approximate TINYINT NOT NULL DEFAULT 0,checked_at VARCHAR(40) NOT NULL,state VARCHAR(30) NOT NULL) CHARACTER SET utf8mb4`);
 await pool.query(`CREATE TABLE IF NOT EXISTS media (name VARCHAR(80) PRIMARY KEY,mime VARCHAR(30) NOT NULL,body MEDIUMBLOB NOT NULL,created_at VARCHAR(40) NOT NULL) CHARACTER SET utf8mb4`);
 if(!await one('SELECT 1 FROM meta WHERE `key`=?',['seeded']))await tx(async c=>{
  const seed=JSON.parse(readFileSync(join(root,'seed.json'),'utf8'));
  const templates=JSON.parse(readFileSync(join(root,'templates.json'),'utf8'));
  const metrics=JSON.parse(readFileSync(join(root,'seed-metrics.json'),'utf8'));
  const now=new Date().toISOString();
  for(const i of seed){
   const t=templates.find(t=>t.source_url===i.source_url&&shortcode(t.url)===shortcode(i.url)&&t.title===i.title);
   await c.execute('INSERT INTO items(title,notes,url,category,thumbnail,source,source_url,created_at,updated_at,template_name,visual_description,visual_basis,template_slides) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',[i.title,i.notes,i.url,i.category,i.thumbnail||'',i.source||'',i.source_url||'',now,now,t?.template_name||'',t?.visual_description||'',t?.visual_basis||'',JSON.stringify(t?.slides||[])]);
  }
  const [rows]=await c.execute('SELECT id,url FROM items');
  for(const m of metrics)for(const i of rows.filter(i=>i.url===m.url))await c.execute('INSERT IGNORE INTO public_metrics VALUES(?,?,?,?,?,?,?)',[i.id,m.likes,m.comments,null,Number(m.approximate),m.checked_at,m.state]);
  await c.execute('INSERT INTO meta(`key`,value) VALUES(?,?)',['seeded','1']);
 });
 for(const table of ['items','media','transcripts']){
  const column=await one('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',[table,'created_by']);
  if(!column)await pool.query(`ALTER TABLE ${table} ADD COLUMN created_by VARCHAR(190) NOT NULL DEFAULT ''`);
 }
 for(const [name,type] of [['creator_handle',"VARCHAR(30) NOT NULL DEFAULT ''"],['metadata_checked_at',"VARCHAR(40) NOT NULL DEFAULT ''"]]){
  if(!await one('SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',['items',name]))await pool.query(`ALTER TABLE items ADD COLUMN ${name} ${type}`);
 }
 if(!await one('SELECT 1 FROM meta WHERE `key`=?',['creators-2026-09-22'])){
  const references=await all("SELECT id,url FROM items WHERE creator_handle=''");
  for(const item of JSON.parse(readFileSync(join(root,'verified-creators.json'),'utf8'))){
   for(const reference of references.filter(r=>shortcode(r.url)===item.shortcode))await run("UPDATE items SET creator_handle=?,version=version+1 WHERE id=? AND creator_handle=''",[item.creator_handle,reference.id]);
  }
  await run('INSERT INTO meta(`key`,value) VALUES(?,?)',['creators-2026-09-22','1']);
 }
 await run("UPDATE transcripts SET state='failed',error=? WHERE state='processing'",['O servidor reiniciou antes de confirmar a transcrição. Consulte o consumo antes de tentar novamente.']);
}
function shortcode(url){try{return new URL(url).pathname.split('/')[2]}catch{return ''}}
function fail(message,status=400){throw Object.assign(new Error(message),{status})}
export function normalizeUrl(value){if(!value)return '';try{const u=new URL(value);if(u.protocol!=='https:'||!['instagram.com','www.instagram.com','m.instagram.com'].includes(u.hostname))fail('Use um link válido do Instagram.');const m=u.pathname.match(/^\/(p|reel|reels|tv)\/([\w-]+)\/?$/);if(!m)fail('Cole o link de uma publicação ou reel.');return `https://www.instagram.com/${m[1]==='reels'?'reel':m[1]}/${m[2]}/`;}catch{fail('Use um link de publicação do Instagram (https://www.instagram.com/p/... ou /reel/...).')}}
function validate(v){if(!v||typeof v!=='object')fail('Conteúdo inválido.');if(!cats.includes(v.category)||!statuses.includes(v.status||'pending'))fail('Categoria ou andamento inválido.');const title=String(v.title|| (v.url?'Referência '+(shortcode(v.url)||'Instagram'):'')).trim(),notes=String(v.notes||'');if(!title||title.length>1000||notes.length>30000)fail('Informe um título de até 1.000 caracteres e ideias de até 30.000.');const template_name=String(v.template_name||'').trim(),visual_description=String(v.visual_description||''),visual_basis=String(v.visual_basis||'');if(template_name.length>200||visual_description.length>12000||visual_basis.length>300)fail('Nome ou descrição visual muito longos.');let creator_handle;try{creator_handle=normalizeCreator(v.creator_handle)}catch{fail('Informe um @ válido do Instagram (até 30 caracteres).')}return {creator_handle,title,notes,url:normalizeUrl(v.url),category:v.category,status:v.status||'pending',template_name,visual_description,visual_basis}}
async function body(req){let raw='';for await(const c of req){raw+=c;if(raw.length>8e6)fail('Arquivo ou lote muito grande.',413)}try{return JSON.parse(raw)}catch{fail('Dados inválidos.')}}
function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
async function boundedFetch(url,maxBytes){const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(12000),headers:{'User-Agent':'Mozilla/5.0 (compatible; TassitaniContent/1.0)'}});if(!r.ok)throw new Error('Metadata unavailable');const chunks=[];let size=0;for await(const chunk of r.body){size+=chunk.length;if(size>maxBytes)throw new Error('Response too large');chunks.push(chunk)}return {buffer:Buffer.concat(chunks),type:r.headers.get('content-type')||''}}

const metricsJobs=new Set(),transcribing=new Set(),thumbnailQueue=new Set();let thumbnailRunning=false;
const transcriptFor=id=>one('SELECT * FROM transcripts WHERE item_id=?',[id]);
async function fetchThumbnail(id){try{const i=await one('SELECT * FROM items WHERE id=?',[id]);if(!i||!i.url)return;let buffer;try{({buffer}=await boundedFetch(normalizeUrl(i.url),2500000))}catch{({buffer}=await boundedFetch(normalizeUrl(i.url)+'embed/',2500000))}let creator=creatorFromHtml(buffer.toString('utf8'));if(!creator){try{const embedded=await boundedFetch(normalizeUrl(i.url)+'embed/',2500000);creator=creatorFromHtml(embedded.buffer.toString('utf8'))}catch{}}if(creator)await run("UPDATE items SET creator_handle=?,version=version+1 WHERE id=? AND url=? AND creator_handle=''",[creator,id,i.url]);if(i.thumbnail)return;const tags=buffer.toString('utf8').match(/<meta\s[^>]+>/gi)||[];let imageUrl='';for(const tag of tags)if(/(?:property|name)=["']og:image["']/i.test(tag)){imageUrl=tag.match(/content=["']([^"']+)["']/i)?.[1]||'';break}imageUrl=imageUrl.replace(/&amp;/g,'&').replace(/&#38;/g,'&');if(!imageUrl)return;const u=new URL(imageUrl);if(u.protocol!=='https:'||u.port||u.username||u.password||!(u.hostname.endsWith('.cdninstagram.com')||u.hostname.endsWith('.fbcdn.net')))return;const image=await boundedFetch(u.href,5000000);if(!image.type.startsWith('image/'))return;const b=image.buffer;const ext=b[0]===255&&b[1]===216?'jpeg':b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'png':b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'?'webp':null;if(!ext)return;const name=randomBytes(16).toString('hex')+'.'+ext;await run('INSERT INTO media(name,mime,body,created_at,created_by) VALUES(?,?,?,?,?)',[name,'image/'+(ext==='jpeg'?'jpeg':ext),b,new Date().toISOString(),i.created_by||OWNER]);await run("UPDATE items SET thumbnail=? WHERE id=? AND thumbnail='' AND url=?",['/uploads/'+name,id,i.url])}catch{}}
async function enqueueThumbnails(){for(const i of await all("SELECT id FROM items WHERE (thumbnail='' OR creator_handle='') AND (metadata_checked_at='' OR metadata_checked_at<?) AND url!=''",[new Date(Date.now()-86400000).toISOString()]))thumbnailQueue.add(i.id);void processThumbnails()}
async function processThumbnails(){if(thumbnailRunning)return;thumbnailRunning=true;try{while(thumbnailQueue.size){const ids=[...thumbnailQueue].slice(0,2);ids.forEach(id=>thumbnailQueue.delete(id));await Promise.allSettled(ids.map(async id=>{try{await fetchThumbnail(id)}finally{await run('UPDATE items SET metadata_checked_at=? WHERE id=?',[new Date().toISOString(),id])}}))}}finally{thumbnailRunning=false}}

await setup();await setupTranscriptionJobs({pool,one});const handleTranscription=createTranscriptionJobs({one,run,transcribing});await setupPageReferences({pool,one,run,root});const auth=await createAuth({pool,one,run});await setupTeam({pool});await setupInstagram({pool});const handleInstagram=createInstagram({pool,one,all,run,send,body});const handleTeam=createTeam({all,one,run,pool,body,send});setTimeout(enqueueThumbnails,1000).unref();setInterval(()=>{void enqueueThumbnails().catch(()=>{})},3600000).unref();
const server=http.createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://localhost').pathname;res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('X-Frame-Options','SAMEORIGIN');
 const user=await auth.user(req);
 if(path.startsWith('/api/')){
  if(req.method!=='GET'){if(req.headers['content-type']!=='application/json'&&!(req.method==='POST'&&/^\/api\/items\/\d+\/transcription$/.test(path)&&req.headers['content-type']?.startsWith('multipart/form-data;')))fail('Formato não permitido.',415);const origin=req.headers.origin;if(origin&&new URL(origin).host!==req.headers.host)fail('Origem não permitida.',403)}
  if(path==='/api/session'&&req.method==='GET')return send(res,200,{editor:!!user,user,...auth.config()});
  if(path==='/api/auth/challenge'&&req.method==='GET')return send(res,200,await auth.challenge(res));
  if(path==='/api/auth/google'&&req.method==='POST'){const b=await body(req);if(typeof b.credential!=='string'||b.credential.length>12000)fail('Login inválido.');return send(res,200,await auth.googleLogin(req,res,b.credential));}
  if(path==='/api/login'&&req.method==='POST')return send(res,200,await auth.passwordLogin(req,res,await body(req)));
  if(path==='/api/logout'&&req.method==='POST')return send(res,200,await auth.logout(req,res));
  if(await handlePageReferences({path,req,res,user,all,one,run,body,send}))return;
  if(!user)fail('Entre na sua conta para acessar a central.',401);
  if(await handleTeam({path,req,res,user}))return;
  if(await handleInstagram({path,req,res,user}))return;
  if(path==='/api/items'&&req.method==='GET')return send(res,200,await all("SELECT items.*,COALESCE(transcripts.state,'') AS transcription_state,public_metrics.likes,public_metrics.comments,public_metrics.shares,public_metrics.approximate AS metrics_approximate,public_metrics.checked_at AS metrics_checked_at,public_metrics.state AS metrics_state FROM items LEFT JOIN transcripts ON transcripts.item_id=items.id LEFT JOIN public_metrics ON public_metrics.item_id=items.id ORDER BY items.id DESC"));
  if(path==='/api/export'&&req.method==='GET')return send(res,200,{exported_at:new Date().toISOString(),items:await all('SELECT * FROM items ORDER BY id'),transcripts:await all('SELECT * FROM transcripts ORDER BY item_id'),public_metrics:await all('SELECT * FROM public_metrics ORDER BY item_id')});
  if(path==='/api/transcription-config'&&req.method==='GET')return send(res,200,{configured:!!process.env.OPENAI_API_KEY?.trim(),model:TRANSCRIPTION_MODEL,max_bytes:MAX_MEDIA_BYTES,automatic:true});
  if(await handleTranscription({path,req,res,body,send,user}))return;
  const mm=path.match(/^\/api\/items\/(\d+)\/metrics$/);
  if(mm&&req.method==='POST'){const id=Number(mm[1]),item=await one('SELECT * FROM items WHERE id=?',[id]);if(!item)fail('Conteúdo não encontrado.',404);if(!item.url)fail('Este conteúdo não tem um link do Instagram.');const previous=await one('SELECT * FROM public_metrics WHERE item_id=?',[id]);if(previous&&Date.now()-Date.parse(previous.checked_at)<900000)return send(res,200,{metrics:previous,cached:true});if(metricsJobs.has(id)||metricsJobs.size>=2)fail('Há uma consulta em andamento. Aguarde um instante.',429);metricsJobs.add(id);try{let result={likes:null,comments:null,shares:null,approximate:false},state='unavailable';try{const page=await boundedFetch(normalizeUrl(item.url),2500000);result=parsePublicMetrics(page.buffer.toString('utf8'));if(result.likes!==null||result.comments!==null)state='available'}catch{}if((await one('SELECT url FROM items WHERE id=?',[id]))?.url!==item.url)fail('O conteúdo mudou durante a consulta. Atualize a página.',409);await run('INSERT INTO public_metrics VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE likes=VALUES(likes),comments=VALUES(comments),shares=VALUES(shares),approximate=VALUES(approximate),checked_at=VALUES(checked_at),state=VALUES(state)',[id,result.likes,result.comments,null,Number(result.approximate),new Date().toISOString(),state]);return send(res,200,{metrics:await one('SELECT * FROM public_metrics WHERE item_id=?',[id])})}finally{metricsJobs.delete(id)}}
  if(path==='/api/items'&&req.method==='POST'){const b=await body(req);if(!Array.isArray(b.items)||!b.items.length||b.items.length>500)fail('Envie entre 1 e 500 conteúdos por lote.');const values=b.items.map(validate);let created=0,duplicates=0;await tx(async c=>{for(const v of values){const code=shortcode(v.url);const [sameRows]=await c.execute('SELECT url FROM items WHERE category=?',[v.category]);if(code&&sameRows.some(i=>shortcode(i.url)===code)){duplicates++;continue}const now=new Date().toISOString();const [result]=await c.execute("INSERT INTO items(title,notes,url,category,status,created_at,updated_at,template_name,visual_description,visual_basis,template_slides,created_by,creator_handle) VALUES(?,?,?,?,?,?,?,?,?,?, '[]',?,?)",[v.title,v.notes,v.url,v.category,v.status,now,now,v.template_name,v.visual_description,v.visual_basis,user.email,v.creator_handle]);if(v.category==='carrosseis'&&!v.template_name)await c.execute('UPDATE items SET template_name=? WHERE id=?',['CARR-N'+result.insertId+' · '+v.title.slice(0,150),result.insertId]);created++}});void enqueueThumbnails();return send(res,201,{created,duplicates})}
  const im=path.match(/^\/api\/items\/(\d+)(\/thumbnail)?$/);
  if(im){const id=Number(im[1]),current=await one('SELECT * FROM items WHERE id=?',[id]);if(!current)fail('Conteúdo não encontrado.',404);if(im[2]&&req.method==='POST'){const b=await body(req),m=String(b.image||'').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);if(!m)fail('Use uma imagem PNG, JPEG ou WebP.');const buf=Buffer.from(m[2],'base64');if(buf.length>5e6)fail('A capa deve ter até 5 MB.');const valid=m[1]==='png'?buf.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):m[1]==='jpeg'?buf[0]===255&&buf[1]===216&&buf[2]===255:buf.toString('ascii',0,4)==='RIFF'&&buf.toString('ascii',8,12)==='WEBP';if(!valid)fail('Imagem inválida.');const name=randomBytes(16).toString('hex')+'.'+m[1];await run('INSERT INTO media(name,mime,body,created_at,created_by) VALUES(?,?,?,?,?)',[name,'image/'+m[1],buf,new Date().toISOString(),user.email]);await run('UPDATE items SET thumbnail=?,version=version+1,updated_at=? WHERE id=?',['/uploads/'+name,new Date().toISOString(),id]);return send(res,200,{ok:true})}if(req.method==='PUT'){const b=await body(req),v=validate({...current,...b,creator_handle:b.url!==undefined&&normalizeUrl(b.url)!==current.url?(b.creator_handle||''):(b.creator_handle??current.creator_handle)});if(v.url!==normalizeUrl(current.url)&&(transcribing.has(id)||['done','processing'].includes((await transcriptFor(id))?.state)||(await transcriptFor(id))?.text))fail('Este conteúdo tem uma transcrição vinculada. Para outro vídeo, crie um novo conteúdo.',409);if(b.version!==current.version)fail('Este conteúdo mudou em outra tela. Feche e abra novamente antes de salvar.',409);const updated=await run('UPDATE items SET title=?,notes=?,url=?,category=?,status=?,template_name=?,visual_description=?,visual_basis=?,creator_handle=?,version=version+1,updated_at=? WHERE id=? AND version=?',[v.title,v.notes,v.url,v.category,v.status,v.template_name,v.visual_description,v.visual_basis,v.creator_handle,new Date().toISOString(),id,b.version]);if(updated.affectedRows!==1)fail('Este conteúdo mudou em outra tela. Feche e abra novamente antes de salvar.',409);if(v.url!==normalizeUrl(current.url)){await run('DELETE FROM public_metrics WHERE item_id=?',[id]);await run("UPDATE items SET thumbnail='',template_slides='[]',metadata_checked_at='' WHERE id=?",[id]);void enqueueThumbnails()}return send(res,200,{ok:true})}if(req.method==='DELETE'){if(transcribing.has(id))fail('Aguarde a transcrição terminar antes de excluir.',409);await tx(async c=>{await c.execute('DELETE FROM public_metrics WHERE item_id=?',[id]);await c.execute('DELETE FROM transcripts WHERE item_id=?',[id]);await c.execute('DELETE FROM items WHERE id=?',[id])});return send(res,200,{ok:true})}}
  fail('Ação não encontrada.',404)
 }
 if(req.method!=='GET'&&req.method!=='HEAD')fail('Método não permitido.',405);
 const assets={'/':'index.html','/app.js':'app.js','/filters.js':'filters.js','/insta-analytics.js':'insta-analytics.js','/style.css':'style.css','/favicon.svg':'favicon.svg'};let file=assets[path]?join(root,'public',assets[path]):null;
 if(/^\/uploads\/[a-f0-9]{32}\.(png|jpeg|webp)$/.test(path)){if(!user)fail('Entre para visualizar os materiais.',401);const name=path.split('/').pop(),stored=await one('SELECT mime,body FROM media WHERE name=?',[name]);if(stored){res.writeHead(200,{'Content-Type':stored.mime,'Cache-Control':'private,no-store'});return res.end(req.method==='HEAD'?undefined:stored.body)}const seed=join(root,'seed-assets',name);if(existsSync(seed))file=seed}
 if(!file||!existsSync(file))fail('Página não encontrada.',404);const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpeg':'image/jpeg','.webp':'image/webp'};res.writeHead(200,{'Content-Type':types[extname(file)],'Cache-Control':path.startsWith('/uploads/')?'private,no-store':'no-cache'});res.end(req.method==='HEAD'?undefined:readFileSync(file))
}catch(e){if(!e.status)console.error(e);send(res,e.status||500,{error:e.status?e.message:'Não foi possível salvar. Tente novamente.'})}});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'0.0.0.0',()=>console.log(`Central Tassitani pronta na porta ${process.env.PORT||3000}`));
