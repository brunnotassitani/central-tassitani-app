import {MEMBERS} from './auth.mjs';
import {randomUUID} from 'node:crypto';
export const FOLDERS=['Videos YouTube (Editados)','Reels (Editados)','Gravações Enviadas'];
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status})};
export function validateTask(b){
 const title=String(b.title||'').trim(),description=String(b.description||'').trim(),due=String(b.due_date||'');
 if(!title||title.length>180||description.length>10000)fail('Informe um título de até 180 caracteres.');
 if(!MEMBERS.some(m=>m.email===b.assignee))fail('Escolha um responsável da equipe.');
 if(!/^\d{4}-\d{2}-\d{2}$/.test(due)||!Number.isFinite(Date.parse(due))||new Date(due).toISOString().slice(0,10)!==due)fail('Informe um prazo válido.');
 if(!['pending','producing','done'].includes(b.status))fail('Status inválido.');
 return {title,description,assignee:b.assignee,due_date:due,status:b.status};
}
export function validateFolder(b){let u;try{u=new URL(b.url)}catch{fail('Informe um link válido.')}if(!['https:','http:'].includes(u.protocol)||u.username||u.password)fail('Use um link HTTP ou HTTPS.');const title=String(b.title||'').trim();if(!title||title.length>180||u.href.length>2000||!FOLDERS.includes(b.category))fail('Confira o nome e a categoria da pasta.');return {title,url:u.href,category:b.category};}
export async function setupTeam({pool}){
 await pool.query("CREATE TABLE IF NOT EXISTS team_tasks (id INT AUTO_INCREMENT PRIMARY KEY,title VARCHAR(180) NOT NULL,description TEXT NOT NULL,assignee VARCHAR(190) NOT NULL,due_date VARCHAR(10) NOT NULL,status VARCHAR(20) NOT NULL,created_by VARCHAR(190) NOT NULL,created_at VARCHAR(30) NOT NULL,updated_at VARCHAR(30) NOT NULL,version INT NOT NULL DEFAULT 1,notification_key VARCHAR(36) NOT NULL) CHARACTER SET utf8mb4");
 await pool.query("CREATE TABLE IF NOT EXISTS team_folders (id INT AUTO_INCREMENT PRIMARY KEY,title VARCHAR(180) NOT NULL,url VARCHAR(2000) NOT NULL,category VARCHAR(100) NOT NULL,created_by VARCHAR(190) NOT NULL,created_at VARCHAR(30) NOT NULL,version INT NOT NULL DEFAULT 1) CHARACTER SET utf8mb4");
 await pool.query("CREATE TABLE IF NOT EXISTS task_mail (id INT AUTO_INCREMENT PRIMARY KEY,task_id INT NOT NULL,notification_key VARCHAR(36) NOT NULL,kind VARCHAR(20) NOT NULL,state VARCHAR(20) NOT NULL DEFAULT 'pending',attempts INT NOT NULL DEFAULT 0,next_attempt BIGINT NOT NULL DEFAULT 0,UNIQUE KEY dedupe(task_id,notification_key,kind)) CHARACTER SET utf8mb4");
}
export function reminderKinds(task,today){if(task.status==='done')return [];const days=Math.round((Date.parse(task.due_date)-Date.parse(today))/86400000);return days===1?['tomorrow']:days===0?['today']:[];}
export function createTeam({all,one,run,pool,body,send}){
 const configured=()=>!!(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASSWORD&&process.env.MAIL_FROM&&process.env.APP_URL);
 let running=false;
 async function tick(){if(running||!configured())return;running=true;let c;try{
 c=await pool.getConnection();const [locks]=await c.query("SELECT GET_LOCK('central_task_email',0) acquired");if(!locks[0].acquired)return;
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 for(const t of await all("SELECT * FROM team_tasks WHERE status<>'done'")){for(const kind of ['assigned',...reminderKinds(t,today)])await run('INSERT IGNORE INTO task_mail(task_id,notification_key,kind) VALUES(?,?,?)',[t.id,t.notification_key,kind]);}
 const {default:nodemailer}=await import('nodemailer');const transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||465),secure:process.env.SMTP_PORT!=='587',auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD},connectionTimeout:15000,socketTimeout:20000});
 for(const mail of await all("SELECT * FROM task_mail WHERE state='pending' AND attempts<5 AND next_attempt<=? ORDER BY id LIMIT 20",[Date.now()])){
 const t=await one('SELECT * FROM team_tasks WHERE id=?',[mail.task_id]);if(!t||t.status==='done'||t.notification_key!==mail.notification_key||(mail.kind!=='assigned'&&!reminderKinds(t,today).includes(mail.kind))){await run("UPDATE task_mail SET state='cancelled' WHERE id=?",[mail.id]);continue;}
 const label=mail.kind==='assigned'?'Tarefa atribuída a você':mail.kind==='tomorrow'?'Tarefa com prazo amanhã':'Tarefa com prazo hoje';
 try{await transport.sendMail({from:process.env.MAIL_FROM,to:t.assignee,subject:`${label}: ${t.title}`,text:`${label}\n\n${t.title}\nPrazo: ${t.due_date.split('-').reverse().join('/')}\n${t.description}\n\nAbrir central: ${process.env.APP_URL}`,messageId:`<task-${mail.id}-${t.notification_key}@central.tassitani>`});await run("UPDATE task_mail SET state='sent' WHERE id=?",[mail.id]);}catch{await run('UPDATE task_mail SET attempts=attempts+1,next_attempt=? WHERE id=?',[Date.now()+900000,mail.id]);}
 }transport.close();
 }catch{console.error('Não foi possível processar os avisos de tarefas.');}finally{if(c){try{await c.query("SELECT RELEASE_LOCK('central_task_email')")}catch{}c.release();}running=false;}}
 setInterval(()=>void tick(),60000).unref();setTimeout(()=>void tick(),10000).unref();
 return async({path,req,res,user})=>{
 if(!/^\/api\/(tasks|folders|team)(\/|$)/.test(path))return false;
 if(!user)fail('Entre na central.',401);
 if(path==='/api/team'&&req.method==='GET'){send(res,200,{members:MEMBERS,categories:FOLDERS,email_configured:configured()});return true;}
 const m=path.match(/^\/api\/(tasks|folders)(?:\/(\d+))?$/);if(!m)fail('Não encontrado.',404);const tasks=m[1]==='tasks',table=tasks?'team_tasks':'team_folders',id=Number(m[2]);
 if(req.method==='GET'&&!id){send(res,200,await all(`SELECT * FROM ${table} ORDER BY ${tasks?'due_date ASC,id DESC':'id DESC'}`));return true;}
 const b=await body(req);if(id&&!Number.isInteger(b.version))fail('Atualize a lista antes de salvar.',409);
 if(req.method==='DELETE'&&id){const r=await run(`DELETE FROM ${table} WHERE id=? AND version=?`,[id,b.version]);if(!r.affectedRows)fail('Este registro foi alterado. Atualize a lista.',409);send(res,200,{ok:true});return true;}
 if(!['POST','PUT'].includes(req.method)||((req.method==='PUT')!==!!id))fail('Operação inválida.',405);
 const v=tasks?validateTask(b):validateFolder(b),now=new Date().toISOString();
 if(id){const old=await one(`SELECT * FROM ${table} WHERE id=?`,[id]);if(!old)fail('Registro não encontrado.',404);let fields=Object.keys(v),values=Object.values(v);if(tasks){fields.push('updated_at','notification_key');values.push(now,old.assignee!==v.assignee||old.due_date!==v.due_date||old.status==='done'&&v.status!=='done'?randomUUID():old.notification_key);}const r=await run(`UPDATE ${table} SET ${fields.map(k=>k+'=?').join(',')},version=version+1 WHERE id=? AND version=?`,[...values,id,b.version]);if(!r.affectedRows)fail('Outra pessoa alterou este registro. Atualize a lista.',409);
 }else{const data={...v,created_by:user.email,created_at:now,...(tasks?{updated_at:now,notification_key:randomUUID()}:{} )};await run(`INSERT INTO ${table}(${Object.keys(data).join(',')}) VALUES(${Object.keys(data).map(()=>'?').join(',')})`,Object.values(data));}
 send(res,id?200:201,{ok:true});void tick();return true;
 };
}
