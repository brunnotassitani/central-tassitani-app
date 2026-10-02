export function slideList(item){try{const s=JSON.parse(item.template_slides||'[]');return Array.isArray(s)?s.filter(x=>/^\/uploads\/[a-f0-9]{32}\.(png|jpeg|webp)$/.test(x.url)):[]}catch{return []}}
export function mediaKind(i){const slides=slideList(i);if(slides.length>1)return 'carousel';if(slides.length===1)return 'image';if(/é um vídeo/.test(i.visual_basis||'')||/\/(reels?|tv)\//.test(i.url)||['reels','react'].includes(i.category))return 'reel';return i.url?'reference':'idea'}
export function selectItems(items,f){const text=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();return items.filter(i=>
 (f.category==='all'||i.category===f.category)&&(f.status==='all'||i.status===f.status)&&text(`${i.title} ${i.notes} ${i.creator_handle||''} ${i.template_name||''} ${i.visual_description||''}`).includes(text(f.query))&&
 (f.media==='all'||mediaKind(i)===f.media)&&(f.transcript==='all'||(f.transcript==='done'?i.transcription_state==='done':i.transcription_state!=='done'))&&
 (f.engagement==='all'||(f.engagement==='available'?(i.likes!=null||i.comments!=null):(i.likes==null&&i.comments==null)))&&
 (!f.minLikes||(i.likes!=null&&i.likes>=Number(f.minLikes)))&&(!f.minComments||(i.comments!=null&&i.comments>=Number(f.minComments)))
 ).sort((a,b)=>f.sort==='title'?a.title.localeCompare(b.title,'pt-BR'):f.sort==='old'?a.id-b.id:['likes','comments'].includes(f.sort)?(b[f.sort]??-1)-(a[f.sort]??-1)||b.id-a.id:b.id-a.id)}
