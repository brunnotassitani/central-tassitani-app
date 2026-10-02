import {createHash,randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';
import {OAuth2Client} from 'google-auth-library';

export const OWNER=(process.env.OWNER_EMAIL||'').trim().toLowerCase();
export const MEMBERS=JSON.parse(process.env.MEMBERS_JSON||'[]');
if(!OWNER||!MEMBERS.some(m=>m.email===OWNER))throw new Error('Configure OWNER_EMAIL e MEMBERS_JSON no servidor.');
export const SESSION_SECONDS=90*24*60*60;
const digest=value=>createHash('sha256').update(value).digest('hex');
const cookieValue=(req,name)=>req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);
const reject=(message,status=401)=>{throw Object.assign(new Error(message),{status});};
export function allowedGoogleUser(payload,nonce){
 const member=MEMBERS.find(u=>u.email===payload?.email?.toLowerCase());
 if(!member||payload.email_verified!==true||!payload.sub||payload.nonce!==nonce)reject('Esta conta Google não tem acesso à central.',403);
 return {...member,sub:payload.sub};
}
export async function createAuth({pool,one,run}){
 const clientId=process.env.GOOGLE_CLIENT_ID?.trim()||'';
 const google=new OAuth2Client(clientId),secure=process.env.COOKIE_SECURE==='true';
 const salt=randomBytes(16),passwordHash=process.env.ADMIN_PASSWORD?scryptSync(process.env.ADMIN_PASSWORD,salt,32):null;
 const attempts=new Map();
 const cookie=(res,name,value,seconds)=>res.setHeader('Set-Cookie',`${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${seconds}${secure?'; Secure':''}`);
 await pool.query('CREATE TABLE IF NOT EXISTS users (email VARCHAR(190) PRIMARY KEY,name VARCHAR(190) NOT NULL,google_sub VARCHAR(255) UNIQUE NULL) CHARACTER SET utf8mb4');
 await pool.query('CREATE TABLE IF NOT EXISTS auth_sessions (token_hash CHAR(64) PRIMARY KEY,email VARCHAR(190) NOT NULL,expires_at BIGINT NOT NULL,INDEX session_expiry(expires_at)) CHARACTER SET utf8mb4');
 await pool.query('CREATE TABLE IF NOT EXISTS login_challenges (token_hash CHAR(64) PRIMARY KEY,expires_at BIGINT NOT NULL) CHARACTER SET utf8mb4');
 for(const user of MEMBERS)await run('INSERT IGNORE INTO users(email,name) VALUES(?,?)',[user.email,user.name]);
 const cleanup=()=>Promise.all([run('DELETE FROM auth_sessions WHERE expires_at<?',[Date.now()]),run('DELETE FROM login_challenges WHERE expires_at<?',[Date.now()])]).catch(()=>{});
 void cleanup();setInterval(cleanup,3600000).unref();
 async function user(req){const token=cookieValue(req,'central_session');if(!token||!/^[-\w]{43}$/.test(token))return null;const row=await one('SELECT u.email,u.name FROM auth_sessions s JOIN users u ON u.email=s.email WHERE s.token_hash=? AND s.expires_at>?',[digest(token),Date.now()]);return MEMBERS.some(u=>u.email===row?.email)?{...row,isOwner:row.email===OWNER}:null;}
 async function issue(req,res,member){const old=cookieValue(req,'central_session');if(old)await run('DELETE FROM auth_sessions WHERE token_hash=?',[digest(old)]);const token=randomBytes(32).toString('base64url');await run('INSERT INTO auth_sessions VALUES(?,?,?)',[digest(token),member.email,Date.now()+SESSION_SECONDS*1000]);cookie(res,'central_session',token,SESSION_SECONDS);return {editor:true,user:{email:member.email,name:member.name,isOwner:member.email===OWNER}};}
 function rateLimit(req){const key=req.socket.remoteAddress;for(const [k,v] of attempts)if(v.until<Date.now())attempts.delete(k);const a=attempts.get(key)||{count:0,until:Date.now()+900000};if(++a.count>15)reject('Muitas tentativas. Aguarde 15 minutos.',429);attempts.set(key,a);}
 return {user,config:()=>({googleClientId:clientId,passwordEnabled:!clientId&&!!passwordHash}),
  async challenge(res){const nonce=randomBytes(32).toString('base64url');await run('INSERT INTO login_challenges VALUES(?,?)',[digest(nonce),Date.now()+600000]);cookie(res,'central_login',nonce,600);return {nonce};},
  async googleLogin(req,res,credential){rateLimit(req);if(!clientId)reject('Login Google ainda não configurado.',503);const nonce=cookieValue(req,'central_login');if(!nonce)reject('Recarregue a página para entrar.');const challenge=await run('DELETE FROM login_challenges WHERE token_hash=? AND expires_at>?',[digest(nonce),Date.now()]);if(challenge.affectedRows!==1)reject('Este login expirou. Recarregue a página.');let payload;try{const ticket=await google.verifyIdToken({idToken:credential,audience:clientId});payload=ticket.getPayload();}catch{reject('Não foi possível validar sua conta Google.');}const member=allowedGoogleUser(payload,nonce);const stored=await one('SELECT google_sub FROM users WHERE email=?',[member.email]);if(stored.google_sub&&stored.google_sub!==member.sub)reject('Conta Google não corresponde ao acesso cadastrado.',403);await run('UPDATE users SET google_sub=? WHERE email=? AND (google_sub IS NULL OR google_sub=?)',[member.sub,member.email,member.sub]);return issue(req,res,member);},
  async passwordLogin(req,res,body){rateLimit(req);if(clientId||!passwordHash)reject('Entre com sua conta Google.',403);if((body.email||OWNER).toLowerCase()!==OWNER||typeof body.password!=='string'||body.password.length>500||!timingSafeEqual(scryptSync(body.password,salt,32),passwordHash))reject('E-mail ou senha incorretos.');return issue(req,res,MEMBERS[0]);},
  async logout(req,res){const token=cookieValue(req,'central_session');if(token)await run('DELETE FROM auth_sessions WHERE token_hash=?',[digest(token)]);cookie(res,'central_session','',0);return {ok:true};}
 };
}
