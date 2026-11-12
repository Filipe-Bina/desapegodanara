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
const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = process.env.DATA_DIR || path.join(ROOT, 'data');
const PASSWORD = process.env.APP_PASSWORD || '';
const IMGS = path.join(DATA, 'images');
const DB = path.join(DATA, 'items.json');
fs.mkdirSync(IMGS, { recursive: true });
if (!fs.existsSync(DB)) fs.writeFileSync(DB, '[]');

const readDB = () => JSON.parse(fs.readFileSync(DB, 'utf8'));
const writeDB = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
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

async function analyze(files, hint) {
  if (GEMINI_KEY) return analyzeGemini(files, hint);
  return analyzeClaude(files, hint);
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
    const open = p === '/vitrine.html' || p === '/manifest.webmanifest' || p === '/favicon.ico' || p === '/api/public' || p.startsWith('/img/') || p === '/healthz';
    if (!PASSWORD && process.env.RENDER && !open) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Defina APP_PASSWORD no painel do Render para liberar o editor.');
    }
    if (PASSWORD && !open) {
      const got = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':').slice(1).join(':');
      const a = Buffer.from(got), b = Buffer.from(PASSWORD);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Desapego"' }); return res.end('Senha necessaria'); }
    }
    if (p === '/healthz') return send(res, 200, { ok: 1 });
    if (p === '/api/public') return send(res, 200, readDB().filter((i) => i.status === 'Disponível').map(({ id, titulo, categoria, descricao, condicao, preco, fotos }) => ({ id, titulo, categoria, descricao, condicao, preco, fotos })));
    if (p === '/api/status') return send(res, 200, { ai: !!(GEMINI_KEY || API_KEY) });
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
      if (req.method === 'DELETE') { db.splice(i, 1)[0].fotos?.forEach((f) => fs.rmSync(path.join(IMGS, path.basename(f)), { force: true })); writeDB(db); return send(res, 200, { ok: 1 }); }
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const { dataUrl } = await body(req);
      const b64 = String(dataUrl).split(',')[1]; if (!b64) throw new Error('imagem inválida');
      const name = crypto.randomUUID() + '.jpg';
      fs.writeFileSync(path.join(IMGS, name), Buffer.from(b64, 'base64'));
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
  console.log(GEMINI_KEY ? `  IA: Gemini (${GEMINI_MODEL})\n` : API_KEY ? '  IA: Claude\n' : '  IA: DESATIVADA (defina GEMINI_API_KEY ou ANTHROPIC_API_KEY)\n');
});
