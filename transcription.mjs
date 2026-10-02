export const TRANSCRIPTION_MODEL='gpt-4o-mini-transcribe';
export const MAX_MEDIA_BYTES=24_000_000;
export function mediaType(filename,buffer){
 const ext=String(filename).split('.').pop().toLowerCase();
 const allowed={mp3:'audio/mpeg',mp4:'video/mp4',m4a:'audio/mp4',wav:'audio/wav',webm:'audio/webm',ogg:'audio/ogg',flac:'audio/flac',mpeg:'audio/mpeg',mpga:'audio/mpeg'};
 if(!allowed[ext]||buffer.length<12||buffer.length>MAX_MEDIA_BYTES)throw Object.assign(new Error('Envie MP3, MP4, M4A, WAV, WebM, OGG, FLAC, MPEG ou MPGA de até 24 MB.'),{status:400});
 const ascii=(a,b)=>buffer.toString('ascii',a,b);
 const valid=(ext==='wav'&&ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE')||(['mp4','m4a'].includes(ext)&&ascii(4,8)==='ftyp')||(ext==='webm'&&buffer.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))||(ext==='ogg'&&ascii(0,4)==='OggS')||(ext==='flac'&&ascii(0,4)==='fLaC')||(['mp3','mpeg','mpga'].includes(ext)&&(ascii(0,3)==='ID3'||(buffer[0]===255&&(buffer[1]&224)===224)||buffer.subarray(0,3).equals(Buffer.from([0,0,1]))));
 if(!valid)throw Object.assign(new Error('O arquivo não parece ser áudio ou vídeo no formato indicado.'),{status:400});
 return allowed[ext];
}
export async function transcribeAudio({buffer,filename,apiKey,fetchImpl=fetch}){
 const type=mediaType(filename,buffer);const form=new FormData();form.append('file',new Blob([buffer],{type}),filename);form.append('model',TRANSCRIPTION_MODEL);form.append('language','pt');form.append('response_format','json');form.append('prompt','Conteúdo em português brasileiro. Termos possíveis: Brunno Tassitani, marketing digital, copywriting, VSL, infoprodutos, tráfego pago.');
 let response;try{response=await fetchImpl('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form,signal:AbortSignal.timeout(180000),redirect:'error'});}catch{throw Object.assign(new Error('Não foi possível confirmar o resultado na OpenAI. Confira o consumo antes de tentar novamente; não repetimos a cobrança automaticamente.'),{status:502});}
 if(!response.ok){const messages={401:'A chave da OpenAI foi recusada. Confira a configuração no servidor.',403:'Este projeto da OpenAI não tem acesso à transcrição.',429:'A OpenAI informou limite de uso ou saldo insuficiente. Confira a cobrança e os limites da sua conta.',400:'A OpenAI não conseguiu ler este áudio. Tente um MP3 ou M4A com fala audível.',413:'O arquivo ultrapassou o limite aceito pela OpenAI.'};throw Object.assign(new Error(messages[response.status]||'O serviço de transcrição está indisponível. Tente novamente mais tarde.'),{status:502});}
 let result;try{result=await response.json()}catch{throw Object.assign(new Error('Resposta inválida do serviço. Consulte o consumo antes de tentar novamente.'),{status:502});}
 if(typeof result.text!=='string'||!result.text.trim())throw Object.assign(new Error('Nenhuma fala foi reconhecida neste arquivo.'),{status:422});
 if(result.text.length>100000)throw Object.assign(new Error('Transcrição extensa demais. Divida o áudio em partes menores.'),{status:422});
 return {text:result.text.trim(),warning:result.usage?.output_tokens>=1900?'O texto pode ter atingido o limite de saída. Confira o final e use trechos menores se necessário.':''};
}
