export function normalizeCreator(value){
 const handle=String(value||'').trim().replace(/^@/,'').toLowerCase();
 if(handle&&!/^[a-z0-9._]{1,30}$/.test(handle))throw new Error('Invalid creator');
 return handle;
}
// Only the author's position in Instagram's page title is evidence of ownership.
// Mentions in captions and comments must never become creator attribution.
export function creatorFromHtml(html){
 const header=html.split('class="Header"')[1]?.split('class="Content')[0]||'';
 const profile=header.match(/<a\b(?=[^>]*class="[^"]*ViewProfileButton)[^>]*href="https:\/\/www\.instagram\.com\/([\w.]+)\//i)||header.match(/<a\b(?=[^>]*class="(?:Username|CollabUsername)")[^>]*href="https:\/\/www\.instagram\.com\/([\w.]+)\//i);
 if(profile)return normalizeCreator(profile[1]);
 for(const tag of html.match(/<meta\s[^>]+>/gi)||[]){
  const attrs=Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)].map(m=>[m[1].toLowerCase(),m[3]]));
  if(!['og:title','twitter:title'].includes(attrs.property||attrs.name))continue;
  const title=(attrs.content||'').replace(/&#(?:x40|64);/gi,'@').replace(/&quot;/g,'"');
  const match=title.match(/^(?:[^@\n]{0,150}\()?@([a-zA-Z0-9._]{1,30})\)?\s+(?:on Instagram|no Instagram|• Instagram)/i)||title.match(/^([a-zA-Z0-9._]{1,30})\s+(?:on Instagram|no Instagram)\s*:/i);
  if(match)return normalizeCreator(match[1]);
 }
 return '';
}
