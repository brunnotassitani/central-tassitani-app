import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {OWNER} from './auth.mjs';
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
export function pageUrl(value){try{const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password||!u.hostname.includes('.'))throw Error();u.hash='';return u.href;}catch{fail('Informe um endereço válido da página.')}}
export function pageImage(value){const m=String(value||'').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);if(!m)fail('Adicione um print da primeira dobra.');const bytes=Buffer.from(m[2],'base64');if(bytes.length>5e6)fail('O print deve ter até 5 MB.');const valid=m[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:m[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';if(!valid)fail('Imagem inválida.');return {bytes,mime:'image/'+m[1]};}
export async function setupPageReferences({pool,one,run,root}){
 await pool.query("CREATE TABLE IF NOT EXISTS page_references (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,title VARCHAR(200) NOT NULL,url VARCHAR(2000) NOT NULL,notes TEXT NOT NULL,screenshot MEDIUMBLOB NOT NULL,mime VARCHAR(30) NOT NULL,created_by VARCHAR(190) NOT NULL,created_at VARCHAR(40) NOT NULL,captured_at VARCHAR(40) NOT NULL,version INT NOT NULL DEFAULT 1,seed_key VARCHAR(100) UNIQUE NULL) CHARACTER SET utf8mb4");
 if(!await one('SELECT 1 FROM meta WHERE `key`=?',['private-pages-v1'])){
  for(const page of JSON.parse(readFileSync(join(root,'private-page-seeds/index.json'),'utf8')))await run('INSERT IGNORE INTO page_references(title,url,notes,screenshot,mime,created_by,created_at,captured_at,seed_key) VALUES(?,?,?,?,?,?,?,?,?)',[page.title,page.url,'',readFileSync(join(root,'private-page-seeds',page.image)),'image/jpeg',OWNER,page.captured_at,page.captured_at,page.key]);
  await run('INSERT IGNORE INTO meta(`key`,value) VALUES(?,?)',['private-pages-v1','1']);
 }
 // Subsequent additions have their own marker, so deleted references stay deleted.
 for(const page of JSON.parse(readFileSync(join(root,'private-page-seeds/index.json'),'utf8')).filter(p=>p.key==='maquina-influencer-ia')){
  const marker='private-page:'+page.key;
  if(!await one('SELECT 1 FROM meta WHERE `key`=?',[marker])){
   if(!await one('SELECT id FROM page_references WHERE url=?',[page.url]))await run('INSERT IGNORE INTO page_references(title,url,notes,screenshot,mime,created_by,created_at,captured_at,seed_key) VALUES(?,?,?,?,?,?,?,?,?)',[page.title,page.url,'',readFileSync(join(root,'private-page-seeds',page.image)),'image/jpeg',OWNER,page.captured_at,page.captured_at,page.key]);
   await run('INSERT IGNORE INTO meta(`key`,value) VALUES(?,?)',[marker,'1']);
  }
 }

}
export async function handlePageReferences({path,req,res,user,all,one,run,body,send}){
 if(path!=='/api/pages'&&!path.startsWith('/api/pages/'))return false;
 if(!user)fail('Entre na sua conta.',401);if(user.email!==OWNER)fail('Área restrita.',403);
 const fields='id,title,url,notes,created_by,created_at,captured_at,version';
 if(path==='/api/pages'&&req.method==='GET'){send(res,200,await all(`SELECT ${fields} FROM page_references ORDER BY id DESC`));return true;}
 const match=path.match(/^\/api\/pages\/(\d+)(\/image)?$/);
 if(match){const row=await one(`SELECT ${fields} FROM page_references WHERE id=?`,[Number(match[1])]);if(!row)fail('Página não encontrada.',404);
  if(match[2]&&['GET','HEAD'].includes(req.method)){const image=await one('SELECT screenshot,mime FROM page_references WHERE id=?',[row.id]);res.writeHead(200,{'Content-Type':image.mime,'Cache-Control':'private,no-store','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:image.screenshot);return true;}
  if(!match[2]&&req.method==='DELETE'){await run('DELETE FROM page_references WHERE id=?',[row.id]);send(res,200,{ok:true});return true;}
  if(!match[2]&&req.method==='PUT'){const data=await body(req),url=pageUrl(data.url),title=String(data.title||new URL(url).hostname).trim(),notes=String(data.notes||'');if(title.length>200||notes.length>10000)fail('Título ou anotação muito longos.');if(url!==row.url&&!data.image)fail('Ao trocar o endereço, adicione um novo print.');const image=data.image?pageImage(data.image):null;
   const result=await run('UPDATE page_references SET title=?,url=?,notes=?,screenshot=COALESCE(?,screenshot),mime=COALESCE(?,mime),captured_at=?,version=version+1 WHERE id=? AND version=?',[title,url,notes,image?.bytes??null,image?.mime??null,image?new Date().toISOString():row.captured_at,row.id,data.version??-1]);if(!result.affectedRows)fail('A página mudou. Reabra antes de salvar.',409);send(res,200,{ok:true});return true;}
 }
 if(path==='/api/pages'&&req.method==='POST'){const data=await body(req),url=pageUrl(data.url),title=String(data.title||new URL(url).hostname).trim(),notes=String(data.notes||'');if(title.length>200||notes.length>10000)fail('Título ou anotação muito longos.');const image=pageImage(data.image),now=new Date().toISOString();if(await one('SELECT id FROM page_references WHERE url=?',[url]))fail('Esta página já está cadastrada.',409);const result=await run('INSERT INTO page_references(title,url,notes,screenshot,mime,created_by,created_at,captured_at) VALUES(?,?,?,?,?,?,?,?)',[title,url,notes,image.bytes,image.mime,OWNER,now,now]);send(res,201,{id:result.insertId});return true;}
 fail('Ação não encontrada.',404);
}
