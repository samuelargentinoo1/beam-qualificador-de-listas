'use strict';
// Passo 1 — Captura no Google Maps (substitui o Instant Data Scraper).
// Rola a lista de resultados até o fim e extrai: nome, nota, nº avaliações,
// telefone, site, categoria, endereço.

async function acceptConsentIfAny(page) {
  try {
    const btn = page.locator(
      'button:has-text("Aceitar tudo"), button:has-text("Accept all"), button:has-text("Concordo")'
    ).first();
    if (await btn.isVisible({ timeout: 2500 })) await btn.click();
  } catch { /* sem tela de consentimento */ }
}

async function scrapeMaps(page, query, log = () => {}) {
  const url = 'https://www.google.com/maps/search/' + encodeURIComponent(query);
  log(`Maps: buscando "${query}"…`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await acceptConsentIfAny(page);
  await page.waitForTimeout(3500);

  if (page.url().includes('/sorry/')) {
    throw new Error('Google bloqueou a busca (captcha). Tente novamente em alguns minutos.');
  }

  const hasFeed = await page.locator('div[role="feed"]').count();
  if (!hasFeed) {
    log('Maps: sem lista de resultados para essa busca (0 encontrados ou resultado único).');
    return [];
  }

  // Rola o feed até estabilizar ou achar o fim.
  await page.evaluate(async () => {
    const feed = document.querySelector('div[role="feed"]');
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let last = 0, stable = 0, rounds = 0;
    const count = () => feed.querySelectorAll('a[href*="/maps/place/"]').length;
    while (rounds < 60 && stable < 4) {
      feed.scrollTo(0, feed.scrollHeight);
      await sleep(1100);
      const c = count();
      if (/chegou ao final|reached the end/i.test(feed.innerText)) break;
      if (c === last) stable++; else { stable = 0; last = c; }
      rounds++;
    }
  });

  const rows = await page.evaluate(() => {
    const feed = document.querySelector('div[role="feed"]');
    const anchors = Array.from(feed.querySelectorAll('a[href*="/maps/place/"]'));
    const out = [];
    const seen = new Set();
    for (const a of anchors) {
      const name = (a.getAttribute('aria-label') || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      let card = a.parentElement;
      for (let i = 0; i < 4 && card && card.parentElement; i++) {
        card = card.parentElement;
        if (card.querySelector('a[data-value="Website"], a[data-value="Site"]')) break;
      }
      const txt = (card?.innerText || '').replace(/\n+/g, '\n').trim();
      // Nota + nº de avaliações: 1º tenta o aria-label ("4,8 estrelas 123 avaliações"),
      // que é estável mesmo em headless; senão, o padrão "4,8(123)" do texto.
      let rating = '', reviews = 0;
      const ratingEl = card?.querySelector('span[role="img"][aria-label*="estrela" i], span[role="img"][aria-label*="star" i]');
      const al = ratingEl?.getAttribute('aria-label') || '';
      const am = al.match(/([\d.,]+)\s*(?:estrelas?|stars?)[^\d]*([\d.,]*)/i);
      if (am) {
        rating = am[1].replace(',', '.');
        reviews = parseInt((am[2] || '0').replace(/[.,\s]/g, ''), 10) || 0;
      }
      if (!rating || !reviews) {
        const rm = txt.match(/(\d[.,]\d)\s*\((\d[\d. ]*)\)/);
        if (rm) {
          rating = rating || rm[1].replace(',', '.');
          reviews = reviews || parseInt(rm[2].replace(/[. \s]/g, ''), 10) || 0;
        }
      }
      const pm = txt.match(/\((\d{2})\)\s*\d[\d\s-]{6,}/);
      const phone = pm ? pm[0].trim() : '';
      let category = '', address = '';
      const catLine = txt.split('\n').find(l =>
        /·/.test(l) && !/Aberto|Fechado|Fecha|Abre|Temporariamente/i.test(l));
      if (catLine) {
        const parts = catLine.split('·').map(s => s.trim()).filter(Boolean);
        category = parts[0] || '';
        address = parts[parts.length - 1] || '';
      }
      const wa = card?.querySelector('a[data-value="Website"], a[data-value="Site"]');
      const website = wa ? wa.getAttribute('href') : '';
      const placeUrl = a.href || '';
      out.push({ name, rating, reviews, phone, website, category, address, placeUrl });
    }
    return out;
  });

  log(`Maps: ${rows.length} estabelecimentos capturados.`);
  return rows;
}

module.exports = { scrapeMaps };
