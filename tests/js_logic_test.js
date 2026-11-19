
const S = {temperature: 0.3};
function esc(t){ return String(t ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function md(src){
  src = String(src ?? '');
  const blocks = [];
  src = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    let html = esc(code.replace(/\n$/,''));
    if(lang === 'diff' || /^[\s]*[+-]/m.test(code)){
      html = html.split('\n').map(l =>
        l.startsWith('+') ? '<span class="add">'+l+'</span>' :
        l.startsWith('-') ? '<span class="del">'+l+'</span>' : l).join('\n');
    }
    blocks.push('<pre><code>'+html+'</code></pre>');
    return '\u0001' + (blocks.length-1) + '\u0001';
  });
  let out = esc(src);
  out = out
    .replace(/^### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^## (.*)$/gm, '<h3>$1</h3>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>')
    .replace(/(<li>[\s\S]*?<\/li>)/g, '$1'); // grouping handled below by wrap pass
  out = out.split(/\n{2,}/).map(p =>
    p.includes('<li>') ? '<ul>'+p+'</ul>' :
    (p.startsWith('<h') || p.startsWith('\u0001')) ? p : '<p>'+p.replace(/\n/g,'<br>')+'</p>'
  ).join('');
  out = out.replace(/\u0001(\d+)\u0001/g, (m,i) => blocks[+i]);
  return out;
}
function normUrl(u){ return String(u||'').trim().replace(/\/+$/,''); }
function authHeaders(ep){
  const h = {'Content-Type':'application/json'};
  if(ep && ep.key) h['Authorization'] = 'Bearer ' + ep.key;
  return h;
}
async function streamChat(ep, model, messages, onToken, signal){
  let full = '';
  if(ep.kind === 'ollama'){
    const r = await fetch(normUrl(ep.url) + '/api/chat', {
      method:'POST', headers: authHeaders(ep), signal,
      body: JSON.stringify({model, stream:true,
        options:{temperature: S.temperature}, messages})
    });
    if(!r.ok) throw new Error('Ollama HTTP ' + r.status + ': ' + (await r.text()).slice(0,300));
    const reader = r.body.getReader(); const dec = new TextDecoder();
    let buf = '';
    for(;;){
      const {done, value} = await reader.read(); if(done) break;
      buf += dec.decode(value, {stream:true});
      let i;
      while((i = buf.indexOf('\n')) >= 0){
        const line = buf.slice(0, i).trim(); buf = buf.slice(i+1);
        if(!line) continue;
        try{ const j = JSON.parse(line); full += (j.message && j.message.content) || ''; onToken(full); }catch(e){}
      }
    }
    return full;
  }
  // OpenAI-compatible (LiteLLM gateway or Ollama /v1)
  const r = await fetch(normUrl(ep.url) + '/chat/completions', {
    method:'POST', headers: authHeaders(ep), signal,
    body: JSON.stringify({model, stream:true, temperature: S.temperature, messages})
  });
  if(!r.ok) throw new Error('Gateway HTTP ' + r.status + ': ' + (await r.text()).slice(0,300));
  const reader = r.body.getReader(); const dec = new TextDecoder();
  let buf = '';
  // SSE from chat-completions is line-oriented in practice: each event is a
  // `data: {...}` line (blank lines separate events). Parse per line and
  // keep the trailing partial line in the buffer for the next read.
  const handleLine = line => {
    const t = line.trim();
    if(!t.startsWith('data:')) return;
    const data = t.slice(5).trim();
    if(!data || data === '[DONE]') return;
    try{
      const j = JSON.parse(data);
      const d = (j.choices && j.choices[0] && j.choices[0].delta) || {};
      full += d.content || d.reasoning_content || '';
      onToken(full);
    }catch(e){}
  };
  for(;;){
    const {done, value} = await reader.read(); if(done) break;
    buf += dec.decode(value, {stream:true});
    let i;
    while((i = buf.indexOf('\n')) >= 0){
      handleLine(buf.slice(0, i)); buf = buf.slice(i + 1);
    }
  }
  if(buf.trim()) handleLine(buf);
  return full;
}

const http = require('http');
async function main(){
  // --- fake Ollama NDJSON server ---
  const oll = http.createServer((req,res)=>{
    let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
      const body = JSON.parse(b);
      if(body.model !== 'test-model') { res.writeHead(500); return res.end('bad model'); }
      res.writeHead(200, {'Content-Type':'application/x-ndjson'});
      res.write(JSON.stringify({message:{content:'Hello '}})+'\n');
      res.write(JSON.stringify({message:{content:'herd'}})+'\n');
      res.end(JSON.stringify({message:{content:'!'}, done:true})+'\n');
    });
  });
  await new Promise(r=>oll.listen(0,'127.0.0.1',r));
  const epO = {kind:'ollama', url:'http://127.0.0.1:'+oll.address().port, key:''};
  let seen=[]; 
  const outO = await streamChat(epO, 'test-model', [{role:'user',content:'hi'}], t=>seen.push(t), null);
  console.log('OLLAMA full=', JSON.stringify(outO), 'tokens=', JSON.stringify(seen));
  if(outO !== 'Hello herd!') throw new Error('ollama parse failed');

  // --- fake OpenAI SSE server (LiteLLM shape, split across chunks mid-line) ---
  const oai = http.createServer((req,res)=>{
    let b=''; req.on('data',c=>b+=c); req.on('end',()=>{
      res.writeHead(200, {'Content-Type':'text/event-stream'});
      res.write('data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":"her');  // split line
      setTimeout(()=>{
        res.write('d"}}]}\n\n');
        res.end('data: [DONE]\n\n');
      }, 30);
    });
  });
  await new Promise(r=>oai.listen(0,'127.0.0.1',r));
  const epG = {kind:'openai', url:'http://127.0.0.1:'+oai.address().port+'/v1', key:'k'};
  seen=[];
  const outG = await streamChat(epG, 'lab-code', [{role:'user',content:'hi'}], t=>seen.push(t), null);
  console.log('OPENAI full=', JSON.stringify(outG), 'tokens=', JSON.stringify(seen));
  if(outG !== 'Hello herd') throw new Error('sse parse failed');

  // --- markdown / escaping ---
  const h = md('Use `rm -rf /` carefully\n\n```diff\n+added\n-removed\n```\n\n<script>alert(1)</'+'script>');
  if(h.includes('<script>alert')) throw new Error('md escaping failed');
  if(!h.includes('class="add"') || !h.includes('class="del"')) throw new Error('md diff colouring failed');
  console.log('MD ok');
  oll.close(); oai.close();
  console.log('ALL JS LOGIC TESTS PASSED');
}
main().catch(e=>{ console.error('FAIL', e); process.exit(1); });
