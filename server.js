// Desapego da Nara — servidor sem dependências (Node 18+)
// Uso: ANTHROPIC_API_KEY=sk-... node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const OR_KEY = process.env.OPENROUTER_API_KEY || '';
const OR_MODEL = process.env.OPENROUTER_MODEL || '';
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PASSWORD = process.env.APP_PASSWORD || '';

// sessão: cookie assinado (expiração + HMAC). Trocar a senha encerra todas as sessões.
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('desapego:' + PASSWORD).digest('hex');
const SESSION_DAYS = 90;
const sign = (exp) => crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
const sameStr = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
function cookiesOf(req) {
  const o = {};
  for (const part of (req.headers.cookie || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return o;
}
function authorized(req) {
  const c = cookiesOf(req).sess;
  if (c) { const [exp, sig] = c.split('.'); if (exp && sig && Number(exp) > Date.now() && sameStr(sig, sign(exp))) return true; }
  // aceita também senha básica (útil para testes com curl)
  const got = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':');
  return !!got && sameStr(got, PASSWORD);
}
const fails = new Map();
const IMGS = path.join(DATA, 'images');
const DB = path.join(DATA, 'items.json');
fs.mkdirSync(IMGS, { recursive: true });
if (!fs.existsSync(DB)) fs.writeFileSync(DB, '[]');

const readDB = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
const writeDB = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const CFG = path.join(DATA, 'config.json');
const readCfg = () => { try { return { nome: 'Desapego da Nara', whatsapp: '', cidade: '', ...JSON.parse(fs.readFileSync(CFG, 'utf8')) }; } catch { return { nome: 'Desapego da Nara', whatsapp: '', cidade: '' }; } };
const onlyDigits = (s) => String(s || '').split('').filter((c) => c >= '0' && c <= '9').join('');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function body(req, limit = 40e6) {
  return new Promise((res, rej) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > limit) { rej(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { res(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { rej(e); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const PROMPT = `Você ajuda um casal brasileiro a vender itens usados da casa (desapego). Analise as fotos do item.
1. Identifique o produto (marca, modelo, tipo) o melhor possível.
2. Use a busca na web para achar anúncios de produtos iguais ou semelhantes à venda no Brasil (OLX, Mercado Livre, Enjoei, Shopee, Facebook Marketplace etc.) e o preço de novo, quando existir.
3. Estime a condição pelo que se vê nas fotos.
4. Sugira um preço de venda realista em R$ para usado.
Responda SOMENTE com JSON válido (sem markdown), neste formato:
{"titulo":"título curto e vendedor","categoria":"ex: Eletrodomésticos, Móveis, Decoração, Roupas, Brinquedos, Cozinha, Eletrônicos, Livros, Outros","marca_modelo":"","descricao":"descrição atraente em português, 2 a 4 frases, citando medidas/cor/material só se visíveis; não invente defeitos nem funcionalidades","condicao":"Novo | Seminovo | Bom estado | Usado | Com detalhes","condicao_justificativa":"uma frase","preco_novo":número ou null,"preco_min":número,"preco_sugerido":número,"preco_max":número,"confianca":"alta | média | baixa","similares":[{"titulo":"","preco":número ou null,"loja":"","url":""}]}
Seja honesto: se a foto não permitir identificar bem, diga confiança baixa. Use no máximo 6 similares, só com URLs reais encontradas na busca.`;

function parseJson(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('Resposta da IA sem JSON.');
  return JSON.parse(text.slice(a, b + 1));
}

function readImages(files) {
  return files.slice(0, 4).map((f) => path.join(IMGS, path.basename(f))).filter((p) => fs.existsSync(p)).map((p) => fs.readFileSync(p).toString('base64'));
}

async function callGemini(parts, withSearch) {
  const body = { contents: [{ role: 'user', parts }] };
  if (withSearch) body.tools = [{ google_search: {} }];
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': GEMINI_KEY, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'Erro na API do Gemini'), { quota: r.status === 429 });
  return j.candidates?.[0];
}

async function analyzeGemini(files, hint) {
  const imgs = readImages(files);
  if (!imgs.length) throw new Error('Sem imagens.');
  const parts = imgs.map((data) => ({ inline_data: { mime_type: 'image/jpeg', data } }));
  const dica = hint ? ' Dica do dono sobre o item: ' + hint : '';
  parts.push({ text: PROMPT + dica });
  let cand, semBusca = false;
  try {
    cand = await callGemini(parts, true);
  } catch (e) {
    if (!e.quota) throw e;
    // cota da pesquisa na web esgotada: tenta de novo só com a foto
    semBusca = true;
    parts[parts.length - 1] = { text: PROMPT + dica + ' ATENÇÃO: a busca na web está indisponível agora. Estime com base no seu conhecimento, use confianca "baixa" ou "média" e deixe "similares" vazio.' };
    try { cand = await callGemini(parts, false); } catch (e2) {
      throw new Error(e2.quota ? 'Limite gratuito do Gemini atingido. Tente de novo em alguns minutos.' : e2.message);
    }
  }
  const text = (cand?.content?.parts || []).map((p) => p.text || '').join('');
  const out = parseJson(text);
  // links escritos pelo modelo podem ser inventados: usa só as fontes reais da busca
  out.similares = semBusca ? [] : (out.similares || []).map((x) => ({ ...x, url: '' }));
  for (const c of (cand?.groundingMetadata?.groundingChunks || []).slice(0, 6)) {
    if (c.web?.uri) out.similares.push({ titulo: c.web.title || 'Fonte', preco: null, loja: 'fonte da busca', url: c.web.uri });
  }
  if (semBusca) out.aviso = 'Busca na web indisponível (limite gratuito). Preço estimado pelo modelo, sem anúncios de comparação.';
  return out;
}

// OpenRouter: usa modelos gratuitos com imagem. A lista pública muda toda hora, então é consultada em vez de fixada.
let orCache = { t: 0, ids: [] };
async function orFreeModels() {
  if (orCache.ids.length && Date.now() - orCache.t < 3600e3) return orCache.ids;
  try {
    const j = await (await fetch('https://openrouter.ai/api/v1/models')).json();
    const ids = j.data
      .filter((m) => Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0
        && (m.architecture?.input_modalities || []).includes('image')
        && (m.architecture?.output_modalities || []).join() === 'text')
      .map((m) => m.id).filter((id) => id !== 'openrouter/free');
    orCache = { t: Date.now(), ids };
  } catch { /* usa a lista anterior, se houver */ }
  return orCache.ids;
}

async function analyzeOpenRouter(files, hint) {
  const imgs = readImages(files);
  if (!imgs.length) throw new Error('Sem imagens.');
  const dica = hint ? ' Dica do dono sobre o item: ' + hint : '';
  const aviso = ' ATENÇÃO: você não tem acesso à web agora. Estime com base no seu conhecimento, use confianca "baixa" ou "média" e deixe "similares" vazio. Responda só o JSON.';
  const content = imgs.map((d) => ({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + d } }));
  content.push({ type: 'text', text: PROMPT + dica + aviso });
  const candidates = [...new Set([OR_MODEL, 'openrouter/free', ...(await orFreeModels())].filter(Boolean))].slice(0, 4);
  let last;
  for (const model of candidates) {
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OR_KEY, 'content-type': 'application/json', 'X-Title': 'Desapego da Nara' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content }], max_tokens: 1500 }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error?.message || 'Erro no OpenRouter');
      const out = parseJson(j.choices?.[0]?.message?.content || '');
      out.similares = [];
      out.aviso = 'Preço estimado pela IA, sem busca na web. Confira com os botões de pesquisa.';
      return out;
    } catch (e) { last = e; }
  }
  throw last || new Error('Nenhum modelo gratuito disponível agora.');
}

// tenta cada IA configurada, na ordem; se uma falhar (cota, saldo), passa para a próxima
async function analyze(files, hint) {
  const provs = [];
  if (GEMINI_KEY) provs.push(analyzeGemini);
  if (OR_KEY) provs.push(analyzeOpenRouter);
  if (API_KEY) provs.push(analyzeClaude);
  if (!provs.length) throw Object.assign(new Error('Defina GEMINI_API_KEY, OPENROUTER_API_KEY ou ANTHROPIC_API_KEY.'), { code: 501 });
  let first;
  for (const p of provs) {
    try { return await p(files, hint); } catch (e) { first = first || e; }
  }
  throw first;
}

async function analyzeClaude(files, hint) {
  if (!API_KEY) throw Object.assign(new Error('Defina GEMINI_API_KEY (gratuito) ou ANTHROPIC_API_KEY para ativar a busca automática.'), { code: 501 });
  const content = [];
  for (const f of files.slice(0, 4)) {
    const p = path.join(IMGS, path.basename(f));
    if (!fs.existsSync(p)) continue;
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(p).toString('base64') } });
  }
  if (!content.length) throw new Error('Sem imagens.');
  content.push({ type: 'text', text: PROMPT + (hint ? `\nDica do dono sobre o item: ${hint}` : '') });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 4000,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content }],
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || 'Erro na API');
  const text = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Resposta da IA sem JSON.');
  return JSON.parse(m[0]);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    const open = p === '/vitrine.html' || p === '/manifest.webmanifest' || p === '/favicon.ico' || p === '/icon.svg' || p.startsWith('/icons/') || p === '/api/public' || p.startsWith('/img/') || p === '/healthz' || p === '/login' || p === '/api/login' || p === '/api/logout';
    if (!PASSWORD && process.env.RENDER && !open) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Defina APP_PASSWORD no painel do Render para liberar o editor.');
    }
    if (PASSWORD && !open && !authorized(req)) {
      if (p.startsWith('/api/')) return send(res, 401, { error: 'Sessão expirada. Entre de novo.' });
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    if (p === '/login') {
      if (!PASSWORD || authorized(req)) { res.writeHead(302, { Location: '/' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(path.join(PUB, 'login.html')).pipe(res);
    }
    if (p === '/api/login' && req.method === 'POST') {
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const f = fails.get(ip);
      const cnt = f && Date.now() - f.t < 600e3 ? f.n : 0;
      if (cnt >= 8) return send(res, 429, { error: 'Muitas tentativas. Espere alguns minutos.' });
      const { senha } = await body(req, 1e4);
      if (!PASSWORD || !sameStr(senha || '', PASSWORD)) {
        fails.set(ip, { n: cnt + 1, t: Date.now() });
        await new Promise((r) => setTimeout(r, 500));
        return send(res, 401, { error: 'Senha incorreta' });
      }
      fails.delete(ip);
      const exp = Date.now() + SESSION_DAYS * 864e5;
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      res.setHeader('Set-Cookie', `sess=${exp}.${sign(exp)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax${secure}`);
      return send(res, 200, { ok: 1 });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      res.setHeader('Set-Cookie', 'sess=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
      return send(res, 200, { ok: 1 });
    }
    if (p === '/healthz') return send(res, 200, { ok: 1 });
    if (p === '/api/public') {
      const { nome, whatsapp, cidade } = readCfg();
      const items = readDB().filter((i) => i.status === 'Disponível').map(({ id, titulo, categoria, descricao, condicao, preco, fotos }) => ({ id, titulo, categoria, descricao, condicao, preco, fotos }));
      return send(res, 200, { config: { nome, whatsapp, cidade }, items });
    }
    if (p === '/api/config' && req.method === 'GET') return send(res, 200, readCfg());
    if (p === '/api/config' && req.method === 'PUT') {
      const b = await body(req);
      const cfg = { nome: String(b.nome || 'Desapego da Nara').slice(0, 60), whatsapp: onlyDigits(b.whatsapp).slice(0, 15), cidade: String(b.cidade || '').slice(0, 60) };
      fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
      return send(res, 200, cfg);
    }
    if (p === '/api/status') return send(res, 200, { ai: !!(GEMINI_KEY || OR_KEY || API_KEY) });
    if (p === '/api/items' && req.method === 'GET') return send(res, 200, readDB());
    if (p === '/api/items' && req.method === 'POST') {
      const it = await body(req); it.id = crypto.randomUUID(); it.criado = Date.now();
      const db = readDB(); db.unshift(it); writeDB(db); return send(res, 200, it);
    }
    const mi = p.match(/^\/api\/items\/([\w-]+)$/);
    if (mi) {
      const db = readDB(); const i = db.findIndex((x) => x.id === mi[1]);
      if (i < 0) return send(res, 404, { error: 'não encontrado' });
      if (req.method === 'PUT') { db[i] = { ...db[i], ...(await body(req)), id: mi[1] }; writeDB(db); return send(res, 200, db[i]); }
      if (req.method === 'DELETE') { db.splice(i, 1)[0].fotos?.forEach((f) => { const b = path.basename(f); fs.rmSync(path.join(IMGS, b), { force: true }); fs.rmSync(path.join(IMGS, b.replace('.jpg', '.t.jpg')), { force: true }); }); writeDB(db); return send(res, 200, { ok: 1 }); }
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const { dataUrl, thumb } = await body(req);
      const b64 = String(dataUrl).split(',')[1]; if (!b64) throw new Error('imagem inválida');
      const name = crypto.randomUUID() + '.jpg';
      fs.writeFileSync(path.join(IMGS, name), Buffer.from(b64, 'base64'));
      const tb = thumb ? String(thumb).split(',')[1] : '';
      if (tb) fs.writeFileSync(path.join(IMGS, name.replace('.jpg', '.t.jpg')), Buffer.from(tb, 'base64'));
      return send(res, 200, { name });
    }
    if (p === '/api/analyze' && req.method === 'POST') {
      const { fotos, dica } = await body(req);
      return send(res, 200, await analyze(fotos || [], dica));
    }
    if (p.startsWith('/img/')) {
      const f = path.join(IMGS, path.basename(p));
      if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=31536000' }); return fs.createReadStream(f).pipe(res);
    }
    // estáticos
    let f = path.join(PUB, p === '/' ? 'index.html' : p);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('404'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) {
    send(res, e.code === 501 ? 501 : 500, { error: e.message });
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`\nDesapego da Nara rodando!\n  Neste PC:  http://localhost:${PORT}`);
  for (const l of Object.values(os.networkInterfaces()).flat()) if (l.family === 'IPv4' && !l.internal) console.log(`  No celular (mesmo Wi-Fi): http://${l.address}:${PORT}`);
  const ias = [GEMINI_KEY && `Gemini (${GEMINI_MODEL})`, OR_KEY && 'OpenRouter (modelos gratuitos)', API_KEY && 'Claude'].filter(Boolean);
  console.log(ias.length ? `  IA: ${ias.join(' > ')}\n` : '  IA: DESATIVADA (defina GEMINI_API_KEY, OPENROUTER_API_KEY ou ANTHROPIC_API_KEY)\n');
});
