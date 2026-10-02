// Only parse the public metadata summary, never captions or suggested posts.
export function parsePublicMetrics(html){
 const tags=html.match(/<meta\s[^>]+>/gi)||[];
 const tag=tags.find(t=>/(?:property|name)=["']og:description["']/i.test(t))||tags.find(t=>/name=["']description["']/i.test(t));
 const desc=tag?.match(/content=["']([^"']*)["']/i)?.[1]||'';
 const lead=desc.split(/\s[-–]\s/)[0].slice(0,160);const portuguese=/curtidas|comentários|comentarios/i.test(lead);
 const parse=v=>{if(!v)return null;const suffix=v.match(/(mil|[kmb])\s*$/i)?.[1]?.toLowerCase();let number=v.replace(/(mil|[kmb])\s*$/i,'').trim();if(suffix)number=number.replace(',','.');else number=number.replace(portuguese?/\./g:/,/g,'');const n=Number(number)*({k:1e3,mil:1e3,m:1e6,b:1e9}[suffix]||1);return Number.isSafeInteger(Math.round(n))&&n>=0?Math.round(n):null;};
 const like=lead.match(/^\s*([\d.,]+\s*(?:mil|[kmb])?)\s+(?:likes?|curtidas?)/i)?.[1];
 const comment=lead.match(/(?:^|,\s*)([\d.,]+\s*(?:mil|[kmb])?)\s+(?:comments?|comentários?|comentarios?)/i)?.[1];
 return {likes:parse(like),comments:parse(comment),shares:null,approximate:!!([like,comment].some(x=>x&&/(mil|[kmb])/i.test(x)))};
}
