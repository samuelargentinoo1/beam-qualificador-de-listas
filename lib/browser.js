'use strict';
// Sessão do navegador da Ferramenta.
// - Usa o Google Chrome instalado (channel "chrome"), sem download extra.
// - PERFIL PERSISTENTE (data/chrome-profile): cookies/desafios resolvidos ficam
//   salvos — anti-bot para de aparecer nas próximas rodadas.
// - JANELA VISÍVEL por padrão: se DDG/cnpj.biz pedirem captcha, você resolve
//   na janela e o pipeline continua sozinho. (HEADLESS=1 para esconder.)

const path = require('path');
const { chromium } = require('playwright-core');

const PROFILE_DIR = path.join(__dirname, '..', 'data', 'chrome-profile');

async function launchSession() {
  const headless = process.env.HEADLESS === '1';
  const opts = {
    channel: 'chrome',
    headless,
    viewport: { width: 1380, height: 860 },
    locale: 'pt-BR',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
    ],
  };
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(PROFILE_DIR, opts);
  } catch (e) {
    try {
      // fallback: Chromium do Playwright (npx playwright install chromium)
      ctx = await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: undefined });
    } catch (e2) {
      throw new Error(
        'Não consegui abrir o navegador. Verifique se o Google Chrome está instalado ' +
        'ou rode: npx playwright install chromium\n' + e.message
      );
    }
  }
  const page = ctx.pages()[0] || await ctx.newPage();
  page.setDefaultTimeout(30000);
  return { page, close: () => ctx.close() };
}

module.exports = { launchSession, PROFILE_DIR };
