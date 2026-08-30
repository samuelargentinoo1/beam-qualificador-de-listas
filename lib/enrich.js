'use strict';
// Passo 3 — Enriquecimento com CRUZAMENTO de dados.
//
// Fluxo por empresa:
//   0. Nº de avaliações (página do lugar, se a lista do Maps não mostrou). <10 corta.
//   1. SITE oficial (obrigatório): Instagram que o site aponta + CNPJ impresso no rodapé.
//   2. CNPJ:
//        descoberta → rodapé do site ▸ busca do cnpj.biz ▸ DuckDuckGo (fallbacks)
//        dados/QSA  → API pública oficial SEM CAPTCHA (BrasilAPI ▸ minhareceita),
//                     página do cnpj.biz só como último recurso.
//   3. Validação do CNPJ: cidade bate + situação ATIVA + (nome bate OU TELEFONE bate
//      com o da Receita) — resolve nome fantasia ≠ razão social.
//   4. Decisor = sócio-administrador do QSA (ou o empresário, no caso de MEI/EI).
//
// Anti-bot: as consultas de dados saem por API (sem captcha). Se cnpj.biz/DDG
// mostrarem desafio na fase de DESCOBERTA, o log avisa e o pipeline espera você
// resolver na janela do Chrome (perfil persistente guarda a liberação).

const {
  norm, cleanCompanyName, distinctiveTokens, jitter, sleep,
  instagramHandles, brandFromUrl, extractCnpjs, personCase,
} = require('./util');

// ------------------------------------------------------------ desafios/captcha
// Política: bloqueio de segurança NUNCA descarta lead. A fonte bloqueada entra
// em pausa (10min) e as alternativas assumem; o lead só é "adiado" se TODAS
// estiverem fora — e aí volta pra fila / próxima rodada.
const sourceHealth = {}; // { fonte: timestamp de "pausado até" }
const isPaused = fonte => (sourceHealth[fonte] || 0) > Date.now();
function pauseSource(fonte, log, min = 10) {
  sourceHealth[fonte] = Date.now() + min * 60000;
  log(`⏸ ${fonte} bloqueado pela segurança — pausado ${min}min; usando fontes alternativas (nenhum lead é descartado por isso).`);
}

async function waitChallenge(page, isBlockedFn, label, log, maxMs = 30000) {
  const start = Date.now();
  let warned = false;
  while (Date.now() - start < maxMs) {
    const blocked = await page.evaluate(isBlockedFn).catch(() => true);
    if (!blocked) return true;
    if (!warned) {
      log(`⚠️ ${label} pediu verificação anti-robô — se estiver vendo a janela do Chrome, resolva; senão eu troco de fonte em ${Math.round(maxMs / 1000)}s…`);
      warned = true;
    }
    await sleep(5000);
  }
  return false;
}

const DDG_BLOCKED = () =>
  /bots use DuckDuckGo|challenge to confirm/i.test(document.body.innerText.slice(0, 800)) &&
  !document.querySelector('.result__a');

const CNPJBIZ_BLOCKED = () =>
  /Network Check|检测到您的网络/i.test(document.body.innerText.slice(0, 800));

// ------------------------------------------------- APIs públicas (sem captcha)
async function fetchJson(url, timeoutMs = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json' } });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json() };
  } catch {
    return { ok: false, status: 0 }; // rede/timeout
  } finally {
    clearTimeout(t);
  }
}

/**
 * Dados oficiais do CNPJ via API (Receita Federal, sem captcha).
 * BrasilAPI → minhareceita.
 * Retorna { miss: 'notFound' } p/ CNPJ inexistente (número inválido — descarta o
 * candidato) e { miss: 'down' } quando as APIs estão fora (adia, não descarta).
 */
async function fetchCnpjApi(digits) {
  let notFound = 0, down = 0;
  const take = r => {
    if (r.ok && r.data && r.data.razao_social) return r.data;
    if (r.status === 404 || r.status === 400) notFound++; else down++;
    return null;
  };
  let d = take(await fetchJson(`https://brasilapi.com.br/api/cnpj/v1/${digits}`));
  if (d) {
    return {
      fonte: 'BrasilAPI',
      razao: d.razao_social || '',
      fantasia: d.nome_fantasia || '',
      municipio: d.municipio || '',
      uf: d.uf || '',
      situacao: d.descricao_situacao_cadastral || '',
      natureza: d.natureza_juridica || '',
      telefones: [d.ddd_telefone_1, d.ddd_telefone_2].filter(Boolean).map(String),
      qsa: (d.qsa || []).map(s => ({ nome: s.nome_socio || '', papel: s.qualificacao_socio || '' })),
    };
  }
  d = take(await fetchJson(`https://minhareceita.org/${digits}`));
  if (d) {
    return {
      fonte: 'minhareceita',
      razao: d.razao_social || '',
      fantasia: d.nome_fantasia || '',
      municipio: d.municipio || '',
      uf: d.uf || '',
      situacao: d.descricao_situacao_cadastral || '',
      natureza: d.natureza_juridica || '',
      telefones: [
        d.ddd_telefone_1 || (d.ddd1 ? `${d.ddd1}${d.telefone1 || ''}` : ''),
        d.ddd_telefone_2 || (d.ddd2 ? `${d.ddd2}${d.telefone2 || ''}` : ''),
      ].filter(Boolean).map(String),
      qsa: (d.qsa || []).map(s => ({ nome: s.nome_socio || '', papel: s.qualificacao_socio || '' })),
    };
  }
  return { miss: down > 0 ? 'down' : 'notFound' };
}

/**
 * Extrai o decisor do QSA: sócio-administrador; na falta dele, o empresário
 * individual/MEI (nesse caso a razão social É o nome da pessoa).
 * Retorna { decisor, outros } — decisor vazio significa "não achei".
 */
function decisorFromQsa(data) {
  const admins = data.qsa.filter(s => /administrador|titular/i.test(s.papel)).map(s => s.nome);
  const socios = data.qsa.filter(s => !/administrador|titular/i.test(s.papel)).map(s => s.nome);
  let decisor = admins[0] || '';
  if (!decisor && !data.qsa.length && /empres[áa]ri[oa]/i.test(data.natureza)) {
    decisor = data.razao.replace(/\s+\d{11}$/, ''); // MEI/EI: razão social = nome da pessoa
  }
  return { decisor, outros: [...admins.slice(1), ...socios] };
}

/** Valida o registro oficial contra o lead do Maps e extrai decisor/sócios. */
function evaluateCnpj(data, cand, city, uf, digits) {
  if (!data) return { ok: false, reason: 'API de CNPJ indisponível' };

  // cidade (e UF, se informada) precisam bater
  if (!norm(data.municipio).includes(norm(city)) && !norm(city).includes(norm(data.municipio))) {
    return { ok: false, reason: 'cidade não bate' };
  }
  if (uf && data.uf && data.uf.toUpperCase() !== uf.toUpperCase()) {
    return { ok: false, reason: 'UF não bate' };
  }
  if (/baixada|inapta|suspensa/i.test(data.situacao)) {
    return { ok: false, reason: `situação ${data.situacao.toLowerCase()}` };
  }

  // nome OU telefone precisam bater (fantasia ≠ razão social é comum)
  const toks = distinctiveTokens(cand.displayName || cand.name, city);
  const hay = norm(data.razao + ' ' + data.fantasia);
  const nameOk = toks.length === 0 || toks.some(t => hay.includes(t));
  const candTel = String(cand.phone || '').replace(/\D/g, '').slice(-8);
  const telOk = !!candTel && data.telefones.some(t => String(t).replace(/\D/g, '').endsWith(candTel));
  if (!nameOk && !telOk) return { ok: false, reason: 'nem nome nem telefone batem com a Receita' };

  // decisor: sócio-administrador (ou empresário individual/MEI)
  const { decisor, outros: outrosRaw } = decisorFromQsa(data);
  if (!decisor) return { ok: false, reason: 'sem sócio-administrador no QSA' };

  const fmt = digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  const outros = outrosRaw.map(personCase);
  return {
    ok: true,
    cnpj: fmt,
    decisor: personCase(decisor),
    socios: outros.join('; '),
    matchBy: telOk ? (nameOk ? 'nome+telefone' : 'telefone (Receita)') : 'nome',
  };
}

// --------------------------------------------------------------- Site oficial
/** Abre o site: Instagram que ELE aponta + CNPJs impressos na página (rodapé). */
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
      const info = await page.evaluate(() => ({
        links: Array.from(document.querySelectorAll('a[href*="instagram.com"]')).map(a => a.href),
        text: document.body.innerText.slice(0, 30000),
      }));
      return {
        ok: true,
        finalUrl: page.url(),
        handles: instagramHandles(info.links),
        cnpjsOnSite: extractCnpjs(info.text),
      };
    } catch (e) {
      log(`site não abriu (${target.slice(0, 60)}…): ${String(e.message).split('\n')[0].slice(0, 80)}`);
    }
  }
  return { ok: false, handles: [], cnpjsOnSite: [] };
}

// ------------------------------------------------------- descoberta de CNPJ
/** Busca nativa do cnpj.biz: /procura/<termo> → links cnpj.biz/<14 dígitos>. */
async function cnpjBizSearch(page, term, log) {
  if (isPaused('cnpj.biz')) return { links: [], blocked: true };
  try {
    await page.goto('https://cnpj.biz/procura/' + encodeURIComponent(term),
      { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    const liberado = await waitChallenge(page, CNPJBIZ_BLOCKED, 'cnpj.biz', log);
    if (!liberado) { pauseSource('cnpj.biz', log); return { links: [], blocked: true }; }
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href*="cnpj.biz/"]'))
        .map(a => ({ href: a.href, text: (a.innerText || '').trim() }))
        .filter(l => /cnpj\.biz\/\d{14}\/?$/.test(l.href)));
    return { links, blocked: false };
  } catch (e) {
    log(`cnpj.biz/procura falhou: ${String(e.message).split('\n')[0].slice(0, 80)}`);
    return { links: [], blocked: true };
  }
}

/**
 * O Bing não entrega o link do site no href: entrega um redirecionador
 * (bing.com/ck/a?…&u=a1<base64url do destino>…). Abrir esse endereço direto
 * custou 12 min de timeout num teste — então resolvemos ANTES de navegar.
 * Ordem: decodifica o parâmetro u ▸ usa o endereço exibido (cite) ▸ desiste.
 */
function resolveBingUrl(href, display) {
  const u = String(href || '');
  if (!/bing\.com\/ck\//i.test(u)) return u;

  try {
    const p = new URL(u).searchParams.get('u') || '';
    // o valor vem com um prefixo curto ("a1") antes do base64url
    const b64 = p.replace(/^a\d/, '').replace(/-/g, '+').replace(/_/g, '/');
    const alvo = Buffer.from(b64, 'base64').toString('utf8');
    if (/^https?:\/\/\S+$/.test(alvo)) return alvo;
  } catch { /* cai pro endereço exibido */ }

  const d = String(display || '').split(/\s|›|»/)[0].trim();
  if (d && /\.[a-z]{2,}/i.test(d)) return /^https?:\/\//i.test(d) ? d : 'https://' + d;
  return '';
}

/** Bing raramente desafia automação — ótima fonte alternativa de descoberta. */
async function bingSearch(page, query, log) {
  if (isPaused('Bing')) return { results: [], blocked: true };
  try {
    await page.goto('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=pt-BR',
      { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
    const info = await page.evaluate(() => ({
      challenged: /confirm.{0,20}human|verifica|unusual traffic/i.test(document.body.innerText.slice(0, 600)) &&
        !document.querySelector('li.b_algo'),
      results: Array.from(document.querySelectorAll('li.b_algo')).map(r => {
        const a = r.querySelector('h2 a');
        const cite = r.querySelector('cite');
        return {
          title: a?.innerText?.trim() || '',
          url: a?.href || '',
          // endereço EXIBIDO no resultado: é o destino real, sem o redirect do Bing
          display: cite?.innerText?.trim() || '',
          snippet: (r.innerText || '').slice(0, 250),
        };
      }).filter(x => x.title),
    }));
    if (info.challenged) { pauseSource('Bing', log); return { results: [], blocked: true }; }
    // o href do Bing é um redirecionador (bing.com/ck/a?…u=…) — nunca navegue nele
    const results = info.results.map(x => ({ ...x, url: resolveBingUrl(x.url, x.display) }));
    return { results, blocked: false };
  } catch (e) {
    log(`Bing falhou: ${String(e.message).split('\n')[0].slice(0, 80)}`);
    return { results: [], blocked: true };
  }
}

async function ddgSearch(page, query, log) {
  if (isPaused('DuckDuckGo')) return { results: [], blocked: true };
  try {
    const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1200);
    const liberado = await waitChallenge(page, DDG_BLOCKED, 'DuckDuckGo', log);
    if (!liberado) { pauseSource('DuckDuckGo', log); return { results: [], blocked: true }; }
    const results = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.result__body, .result')).map(r => {
        const a = r.querySelector('a.result__a');
        const s = r.querySelector('.result__snippet');
        let u = a?.href || '';
        const m = u.match(/uddg=([^&]+)/);
        if (m) try { u = decodeURIComponent(m[1]); } catch {}
        return { title: a?.innerText?.trim() || '', url: u, snippet: s?.innerText?.trim() || '' };
      }).filter(x => x.title && !/duckduckgo\.com\/y\.js|ad_domain/.test(x.url));
    });
    return { results, blocked: false };
  } catch (e) {
    log(`DuckDuckGo falhou: ${String(e.message).split('\n')[0].slice(0, 80)}`);
    return { results: [], blocked: true };
  }
}

/**
 * Descobre e valida o CNPJ do lead. Ordem das fontes de DESCOBERTA:
 *   1. CNPJ impresso no próprio site (rodapé) — máxima confiança, zero requisição extra
 *   2. Busca do cnpj.biz pelo nome / marca do domínio
 *   3. Bing   4. DuckDuckGo   (rotação automática quando uma fonte bloqueia)
 * Os DADOS (QSA/cidade/telefone) vêm sempre da API oficial (sem captcha).
 *
 * Retorno em caso de falha: { ok:false, reason, blocked } — blocked=true significa
 * "não deu pra procurar direito porque a segurança barrou": o lead NÃO deve ser
 * descartado, e sim adiado (volta pra fila / próxima rodada).
 */
async function findCnpjAndQsa(page, cand, city, uf, siteInfo, log) {
  const tried = new Set();
  let anyBlocked = false;
  let apiDown = 0;

  const tryDigits = async (digits, origem) => {
    if (!digits || tried.has(digits)) return null;
    tried.add(digits);
    const data = await fetchCnpjApi(digits);
    if (data.miss === 'down') { apiDown++; log(`API de CNPJ fora do ar p/ ${digits} — vou adiar em vez de descartar`); return null; }
    if (data.miss === 'notFound') { log(`CNPJ ${digits} (${origem}): inexistente na Receita — número inválido`); return null; }
    const r = evaluateCnpj(data, cand, city, uf, digits);
    if (r.ok) {
      log(`CNPJ validado via ${origem} (bateu por ${r.matchBy})`);
      return r;
    }
    log(`CNPJ ${digits} (${origem}) descartado: ${r.reason}`);
    return null;
  };

  // ---- 1) rodapé do próprio site
  for (const digits of (siteInfo.cnpjsOnSite || []).slice(0, 3)) {
    const r = await tryDigits(digits, 'rodapé do site');
    if (r) return r;
    await jitter(300, 700);
  }

  // ---- 2) busca do cnpj.biz (nome e marca do domínio)
  const cname = cleanCompanyName(cand.displayName || cand.name);
  const brand = brandFromUrl(siteInfo.finalUrl || cand.website);
  const toks = distinctiveTokens(cand.displayName || cand.name, city);
  const terms = [...new Set([
    `${cname} ${city}`,
    brand && brand !== norm(cname) ? `${brand} ${city}` : '',
    cname,
  ].filter(Boolean))];

  for (const term of terms) {
    const { links, blocked } = await cnpjBizSearch(page, term, log);
    if (blocked) { anyBlocked = true; break; }
    const scored = links
      .map(l => ({ ...l, score: toks.filter(t => norm(l.text).includes(t)).length }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    for (const l of scored) {
      const digits = (l.href.match(/(\d{14})/) || [])[1];
      const r = await tryDigits(digits, 'busca cnpj.biz');
      if (r) return r;
      await jitter(300, 700);
    }
    if (links.length) break; // busca funcionou; não insistir com termo mais vago
    await jitter(800, 1500);
  }

  // ---- 3) Bing e 4) DuckDuckGo (rotação de buscadores)
  const query = `CNPJ ${cname} ${city} ${uf || ''}`.trim();
  for (const engine of [
    { name: 'Bing', run: () => bingSearch(page, query, log) },
    { name: 'DuckDuckGo', run: () => ddgSearch(page, query, log) },
  ]) {
    const { results, blocked } = await engine.run();
    if (blocked) { anyBlocked = true; continue; }
    const digitsList = [];
    for (const r of results) {
      const m = r.url.match(/(\d{14})/) || (r.title + ' ' + r.snippet).match(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/);
      if (m) digitsList.push(String(m[1] || m[0]).replace(/\D/g, ''));
    }
    for (const digits of [...new Set(digitsList)].slice(0, 3)) {
      const r = await tryDigits(digits, engine.name);
      if (r) return r;
      await jitter(300, 700);
    }
    if (results.length) break; // buscador respondeu; se não achou CNPJ, não insistir no próximo
  }

  // Se não examinamos NENHUM candidato e houve bloqueio/API fora → adiar, não descartar.
  const blocked = (tried.size === 0 && anyBlocked) || apiDown > 0;
  return { ok: false, reason: 'CNPJ não encontrado/validado', blocked };
}

// ------------------------------------------------- nº de avaliações (lazy)
async function checkReviews(page, placeUrl, log) {
  try {
    await page.goto(placeUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(2500);
    const n = await page.evaluate(() => {
      const t = document.body.innerText.slice(0, 4000);
      let m = t.match(/([\d.,]+)\s*(?:avalia[çc]|coment[áa]rio|review)/i);
      if (m) return parseInt(m[1].replace(/[.,]/g, ''), 10);
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
/** Enriquece 1 empresa. Retorna { ok:true, lead } ou { ok:false, reason }. */
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

  // 1) SITE primeiro (critério de corte da Ferramenta + fonte do Instagram e do CNPJ)
  const site = await verifySite(page, cand.website, log);
  if (!site.ok) return { ok: false, reason: 'site inacessível' };

  const igHandle = site.handles.length ? site.handles[0] : '';
  const instagram = igHandle ? '@' + igHandle : 'não encontrado';
  const instagramUrl = igHandle ? `https://www.instagram.com/${igHandle}/` : '';
  const igStatus = igHandle ? 'confirmado no site' : 'site sem link de Instagram';
  if (site.cnpjsOnSite.length) log(`CNPJ no rodapé do site: ${site.cnpjsOnSite.length} candidato(s)`);

  await jitter(800, 1600);

  // 2) CNPJ + QSA (decisor) — dados pela API oficial, sem captcha
  const qsa = await findCnpjAndQsa(page, cand, city, uf, site, log);
  if (!qsa.ok) return { ok: false, reason: qsa.reason, blocked: !!qsa.blocked };

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

// ==========================================================================
// MODO PLANILHA — o alvo vem do banco do usuário (nome + CNPJ), não do Maps.
//
// A ordem se inverte em relação ao fluxo do Maps: lá o site vinha de graça e o
// CNPJ era a incógnita; aqui o CNPJ é certo e o SITE é a incógnita. Por isso o
// site é descoberto por busca, e é o único ponto que pode travar por anti-bot.
// ==========================================================================

// Domínios que nunca são o site oficial da empresa: redes sociais, portais de
// imóveis, agregadores de CNPJ e diretórios. Se o buscador devolver um desses,
// pulamos — senão o "site do lead" viraria o perfil dele no ZAP.
const NAO_E_SITE_OFICIAL = [
  'instagram.com', 'facebook.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com',
  'tiktok.com', 'wa.me', 'whatsapp.com', 'google.com', 'goo.gl', 'maps.app.goo.gl',
  // rede de segurança: se um redirecionador de buscador escapar, não navegamos nele
  'bing.com', 'duckduckgo.com', 'search.yahoo',
  'vivareal.com', 'zapimoveis.com', 'olx.com', 'imovelweb.com', 'quintoandar.com',
  'chavesnamao.com', 'netimoveis.com', 'wimoveis.com', 'casamineira.com',
  'cnpj.biz', 'econodata.com', 'empresascnpj', 'consultacnpj', 'cnpja.com', 'casadosdados',
  'solutudo.com', 'apontador.com', 'telelistas.net', 'guiamais.com', 'encontraniteroi',
  'reclameaqui.com', 'jusbrasil.com', 'escavador.com', 'creci',
];

const ehSiteOficial = url => {
  const u = String(url || '').toLowerCase();
  return /^https?:\/\//.test(u) && !NAO_E_SITE_OFICIAL.some(d => u.includes(d));
};

/**
 * Procura o site oficial da empresa a partir do nome + cidade.
 * Rotaciona Bing → DuckDuckGo (a mesma política do resto do arquivo: bloqueio
 * de segurança nunca vira descarte, vira adiamento).
 *
 * Retorna { url, blocked } — url vazia com blocked=false significa
 * "procurei e a empresa realmente não tem site".
 */
async function findOfficialSite(page, { nome, razao, cidade, uf }, log) {
  const marca = cleanCompanyName(nome || razao);
  const toks = distinctiveTokens(marca, cidade);
  const local = [cidade, uf].filter(Boolean).join(' ');

  // Duas tentativas: a 1ª com "site oficial" ancora melhor; a 2ª é mais aberta.
  const buscas = [`${marca} ${local} site oficial`, `"${marca}" ${local}`];
  let algumBloqueio = false;

  for (const q of buscas) {
    for (const buscador of [bingSearch, ddgSearch]) {
      const r = await buscador(page, q, log);
      if (r.blocked) { algumBloqueio = true; continue; }

      const candidatos = (r.results || []).filter(x => ehSiteOficial(x.url));
      if (!candidatos.length) continue;

      // Preferimos o resultado cujo DOMÍNIO carrega um token distintivo do nome
      // ("imobiliariaalfa.com.br" para "Imobiliária Alfa"). É o sinal mais forte
      // de que o site é da empresa, e não uma matéria falando dela.
      const comMarca = candidatos.find(x => {
        const brand = norm(brandFromUrl(x.url));
        return brand && toks.some(t => brand.includes(t) || t.includes(brand));
      });
      const escolhido = comMarca || candidatos[0];
      log(`site provável: ${escolhido.url.slice(0, 70)} ${comMarca ? '(domínio bate com o nome)' : '(1º resultado)'}`);
      return { url: escolhido.url, blocked: false };
    }
    await jitter(700, 1400);
  }

  return { url: '', blocked: algumBloqueio };
}

/**
 * Enriquece 1 empresa vinda da PLANILHA (nome + CNPJ).
 *
 * Ordem: Receita (dados + decisor) → site → Instagram. A Receita vem primeiro
 * porque é barata e sem captcha: se o lead já morre aí (baixado, sem sócio-adm),
 * não gastamos busca de site com ele.
 *
 * Retorna { ok:true, lead } | { ok:false, reason, blocked? } — igual ao enrichOne.
 */
async function enrichFromCnpj(page, cand, log) {
  const digits = String(cand.cnpjDigits || cand.cnpj || '').replace(/\D/g, '');
  if (digits.length !== 14) return { ok: false, reason: 'CNPJ inválido na planilha' };

  // 1) Receita — dados oficiais + QSA
  const data = await fetchCnpjApi(digits);
  if (data.miss === 'down') {
    return { ok: false, blocked: true, reason: 'API de CNPJ fora do ar' };
  }
  if (data.miss) return { ok: false, reason: 'CNPJ não existe na base da Receita' };
  // Situação cadastral (baixada/inapta/suspensa) NÃO elimina no modo planilha —
  // decisão do usuário (2026-08-28): a lista do Big Data é soberana. No modo
  // Maps a checagem continua, porque lá ela serve pra escolher o CNPJ certo
  // entre vários candidatos da busca — não pra julgar o lead.

  const { decisor, outros } = decisorFromQsa(data);
  if (!decisor) return { ok: false, reason: 'sem sócio-administrador no QSA' };

  // A cidade/UF saem da Receita, não da planilha: é a fonte confiável e permite
  // que a planilha misture cidades sem o usuário declarar nada.
  const cidade = data.municipio || '';
  const ufLead = data.uf || '';
  const telefone = data.telefones[0]
    ? String(data.telefones[0]).replace(/^(\d{2})(\d{4,5})(\d{4})$/, '($1) $2-$3')
    : '';
  const razao = data.razao || '';
  log(`Receita ✓ ${razao || cand.name} — ${cidade}/${ufLead} | decisor: ${personCase(decisor)}`);

  await jitter(600, 1200);

  // 2) SITE (regra da casa: só lead com site)
  const busca = await findOfficialSite(page, { nome: cand.name, razao, cidade, uf: ufLead }, log);
  if (!busca.url) {
    return busca.blocked
      ? { ok: false, blocked: true, reason: 'buscadores bloqueados — não deu pra procurar o site' }
      : { ok: false, reason: 'site não encontrado' };
  }

  await jitter(600, 1200);

  // 3) Abre o site: confirma que existe + pega o Instagram que ELE aponta
  const site = await verifySite(page, busca.url, log);
  if (!site.ok) return { ok: false, reason: 'site inacessível' };

  const igHandle = site.handles.length ? site.handles[0] : '';
  const instagram = igHandle ? '@' + igHandle : 'não encontrado';
  const instagramUrl = igHandle ? `https://www.instagram.com/${igHandle}/` : '';
  const igStatus = igHandle ? 'confirmado no site' : 'site sem link de Instagram';

  // Conferência de brinde: se o site imprime CNPJ no rodapé e ele bate com o da
  // planilha, o site é comprovadamente da empresa certa.
  const cnpjConfere = site.cnpjsOnSite.includes(digits);
  if (cnpjConfere) log('CNPJ do rodapé do site bate com o da planilha ✓');

  return {
    ok: true,
    lead: {
      ...cand,
      name: cand.name || razao,
      displayName: cand.displayName || cand.name || razao,
      razaoSocial: razao,
      city: cidade,
      uf: ufLead,
      phone: telefone,
      site: site.finalUrl || busca.url,
      siteConfirmadoPorCnpj: cnpjConfere,
      instagram, instagramUrl, igStatus,
      cnpj: digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'),
      decisor: personCase(decisor),
      socios: outros.map(personCase).join('; '),
    },
  };
}

module.exports = {
  enrichOne, enrichFromCnpj, findOfficialSite, decisorFromQsa,
  verifySite, findCnpjAndQsa, ddgSearch, checkReviews, fetchCnpjApi,
};
