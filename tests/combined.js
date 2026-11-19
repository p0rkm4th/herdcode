
'use strict';
/* =====================================================================
   HERDCODE — a Fold 6 cockpit for Codex + the Ollama Herd.
   Pure client: no build step, no external requests except the user's
   own endpoints. State lives in localStorage under one key.
   ===================================================================== */
const LS_KEY = 'herdcode_v1';
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));

const DEFAULT_STATE = {
  endpoints: [
    {id:'ep-hades', name:'Hades Ollama', kind:'ollama', url:'http://hades:11434', key:''},
    {id:'ep-gw',    name:'LiteLLM Gateway', kind:'openai', url:'http://hades:4000/v1', key:''}
  ],
  bridge: {url:'http://hades:8765', token:''},
  systemPrompt: 'You are a senior software engineer helping on the user\'s own machines and repos. Be concrete: show code, name files, state tradeoffs. If you are unsure, say so instead of inventing APIs.',
  temperature: 0.3,
  model: '',
  sandbox: 'read-only',
  repo: '',
  sessions: [],
  activeSession: null
};

let S = load();
let herdStatus = [];          // [{endpoint, ok, ms, models:[], loaded:[], error}]
let modelIndex = {};          // modelName -> [{endpointId, endpointName}]
let chatAbort = null;         // AbortController for the live chat stream
let codexRunning = false;

function load(){
  try{
    const raw = localStorage.getItem(LS_KEY);
    if(!raw) return structuredClone(DEFAULT_STATE);
    const s = Object.assign(structuredClone(DEFAULT_STATE), JSON.parse(raw));
    if(!s.sessions.length) s.sessions = [newSession()];
    if(!s.activeSession) s.activeSession = s.sessions[0].id;
    return s;
  }catch(e){ return structuredClone(DEFAULT_STATE); }
}
function save(){ try{ localStorage.setItem(LS_KEY, JSON.stringify(S)); }catch(e){} }
function uid(){ return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2,7); }
function newSession(){
  return {id: uid(), title:'New session', created: Date.now(),
          messages: []};   // {role:'user'|'assistant'|'system', content, model?}
}
function activeSess(){
  let s = S.sessions.find(x => x.id === S.activeSession);
  if(!s){ s = S.sessions[0] || newSession(); S.sessions.push(s); S.activeSession = s.id; }
  return s;
}
function esc(t){ return String(t ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function normUrl(u){ return String(u||'').trim().replace(/\/+$/,''); }

/* ---------------- mini-markdown (escaped first, then formatted) ------- */
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

/* ---------------- navigation + fold posture --------------------------- */
function nav(view){
  $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-'+view));
  $$('[data-nav]').forEach(b => b.classList.toggle('active', b.dataset.nav === view));
  if(view === 'chat') $('#pip-chat').style.display = 'none';
  if(view === 'codex') $('#pip-codex').style.display = 'none';
  if(view === 'herd') renderHerd();
}
$$('[data-nav]').forEach(b => b.addEventListener('click', () => nav(b.dataset.nav)));

function posture(){
  const w = window.innerWidth;
  const label = w < 700 ? 'cover screen' : (w < 1120 ? 'unfolded' : 'unfolded · wide');
  $('#posture').textContent = label + ' · ' + w + 'px';
}
window.addEventListener('resize', posture);

/* ---------------- herd discovery -------------------------------------- */
function authHeaders(ep){
  const h = {'Content-Type':'application/json'};
  if(ep && ep.key) h['Authorization'] = 'Bearer ' + ep.key;
  return h;
}
async function fetchWithTimeout(url, opts, ms){
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 6000);
  try{ return await fetch(url, Object.assign({}, opts||{}, {signal: ctl.signal})); }
  finally{ clearTimeout(t); }
}

/* Query one endpoint for health + models. Ollama: /api/tags + /api/ps.
   OpenAI-compatible: /models. Returns a status record; never throws. */
async function probeEndpoint(ep){
  const t0 = performance.now();
  const rec = {endpoint: ep, ok:false, ms:0, models:[], loaded:[], error:null};
  try{
    if(ep.kind === 'ollama'){
      const base = normUrl(ep.url);
      const r = await fetchWithTimeout(base + '/api/tags', {headers: authHeaders(ep)});
      if(!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      rec.models = (j.models||[]).map(m => m.name).filter(Boolean);
      try{
        const rp = await fetchWithTimeout(base + '/api/ps', {headers: authHeaders(ep)}, 3000);
        if(rp.ok){ const pj = await rp.json(); rec.loaded = (pj.models||[]).map(m => m.name).filter(Boolean); }
      }catch(e){ /* loaded list is a nicety, not a requirement */ }
    }else{
      const base = normUrl(ep.url);
      const r = await fetchWithTimeout(base + '/models', {headers: authHeaders(ep)});
      if(!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      rec.models = (j.data||[]).map(m => m.id).filter(Boolean);
    }
    rec.ok = true;
  }catch(e){ rec.error = (e.name === 'AbortError') ? 'timeout' : String(e.message || e); }
  rec.ms = Math.round(performance.now() - t0);
  return rec;
}

async function refreshHerd(){
  const dot = $('#herdDot'); dot.className = 'dot busy';
  $('#herdText').textContent = 'herd: checking…';
  herdStatus = await Promise.all(S.endpoints.map(probeEndpoint));
  modelIndex = {};
  for(const rec of herdStatus){
    for(const m of rec.models){
      (modelIndex[m] = modelIndex[m] || []).push(rec.endpoint);
    }
  }
  rebuildModelSelect();
  const up = herdStatus.filter(r => r.ok).length;
  dot.className = 'dot ' + (up === herdStatus.length && up > 0 ? 'ok' : (up ? 'busy' : 'bad'));
  $('#herdText').textContent = 'herd: ' + up + '/' + herdStatus.length + ' nodes · ' +
    Object.keys(modelIndex).length + ' models';
  renderHerd(); renderInspector();
  return herdStatus;
}

function rebuildModelSelect(){
  const sel = $('#modelSelect');
  const names = Object.keys(modelIndex).sort();
  const prev = S.model || sel.value;
  sel.innerHTML = '';
  if(!names.length){
    const o = document.createElement('option');
    o.textContent = 'no models — check Herd tab'; o.value = '';
    sel.appendChild(o); return;
  }
  for(const n of names){
    const o = document.createElement('option');
    o.value = n; o.textContent = n + (modelIndex[n].length > 1 ? '  ×' + modelIndex[n].length : '');
    sel.appendChild(o);
  }
  // Prefer a coding model as the default pick.
  const pref = names.find(n => /coder|devstral/i.test(n)) || names.find(n => /gpt-oss/i.test(n)) || names[0];
  sel.value = names.includes(prev) ? prev : pref;
  S.model = sel.value; save();
}
$('#modelSelect').addEventListener('change', e => { S.model = e.target.value; save(); renderInspector(); });
$('#refreshBtn').addEventListener('click', refreshHerd);
$('#herdRefreshBtn').addEventListener('click', async () => { await refreshHerd(); await testBridge(false); });

/* Pick the endpoint that should serve a chat with `model`:
   prefer a LiteLLM gateway (it load-balances the herd), else the first
   node that lists the model. */
function pickEndpoint(model){
  const eps = (modelIndex[model] || []);
  return eps.find(e => e.kind === 'openai') || eps[0] || null;
}

/* ---------------- sessions UI ------------------------------------------ */
function renderSessions(){
  const list = $('#sessionList'); list.innerHTML = '';
  const sorted = [...S.sessions].sort((a,b) => b.created - a.created);
  for(const s of sorted){
    const d = document.createElement('div');
    d.className = 'sessionitem' + (s.id === S.activeSession ? ' active' : '');
    d.innerHTML = '<div class="t">' + esc(s.title) + '</div><div class="m">' +
      s.messages.length + ' msgs · ' + new Date(s.created).toLocaleDateString() + '</div>';
    d.addEventListener('click', () => { S.activeSession = s.id; save(); renderSessions(); renderMessages(); renderInspector(); });
    list.appendChild(d);
  }
}
$('#newSessionBtn').addEventListener('click', () => {
  const s = newSession(); S.sessions.push(s); S.activeSession = s.id; save();
  renderSessions(); renderMessages(); nav('chat');
});

function renderMessages(){
  const box = $('#messages'); box.innerHTML = '';
  const sess = activeSess();
  if(!sess.messages.length){
    box.innerHTML = '<div class="msg system">New session. Pick a model up top (⟳ Herd if the list is empty), then ask away.<br>Codex agent runs live in the <b>Codex</b> tab.</div>';
  }
  for(const m of sess.messages){
    if(m.role === 'system') continue;
    const d = document.createElement('div');
    d.className = 'msg ' + m.role;
    d.innerHTML = '<div class="who">' + (m.role === 'user' ? 'YOU' : esc(m.model || 'HERD')) + '</div>' + md(m.content);
    box.appendChild(d);
  }
  box.scrollTop = box.scrollHeight;
}

/* ---------------- chat streaming --------------------------------------- */
/* Stream a chat completion. Two wire formats:
     openai: POST {base}/chat/completions, SSE `data:` lines
     ollama: POST {base}/api/chat, NDJSON lines
   onToken(fullTextSoFar) is called as tokens land. Returns final text. */
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

async function sendChat(){
  const input = $('#chatInput');
  const text = input.value.trim();
  if(!text || chatAbort) return;
  const model = S.model || $('#modelSelect').value;
  if(!model){ alert('No model selected — open the Herd tab and check your endpoints.'); return; }
  const ep = pickEndpoint(model);
  if(!ep){ alert('No reachable endpoint lists model "' + model + '". Tap ⟳ Herd.'); return; }
  const sess = activeSess();
  if(sess.messages.length === 0) sess.title = text.slice(0, 44);
  sess.messages.push({role:'user', content:text});
  input.value = '';
  renderMessages(); renderSessions();

  const box = $('#messages');
  const live = document.createElement('div');
  live.className = 'msg assistant';
  live.innerHTML = '<div class="who">' + esc(model) + ' · ' + esc(ep.name) + '</div><div class="body typing">thinking…</div>';
  box.appendChild(live); box.scrollTop = box.scrollHeight;
  const bodyEl = live.querySelector('.body');

  $('#sendBtn').style.display = 'none'; $('#stopBtn').style.display = '';
  chatAbort = new AbortController();
  const convo = [{role:'system', content:S.systemPrompt},
    ...sess.messages.map(m => ({role:m.role, content:m.content}))];
  try{
    const full = await streamChat(ep, model, convo, t => {
      bodyEl.classList.remove('typing'); bodyEl.innerHTML = md(t); box.scrollTop = box.scrollHeight;
    }, chatAbort.signal);
    sess.messages.push({role:'assistant', content: full, model});
  }catch(e){
    const partial = bodyEl.textContent && bodyEl.textContent !== 'thinking…' ? bodyEl.textContent : '';
    sess.messages.push({role:'assistant',
      content: (partial ? partial + '\n\n' : '') + '⚠️ Stream ended: ' + (e.name === 'AbortError' ? 'stopped by you' : e.message),
      model});
  }finally{
    chatAbort = null;
    $('#sendBtn').style.display = ''; $('#stopBtn').style.display = 'none';
    save(); renderMessages(); renderSessions(); renderInspector();
    if(!$('.view#view-chat').classList.contains('active')) $('#pip-chat').style.display = 'block';
  }
}
$('#sendBtn').addEventListener('click', sendChat);
$('#stopBtn').addEventListener('click', () => { if(chatAbort) chatAbort.abort(); });
$('#chatInput').addEventListener('keydown', e => {
  if(e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendChat();
});

;

'use strict';
/* ================= herd tab + inspector =============================== */
function renderHerd(){
  const wrap = $('#herdCards');
  if(!wrap) return;
  wrap.innerHTML = '';
  if(!herdStatus.length){
    wrap.innerHTML = '<div class="card"><h3>NOT CHECKED YET</h3><div class="sub">Tap “Recheck everything”. The seeded endpoints point at <span class="kv">http://hades:…</span> — edit them in Settings to your nodes’ Tailscale IPs / MagicDNS names.</div></div>';
    return;
  }
  for(const rec of herdStatus){
    const ep = rec.endpoint;
    const d = document.createElement('div');
    d.className = 'card nodecard';
    d.innerHTML = '<div class="row"><span class="dot ' + (rec.ok ? 'ok' : 'bad') + '"></span>' +
      '<b>' + esc(ep.name) + '</b><span class="kv">' + esc(ep.url) + '</span>' +
      '<span class="mini">' + (rec.ok ? rec.ms + ' ms' : 'DOWN') + '</span></div>' +
      (rec.ok
        ? '<div class="models">' + rec.models.map(m =>
            '<span class="' + (rec.loaded.includes(m) ? 'loaded' : '') + '">' + esc(m) +
            (rec.loaded.includes(m) ? ' ●loaded' : '') + '</span>').join('') + '</div>'
        : '<div class="errbox" style="margin-top:8px">' + esc(rec.error || 'unreachable') +
          '\nCheck: is the node on the tailnet, is Ollama/LiteLLM listening on that interface (not just localhost), and is the URL right?</div>');
    wrap.appendChild(d);
  }
}

function renderInspector(){
  const ih = $('#inspHerd'); if(!ih) return;
  ih.innerHTML = herdStatus.length
    ? herdStatus.map(r => '<div><span class="dot ' + (r.ok ? 'ok' : 'bad') + '"></span> <b>' +
        esc(r.endpoint.name) + '</b> — ' + (r.ok ? r.models.length + ' models, ' + r.ms + ' ms' : 'down') + '</div>').join('')
    : 'unchecked — tap ⟳ Herd';
  const sess = activeSess();
  $('#inspSession').innerHTML = '<b>' + esc(sess.title) + '</b><br>' + sess.messages.length +
    ' messages<br>model: <span class="kv">' + esc(S.model || '—') + '</span>';
}

/* ================= bridge (Codex host) ================================ */
function bridgeHeaders(){
  const h = {'Content-Type':'application/json'};
  if(S.bridge.token) h['Authorization'] = 'Bearer ' + S.bridge.token;
  return h;
}
async function bridgeFetch(path, opts){
  const r = await fetchWithTimeout(normUrl(S.bridge.url) + path,
    Object.assign({headers: bridgeHeaders()}, opts || {}), 10000);
  return r;
}

async function testBridge(manual){
  const out = $('#bridgeTestOut');
  const state = $('#codexState');
  try{
    const r = await bridgeFetch('/health');
    const j = await r.json();
    if(!j.auth) throw new Error('bridge answered but rejected the token (or HERD_TOKEN mismatch)');
    const txt = 'bridge ok · ' + (j.codex_found ? esc(j.codex_version || 'codex found') : '⚠️ codex NOT found on host') +
      ' · repos root ' + esc(j.repos_root || '?') + (j.run_active ? ' · a run is active' : '');
    if(out) out.innerHTML = txt;
    if(state) state.innerHTML = txt;
    const ic = $('#inspCodex'); if(ic) ic.innerHTML = txt;
    await loadRepos();
    return j;
  }catch(e){
    const txt = 'bridge unreachable: ' + esc(e.message || e) +
      ' — is herd_bridge.py running on Hades, and is this the right Tailscale URL?';
    if(out) out.innerHTML = txt;
    if(state) state.textContent = 'bridge: unreachable';
    const ic = $('#inspCodex'); if(ic) ic.textContent = 'bridge unreachable';
    if(manual) { /* error also visible in settings via out */ }
    return null;
  }
}
$('#bridgeTestBtn').addEventListener('click', () => testBridge(true));

async function loadRepos(){
  try{
    const r = await bridgeFetch('/repos');
    if(!r.ok) return;
    const j = await r.json();
    const sel = $('#repoSelect'); sel.innerHTML = '';
    for(const repo of (j.repos || [])){
      const o = document.createElement('option');
      o.value = repo.path;
      o.textContent = repo.name + (repo.branch ? '  (' + repo.branch + ')' : '') + (repo.git ? '' : '  · no git');
      sel.appendChild(o);
    }
    if(!sel.options.length){
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'no repos found under bridge root';
      sel.appendChild(o);
    }
    if(S.repo && [...sel.options].some(o => o.value === S.repo)) sel.value = S.repo;
  }catch(e){ /* bridge offline; manual path still usable */ }
}
$('#repoSelect').addEventListener('change', e => { S.repo = e.target.value; save(); });

/* ================= codex run (SSE from the bridge) ===================== */
function evEl(tag, cls, bodyHtml, preText){
  const d = document.createElement('div');
  d.className = 'ev ' + (cls || '');
  d.innerHTML = '<div class="tag">' + esc(tag) + '</div>' + (bodyHtml || '');
  if(preText != null){
    const p = document.createElement('pre');
    // colour unified-diff-ish output
    p.innerHTML = esc(preText).split('\n').map(l =>
      l.startsWith('+') && !l.startsWith('+++') ? '<span class="add">' + l + '</span>' :
      l.startsWith('-') && !l.startsWith('---') ? '<span class="del">' + l + '</span>' : l).join('\n');
    d.appendChild(p);
  }
  return d;
}

/* Render one `codex exec --json` event. The JSONL schema evolves between
   Codex releases, so this is deliberately generic: pull the readable bits
   we recognise (agent messages, commands, file changes), and keep the raw
   event available for everything else. Nothing is silently dropped. */
function renderCodexEvent(obj, stream){
  const t = obj.type || obj.event || 'event';
  const item = obj.item || obj.msg || obj;
  const itype = (item && item.type) || '';
  if(/agent_message|assistant/i.test(itype) || (item && typeof item.text === 'string' && /message/i.test(t))){
    stream.appendChild(evEl('CODEX', '', md(item.text || '')));
  }else if(/command/i.test(itype)){
    const cmd = item.command || item.cmd || '';
    const outTxt = (item.aggregated_output || item.output || '').slice(0, 4000);
    stream.appendChild(evEl('COMMAND' + (item.status ? ' · ' + item.status : ''), 'cmd',
      '<span class="kv">' + esc(Array.isArray(cmd) ? cmd.join(' ') : cmd) + '</span>', outTxt || null));
  }else if(/file|patch|diff/i.test(itype)){
    const changes = item.changes || item.diff || item;
    stream.appendChild(evEl('FILE CHANGE', 'cmd', '', typeof changes === 'string' ? changes.slice(0, 6000) : JSON.stringify(changes, null, 1).slice(0, 6000)));
  }else if(/error/i.test(t) || /error/i.test(itype)){
    stream.appendChild(evEl('ERROR', 'err', '', JSON.stringify(obj, null, 1).slice(0, 3000)));
  }else if(/turn\.|thread\.|session/i.test(t)){
    stream.appendChild(evEl(t.toUpperCase(), '', '<span class="mini">' + esc(JSON.stringify(obj).slice(0, 300)) + '</span>'));
  }else{
    const d = evEl(t.toUpperCase(), '', '');
    const det = document.createElement('details');
    det.innerHTML = '<summary class="mini">raw event</summary>';
    const p = document.createElement('pre'); p.textContent = JSON.stringify(obj, null, 1).slice(0, 4000);
    det.appendChild(p); d.appendChild(det);
    stream.appendChild(d);
  }
  stream.scrollTop = stream.scrollHeight;
}

let codexAbort = null;
async function runCodex(){
  if(codexRunning) return;
  const prompt = $('#codexPrompt').value.trim();
  if(!prompt){ alert('Give Codex a task first.'); return; }
  const repo = ($('#repoManual').value.trim() || $('#repoSelect').value || S.repo || '');
  const stream = $('#codexStream');
  stream.appendChild(evEl('RUN', 'cmd', 'Repo <span class="kv">' + esc(repo || '(bridge root)') +
    '</span> · model <span class="kv">' + esc(S.model || 'codex --oss default') +
    '</span> · sandbox <span class="kv">' + esc(S.sandbox) + '</span>'));
  stream.scrollTop = stream.scrollHeight;

  codexRunning = true; codexAbort = new AbortController();
  $('#codexRunBtn').style.display = 'none'; $('#codexStopBtn').style.display = '';
  $('#codexState').textContent = 'codex: running…';
  try{
    const r = await fetch(normUrl(S.bridge.url) + '/codex/run', {
      method:'POST', headers: bridgeHeaders(), signal: codexAbort.signal,
      body: JSON.stringify({repo, prompt, model: S.model || '', sandbox: S.sandbox})
    });
    if(!r.ok){
      let msg = 'HTTP ' + r.status;
      try{ const j = await r.json(); msg += ': ' + (j.error || ''); }catch(e){}
      throw new Error(msg);
    }
    // SSE stream from the bridge
    const reader = r.body.getReader(); const dec = new TextDecoder();
    let buf = '', evtName = 'message';
    const handleBlock = block => {
      let data = '';
      for(const line of block.split('\n')){
        if(line.startsWith('event:')) evtName = line.slice(6).trim();
        if(line.startsWith('data:')) data += line.slice(5).trim();
      }
      if(!data) return;
      let obj = null; try{ obj = JSON.parse(data); }catch(e){}
      if(evtName === 'codex' && obj) renderCodexEvent(obj, stream);
      else if(evtName === 'started') stream.appendChild(evEl('STARTED', 'cmd', '<span class="kv">' + esc((obj && obj.cmd || []).join(' ')) + '</span>'));
      else if(evtName === 'stderr') stream.appendChild(evEl('STDERR', '', '', obj && obj.text));
      else if(evtName === 'raw') stream.appendChild(evEl('RAW', '', '', obj && obj.text));
      else if(evtName === 'error') stream.appendChild(evEl('BRIDGE ERROR', 'err', '', obj && obj.error));
      else if(evtName === 'done') stream.appendChild(evEl('DONE · exit ' + (obj && obj.exit_code) + (obj && obj.timed_out ? ' · TIMED OUT' : ''), 'done', ''));
      stream.scrollTop = stream.scrollHeight;
    };
    for(;;){
      const {done, value} = await reader.read(); if(done) break;
      buf += dec.decode(value, {stream:true});
      let i;
      while((i = buf.indexOf('\n\n')) >= 0){ handleBlock(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
    if(buf.trim()) handleBlock(buf);
  }catch(e){
    stream.appendChild(evEl('FAILED TO START / STREAM', 'err', '',
      (e.name === 'AbortError' ? 'cancelled from the phone' : String(e.message || e)) +
      '\n\nIf the bridge is unreachable: check Tailscale, the bridge URL/token in Settings, and that herd_bridge.py is running on Hades.'));
  }finally{
    codexRunning = false; codexAbort = null;
    $('#codexRunBtn').style.display = ''; $('#codexStopBtn').style.display = 'none';
    $('#codexState').textContent = 'codex: idle';
    if(!$('#view-codex').classList.contains('active')) $('#pip-codex').style.display = 'block';
  }
}
$('#codexRunBtn').addEventListener('click', runCodex);
$('#codexStopBtn').addEventListener('click', async () => {
  try{ await bridgeFetch('/codex/cancel', {method:'POST', body:'{}'}); }catch(e){}
  if(codexAbort) codexAbort.abort();
});
$('#sandboxSeg').addEventListener('click', e => {
  const b = e.target.closest('button'); if(!b) return;
  if(b.dataset.sb === 'danger-full-access' &&
     !confirm('Full access lets Codex run anything on the bridge host, and the bridge refuses it unless HERD_ALLOW_FULL=1. Select it anyway?')) return;
  S.sandbox = b.dataset.sb; save();
  $$('#sandboxSeg button').forEach(x => x.classList.toggle('active', x === b));
});

/* ================= settings UI ======================================== */
function renderSettings(){
  $('#systemPrompt').value = S.systemPrompt;
  $('#temperature').value = S.temperature;
  $('#bridgeUrl').value = S.bridge.url;
  $('#bridgeToken').value = S.bridge.token;
  $$('#sandboxSeg button').forEach(x => x.classList.toggle('active', x.dataset.sb === S.sandbox));
  const wrap = $('#endpointList'); wrap.innerHTML = '';
  S.endpoints.forEach((ep, idx) => {
    const card = document.createElement('div');
    card.className = 'card'; card.style.marginBottom = '10px';
    card.innerHTML =
      '<div class="row"><input class="grow" data-f="name" value="' + esc(ep.name) + '" placeholder="Name">' +
      '<select data-f="kind"><option value="ollama"' + (ep.kind==='ollama'?' selected':'') + '>ollama</option>' +
      '<option value="openai"' + (ep.kind==='openai'?' selected':'') + '>openai / LiteLLM</option></select>' +
      '<button class="iconbtn" data-del="' + idx + '">✕</button></div>' +
      '<div class="field" style="margin-top:8px"><label>BASE URL</label><input data-f="url" value="' + esc(ep.url) + '"></div>' +
      '<div class="field" style="margin:0"><label>API KEY (LITELLM MASTER / VIRTUAL KEY — OLLAMA USUALLY BLANK)</label>' +
      '<input data-f="key" type="password" value="' + esc(ep.key||'') + '"></div>';
    card.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('change', () => {
      ep[inp.dataset.f] = inp.value; save();
    }));
    card.querySelector('[data-del]').addEventListener('click', () => {
      S.endpoints.splice(idx, 1); save(); renderSettings();
    });
    wrap.appendChild(card);
  });
}
$('#addOllamaBtn').addEventListener('click', () => {
  S.endpoints.push({id: uid(), name:'Ollama node', kind:'ollama', url:'http://node-tailscale-ip:11434', key:''});
  save(); renderSettings();
});
$('#addGatewayBtn').addEventListener('click', () => {
  S.endpoints.push({id: uid(), name:'LiteLLM gateway', kind:'openai', url:'http://services-tailscale-ip:4000/v1', key:''});
  save(); renderSettings();
});
$('#saveSettingsBtn').addEventListener('click', () => {
  S.systemPrompt = $('#systemPrompt').value;
  S.temperature = parseFloat($('#temperature').value) || 0.3;
  S.bridge.url = normUrl($('#bridgeUrl').value);
  S.bridge.token = $('#bridgeToken').value.trim();
  S.repo = $('#repoSelect').value || S.repo;
  save(); alert('Saved. Tap ⟳ Herd to re-probe endpoints.');
});
$('#exportBtn').addEventListener('click', async () => {
  const sess = activeSess();
  const txt = sess.messages.map(m => '## ' + m.role + (m.model ? ' (' + m.model + ')' : '') + '\n\n' + m.content).join('\n\n');
  try{ await navigator.clipboard.writeText(txt); alert('Transcript copied to clipboard — paste it into Obsidian.'); }
  catch(e){ prompt('Copy the transcript:', txt); }
});
$('#wipeBtn').addEventListener('click', () => {
  if(!confirm('Delete all chat sessions? Settings (endpoints, bridge) are kept.')) return;
  S.sessions = [newSession()]; S.activeSession = S.sessions[0].id; save();
  renderSessions(); renderMessages(); renderInspector();
});

/* ================= init =============================================== */
(function init(){
  if(!S.sessions.length){ S.sessions = [newSession()]; S.activeSession = S.sessions[0].id; save(); }
  posture(); renderSessions(); renderMessages(); renderSettings(); renderHerd(); renderInspector();
  refreshHerd();            // probe endpoints on launch
  testBridge(false);        // and the bridge, quietly
})();
