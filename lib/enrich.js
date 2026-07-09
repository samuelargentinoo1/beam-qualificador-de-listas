'use strict';
// Passo 3 — Enriquecimento com CRUZAMENTO de dados.
// Para cada empresa:
//   0. Confere o nº de avaliações na página do lugar (quando a lista não mostrou).
//   1. Abre o SITE oficial (obrigatório) → extrai o Instagram que o próprio site aponta.
//   2. Acha o CNPJ (busca nativa do cnpj.biz; fallback DuckDuckGo) e valida:
//      cidade bate + nome bate + situação ativa.
//   3. Extrai o Quadro Societário (QSA): Decisor = sócio-administrador.
// Só é "qualificado" o lead com site acessível + CNPJ validado + decisor encontrado.
// Instagram só é aceito se o PRÓPRIO SITE apontar (✅ confirmado no site).
//
// Anti-bot: se DDG/cnpj.biz mostrarem desafio, o pipeline AVISA no log e espera
// você resolver na janela do Chrome (perfil persistente guarda a liberação).

const { norm, cleanCompanyName, distinctiveTokens, jitter, sleep, instagramHandles } = require('./util');

// ------------------------------------------------------------ desafios/captcha
async function waitChallenge(page, isBlockedFn, label, log, maxMs = 180000) {
  const start = Date.now();
  let warned = false;
  while (Date.now() - start < maxMs) {
    const blocked = await page.evaluate(isBlockedFn).catch(() => true);
    if (!blocked) return true;
    if (!warned) {
      log(`⚠️ ${label} pediu verificação anti-robô — resolva o desafio na janela do Chrome que eu continuo…`);
      warned = true;
    }
    await sleep(5000);
  }
  log(`⏱ ${label}: desafio não resolvido em ${Math.round(maxMs / 60000)}min — seguindo sem essa fonte.`);
  return false;
}

const DDG_BLOCKED = () =>
  /bots use DuckDuckGo|challenge to confirm/i.test(document.body.innerText.slice(0, 800)) &&
  !document.querySelector('.result__a');

const CNPJBIZ_BLOCKED = () =>
  /Network Check|检测到您的网络/i.test(document.body.innerText.slice(0, 800));

// ---------------------------------------------------------------- DuckDuckGo
async function ddgSearch(page, query, log) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);
  await waitChallenge(page, DDG_BLOCKED, 'DuckDuckGo', log, 120000);
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('.result__body, .result')).map(r => {
      const a = r.querySelector('a.result__a');
      const s = r.querySelector('.result__snippet');
      let u = a?.href || '';
      const m = u.match(/uddg=([^&]+)/);
      if (m) try { u = decodeURIComponent(m[1]); } catch {}
      return { title: a?.innerText?.trim() || '', url: u, snippet: s?.innerText?.trim() || '' };
    }).filter(x => x.title && !/duckduckgo\.com\/y\.js|ad_domain/.test(x.url));
  });
}

// --------------------------------------------------------------- Site oficial
/** Abre o site e devolve os handles de Instagram que ELE aponta. */
async function verifySite(page, siteUrl, log) {
  const tryUrls = [];
  let u = String(siteUrl || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  tryUrls.push(u);
  if (u.startsWith('http://')) tryUrls.push(u.replace('http://', 'https://'));

  for (const target of tryUrls) {
    try {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(2500); // deixa o rodapé/scripts renderizarem
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href*="instagram.com"]')).map(a => a.href));
      const handles = instagramHandles(links);
      return { ok: true, finalUrl: page.url(), handles };
    } catch (e) {
      log(`site não abriu (${target.slice(0, 60)}…): ${String(e.message).split('\n')[0].slice(0, 80)}`);
    }
  }
  return { ok: false, handles: [] };
}

// ------------------------------------------------------------------ CNPJ/QSA
/** Busca nativa do cnpj.biz: /procura/<termo> → links cnpj.biz/<14 dígitos>. */
async function cnpjBizSearch(page, term, log) {
  try {
    await page.goto('https://cnpj.biz/procura/' + encodeURIComponent(term),
      { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    await waitChallenge(page, CNPJBIZ_BLOCKED, 'cnpj.biz', log);
    return await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="cnpj.biz/"]'))
        .map(a => ({ href: a.href, text: (a.innerText || '').trim() }))
        .filter(l => /cnpj\.biz\/\d{14}\/?$/.test(l.href)));
  } catch (e) {
    log(`cnpj.biz/procura falhou: ${String(e.message).split('\n')[0].slice(0, 80)}`);
    return [];
  }
}

function extractCnpjCandidates(results) {
  const found = [];
  const push = d => { if (d && d.length === 14 && !found.includes(d)) found.push(d); };
  for (const r of results) {
    const mBiz = r.url.match(/cnpj\.biz\/(\d{14})/);
    if (mBiz) push(mBiz[1]);
    const mUrl = r.url.match(/(\d{14})/);
    if (mUrl) push(mUrl[1]);
    const mTxt = (r.title + ' ' + r.snippet).match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g) || [];
    for (const f of mTxt) push(f.replace(/\D/g, ''));
  }
  return found;
}

/** Abre cnpj.biz/<digits> e valida cidade + nome; extrai QSA. */
async function readCnpjBiz(page, digits, companyName, city, log) {
  try {
    await page.goto('https://cnpj.biz/' + digits, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(1200);
    await waitChallenge(page, CNPJBIZ_BLOCKED, 'cnpj.biz', log);
    const data = await page.evaluate(() => {
      const body = document.body.innerText;
      const i = body.search(/S[oó]cios e Administradores|Quadro Societ/i);
      const qsaBlock = i >= 0 ? body.slice(i, i + 1200) : '';
      return { title: document.title, body: body.slice(0, 20000), qsaBlock };
    });

    // 1) cidade precisa bater
    if (!norm(data.body).includes(norm(city))) return { ok: false, reason: 'cidade não bate' };

    // 2) situação cadastral não pode ser baixada/inapta/suspensa
    if (/baixada|inapta|suspensa/i.test(data.body.slice(0, 6000))) {
      return { ok: false, reason: 'situação cadastral irregular' };
    }

    // 3) nome precisa bater (tokens distintivos no título/razão social)
    const toks = distinctiveTokens(companyName, city);
    const hay = norm(data.title + ' ' + data.body.slice(0, 3000));
    const nameMatches = toks.length === 0 || toks.some(t => hay.includes(t));
    if (!nameMatches) return { ok: false, reason: 'nome não bate com a razão social' };

    // 4) QSA
    const lines = data.qsaBlock.split('\n').map(l => l.trim()).filter(Boolean);
    const admins = [], socios = [];
    for (const l of lines) {
      const m = l.match(/^(.{3,80}?)\s+-\s+(S[oó]cio-Administrador|Administrador|Titular|S[oó]cio)/i);
      if (!m) continue;
      const nome = m[1].trim();
      const papel = m[2].toLowerCase();
      if (papel.includes('administrador') || papel.includes('titular')) admins.push(nome);
      else socios.push(nome);
    }
    if (!admins.length && !socios.length) return { ok: false, reason: 'QSA vazio' };
    if (!admins.length) return { ok: false, reason: 'sem sócio-administrador no QSA' };

    const decisor = admins[0];
    const outros = [...admins.slice(1), ...socios];
    const fmt = digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    return { ok: true, cnpj: fmt, decisor, socios: outros.join('; ') };
  } catch (e) {
    log(`cnpj.biz falhou p/ ${digits}: ${String(e.message).split('\n')[0].slice(0, 80)}`);
    return { ok: false, reason: 'cnpj.biz inacessível' };
  }
}

async function findCnpjAndQsa(page, companyName, city, uf, log) {
  const cname = cleanCompanyName(companyName);
  const toks = distinctiveTokens(companyName, city);
  const tried = new Set();

  // ---- 1ª fonte: busca nativa do cnpj.biz
  const terms = [`${cname} ${city}`, cname];
  for (const term of terms) {
    const links = await cnpjBizSearch(page, term, log);
    // prioriza resultados cujo texto contém algum token distintivo do nome
    const scored = links
      .map(l => ({ ...l, score: toks.filter(t => norm(l.text).includes(t)).length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    for (const l of scored) {
      const digits = (l.href.match(/(\d{14})/) || [])[1];
      if (!digits || tried.has(digits)) continue;
      tried.add(digits);
      await jitter(900, 1800);
      const r = await readCnpjBiz(page, digits, companyName, city, log);
      if (r.ok) return r;
      log(`CNPJ ${digits} descartado: ${r.reason}`);
    }
    if (links.length) break; // a busca funcionou; não insistir com termo mais vago
    await jitter(800, 1500);
  }

  // ---- 2ª fonte (fallback): DuckDuckGo
  const queries = [
    `CNPJ ${cname} ${city} ${uf || ''} cnpj.biz`.trim(),
    `CNPJ ${cname} ${city}`.trim(),
  ];
  for (const q of queries) {
    const results = await ddgSearch(page, q, log);
    const candidates = extractCnpjCandidates(results).filter(d => !tried.has(d)).slice(0, 3);
    for (const digits of candidates) {
      tried.add(digits);
      await jitter(900, 1800);
      const r = await readCnpjBiz(page, digits, companyName, city, log);
      if (r.ok) return r;
      log(`CNPJ ${digits} descartado: ${r.reason}`);
    }
    await jitter(1000, 2000);
  }
  return { ok: false, reason: 'CNPJ não encontrado/validado' };
}

// ------------------------------------------------- nº de avaliações (lazy)
/**
 * Quando a LISTA do Maps não mostra o nº de avaliações (layout experimental),
 * confere na página do lugar — que sempre mostra "N avaliações".
 */
async function checkReviews(page, placeUrl, log) {
  try {
    await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2500);
    const n = await page.evaluate(() => {
      // 1) texto "43 avaliações" / "43 comentários" / "43 reviews"
      const t = document.body.innerText.slice(0, 4000);
      let m = t.match(/([\d.,]+)\s*(?:avalia[çc]|coment[áa]rio|review)/i);
      if (m) return parseInt(m[1].replace(/[.,]/g, ''), 10);
      // 2) aria-label com "avaliações"
      const el = document.querySelector('[aria-label*="avalia" i], [aria-label*="review" i]');
      const al = el?.getAttribute('aria-label') || '';
      m = al.match(/([\d.,]+)/);
      if (m) return parseInt(m[1].replace(/[.,]/g, ''), 10);
      return null;
    });
    return n;
  } catch (e) {
    log(`página do lugar falhou: ${String(e.message).split('\n')[0].slice(0, 70)}`);
    return null;
  }
}

// ------------------------------------------------------------------ Orquestra
/**
 * Enriquece 1 empresa. Retorna { ok:true, lead } ou { ok:false, reason }.
 * lead = { ...cand, instagram, igStatus, cnpj, decisor, socios }
 */
async function enrichOne(page, cand, city, uf, log) {
  // 0) Nº de avaliações (se a lista não mostrou): regra <10 corta.
  if (!(cand.reviews > 0) && cand.placeUrl) {
    const n = await checkReviews(page, cand.placeUrl, log);
    if (n != null) {
      cand.reviews = n;
      if (n < 10) return { ok: false, reason: `<10 avaliações (${n})` };
      log(`avaliações: ${n} ✓`);
    } else {
      log('não consegui ler o nº de avaliações — seguindo mesmo assim');
    }
    await jitter(800, 1600);
  }

  // 1) SITE primeiro (barato e é o critério de corte da Ferramenta)
  const site = await verifySite(page, cand.website, log);
  if (!site.ok) return { ok: false, reason: 'site inacessível' };

  const igHandle = site.handles.length ? site.handles[0] : '';
  const instagram = igHandle ? '@' + igHandle : 'não encontrado';
  const instagramUrl = igHandle ? `https://www.instagram.com/${igHandle}/` : '';
  const igStatus = igHandle ? 'confirmado no site' : 'site sem link de Instagram';

  await jitter(1200, 2400);

  // 2) CNPJ + QSA (decisor)
  const qsa = await findCnpjAndQsa(page, cand.displayName || cand.name, city, uf, log);
  if (!qsa.ok) return { ok: false, reason: qsa.reason };

  return {
    ok: true,
    lead: {
      ...cand,
      site: site.finalUrl || cand.website,
      instagram, instagramUrl, igStatus,
      cnpj: qsa.cnpj, decisor: qsa.decisor, socios: qsa.socios,
    },
  };
}

module.exports = { enrichOne, verifySite, findCnpjAndQsa, ddgSearch, checkReviews };
