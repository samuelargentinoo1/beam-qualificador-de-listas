'use strict';
// Orquestra o pipeline completo de uma geração de lista. Duas origens:
//
//   MAPS (padrão)   captura no Google Maps → limpeza → filtro ledger
//                   → enriquecimento até bater a META (60) → export → ledger/histórico
//
//   PLANILHA        linhas (nome+CNPJ) do banco do usuário → limpeza → filtro ledger
//                   por CNPJ → enriquecimento pela Receita + busca do site → idem
//
// O que muda é só a origem e a incógnita: no Maps o site vem de graça e o CNPJ
// é caçado; na planilha o CNPJ vem pronto e o site é caçado.

const path = require('path');
const { launchSession } = require('./browser');
const { scrapeMaps } = require('./scrape');
const { cleanRows, cleanImported } = require('./clean');
const { enrichOne, enrichFromCnpj } = require('./enrich');
const ledgerLib = require('./ledger');
const { exportList } = require('./exporter');
const { readJson, writeJson, jitter, titleCase, slug } = require('./util');

const BASE = path.join(__dirname, '..');
const META_PATH = path.join(BASE, 'data', 'meta.json');
const LISTS_PATH = path.join(BASE, 'data', 'lists.json');

/** Variações de busca para achar mais candidatos na mesma praça. */
function buildQueries(segment, city, uf) {
  const place = uf ? `${city} ${uf}` : city;
  return [
    `${segment} em ${place}`,
    `${segment} ${place} centro`,
    `${segment} ${place} zona norte`,
    `${segment} ${place} zona sul`,
    `${segment} ${place} zona leste`,
    `${segment} ${place} zona oeste`,
  ];
}

function makeLog(job) {
  return msg => {
    const line = `[${new Date().toLocaleTimeString('pt-BR')}] ${msg}`;
    job.log.push(line);
    if (job.log.length > 500) job.log.splice(0, job.log.length - 500);
    console.log(line);
  };
}

async function runJob(job) {
  // Modo planilha: os alvos vêm do banco do usuário, não do Maps.
  if (Array.isArray(job.rows) && job.rows.length) return runImportJob(job);

  const { segment, city, uf, target } = job;
  const log = makeLog(job);

  const ledger = ledgerLib.load();
  const key = ledgerLib.keyFor(segment, city);
  const alreadyDelivered = ledgerLib.deliveredCount(ledger, key);
  log(`Praça: ${key} — já entregues antes: ${alreadyDelivered}`);

  const session = await launchSession();
  const page = session.page;
  log('Chrome aberto (janela da Ferramenta) — se aparecer captcha, resolva nela que eu continuo.');

  const raw = [];            // tudo que veio do Maps (bruta)
  const cleanedAll = [];     // aprovados na limpeza
  const cutAll = [];         // cortados na limpeza
  const discarded = [];      // reprovados no enriquecimento
  const qualified = [];      // ENTREGA (dados cruzados)
  const seenNames = new Set();
  let queue = [];

  try {
    const queries = buildQueries(segment, city, uf);

    for (let qi = 0; qi < queries.length && qualified.length < target && !job.cancel; qi++) {
      // -------- captura
      job.stage = 'captura';
      let rows = [];
      try {
        rows = await scrapeMaps(page, queries[qi], log);
      } catch (e) {
        log(`Falha na captura "${queries[qi]}": ${e.message}`);
        continue;
      }
      const newRows = rows.filter(r => !seenNames.has(r.name));
      newRows.forEach(r => seenNames.add(r.name));
      raw.push(...newRows);
      job.counts.capturados = raw.length;

      // -------- limpeza
      const { kept, cut } = cleanRows(newRows);
      cutAll.push(...cut);
      // -------- anti-repetido (ledger)
      const { fresh, skipped } = ledgerLib.filterNew(ledger, key, kept);
      cleanedAll.push(...fresh);
      queue.push(...fresh);
      job.counts.limpos = cleanedAll.length;
      job.counts.jaEntregues = (job.counts.jaEntregues || 0) + skipped.length;
      log(`Limpeza: +${kept.length} aprovados, ${cut.length} cortados; ` +
          `${skipped.length} pulados (já entregues/descartados antes); fila: ${queue.length}`);

      // -------- enriquecimento (consome a fila)
      job.stage = 'enriquecimento';
      while (queue.length && qualified.length < target && !job.cancel) {
        const cand = queue.shift();
        job.counts.processando = cand.displayName || cand.name;
        log(`Enriquecendo (${qualified.length + 1}/${target}): ${cand.displayName || cand.name}`);
        let res;
        try {
          res = await enrichOne(page, cand, city, uf, log);
        } catch (e) {
          res = { ok: false, reason: 'erro: ' + String(e.message).split('\n')[0].slice(0, 100) };
        }
        if (res.ok) {
          // DEDUP por CNPJ: Maps lista filiais/prédios da mesma empresa como
          // lugares distintos — mesmo CNPJ = mesmo decisor = 1 lead só.
          const cnpjId = 'cnpj:' + String(res.lead.cnpj).replace(/\D/g, '');
          const dupNaRodada = qualified.find(q => q.cnpj === res.lead.cnpj);
          const dupNoLedger = ledger.entries[key]?.delivered?.[cnpjId];
          if (dupNaRodada || dupNoLedger) {
            const de = dupNaRodada?.displayName || dupNoLedger?.name || 'lista anterior';
            const reason = `duplicado: mesmo CNPJ de "${de}"`;
            discarded.push({ name: cand.displayName || cand.name, reason });
            ledgerLib.markDiscarded(ledger, key, cand, reason);
            job.counts.descartados = discarded.length;
            log(`✖ ${cand.displayName || cand.name} — ${reason}`);
          } else {
            qualified.push(res.lead);
            job.counts.qualificados = qualified.length;
            log(`✅ ${res.lead.displayName} — decisor: ${res.lead.decisor} | IG: ${res.lead.instagram} (${res.lead.igStatus})`);
          }
        } else if (res.blocked) {
          // Falha por SEGURANÇA/fonte fora — nunca vira descarte.
          if (!cand._deferred) {
            cand._deferred = true;
            queue.push(cand); // volta pro FIM da fila (as fontes podem liberar)
            log(`⏸ ${cand.displayName || cand.name} — fontes bloqueadas, volta pro fim da fila (NÃO descartado)`);
          } else {
            // segue bloqueado: fica FORA do ledger → tenta de novo na próxima rodada
            job.counts.adiados = (job.counts.adiados || 0) + 1;
            log(`⏸ ${cand.displayName || cand.name} — adiado para a PRÓXIMA rodada (não descartado)`);
          }
        } else {
          discarded.push({ name: cand.displayName || cand.name, reason: res.reason });
          ledgerLib.markDiscarded(ledger, key, cand, res.reason);
          job.counts.descartados = discarded.length;
          log(`✖ ${cand.displayName || cand.name} — ${res.reason}`);
        }
        await jitter(1500, 3200); // pausa educada entre empresas
        if ((qualified.length + discarded.length) % 20 === 0) {
          log('Pausa longa anti-bloqueio (25s)…');
          await jitter(22000, 30000);
        }
      }

      if (qualified.length < target && qi < queries.length - 1) {
        log(`Meta ainda não batida (${qualified.length}/${target}) — ampliando busca…`);
      }
    }
  } finally {
    await session.close().catch(() => {});
  }

  if (job.cancel && qualified.length === 0) {
    // cancelado sem nada pronto: não gera lista nem grava ledger
    job.stage = 'cancelado';
    job.status = 'cancelado';
    log('Cancelado — nada foi gravado.');
    return null;
  }

  // -------- export + registros (mesmo cancelado/esgotado, salva o que tem)
  job.stage = 'exportando';
  const meta = readJson(META_PATH, { lastListNumber: 0 });
  const n = meta.lastListNumber + 1;

  const out = exportList({
    baseDir: BASE, n, segment, city, uf,
    raw, cleaned: cleanedAll, cut: cutAll, qualified, discarded,
  });

  for (const q of qualified) ledgerLib.markDelivered(ledger, key, q, n);
  ledgerLib.save(ledger);
  meta.lastListNumber = n;
  writeJson(META_PATH, meta);

  // -------- Moskit CRM: toda lista extraída sobe automaticamente
  let moskitResumo = null;
  if (qualified.length) {
    job.stage = 'subindo pro Moskit';
    try {
      const moskit = require('./moskit');
      moskitResumo = await moskit.uploadList(qualified, {
        cidade: titleCase(city), uf,
        // quem pediu a lista no painel → responsável pelos leads no Moskit
        responsibleId: job.moskitUserId, responsavel: job.usuario,
      }, log);
    } catch (e) {
      log(`Moskit: falha geral no upload — ${String(e.message).slice(0, 120)} (a lista local está salva; dá pra reenviar)`);
    }
  }

  const lists = readJson(LISTS_PATH, []);
  const entry = {
    id: `${n}-${slug(city)}-${Date.now()}`,
    n,
    date: new Date().toISOString(),
    segment: titleCase(segment),
    city: titleCase(city),
    uf: uf || '',
    key,
    usuario: job.usuario || null,
    target,
    delivered: qualified.length,
    status: job.cancel ? 'cancelada'
      : qualified.length >= target ? 'completa'
      : 'esgotada',
    totals: {
      capturados: raw.length,
      limpos: cleanedAll.length,
      cortadosLimpeza: cutAll.length,
      descartadosEnriquecimento: discarded.length,
      puladosJaEntregues: job.counts.jaEntregues || 0,
      adiadosPorSeguranca: job.counts.adiados || 0,
    },
    folder: out.folder,
    files: out.files,
    moskit: moskitResumo,
  };
  lists.unshift(entry);
  writeJson(LISTS_PATH, lists);

  job.result = entry;
  job.stage = 'concluído';
  job.status = job.cancel ? 'cancelado' : 'concluído';
  const totalNaPraca = ledgerLib.deliveredCount(ledger, key);
  const msg = entry.status === 'completa'
    ? `Lista #${n} completa: ${qualified.length}/${target} leads qualificados.`
    : `Lista #${n} ${entry.status}: ${qualified.length}/${target} — a praça pode ter se esgotado para hoje.`;
  log(`${msg} Total já entregue nessa praça: ${totalNaPraca}.`);
  return entry;
}

// ==========================================================================
// MODO PLANILHA
// Mesmo pipeline, outra origem: em vez de captura no Maps, os alvos (nome+CNPJ)
// vêm de uma planilha. Some a etapa de captura e a de descoberta de CNPJ;
// entra a descoberta de SITE. Limpeza, ledger, export e Moskit são os mesmos.
// ==========================================================================
async function runImportJob(job) {
  const { segment, city, uf, target, rows } = job;
  const log = makeLog(job);

  const ledger = ledgerLib.load();
  log(`Planilha: ${rows.length} empresa(s) com CNPJ válido para qualificar.`);

  // -------- limpeza (o que dá pra checar só com nome+CNPJ)
  const { kept, cut } = cleanImported(rows);
  if (cut.length) log(`Limpeza: ${cut.length} cortado(s) antes de consultar.`);

  // -------- anti-repetido: por CNPJ, em TODAS as praças
  const fresh = [];
  for (const r of kept) {
    const ja = ledgerLib.findDeliveredByCnpj(ledger, r.cnpjDigits);
    if (ja) {
      job.counts.jaEntregues = (job.counts.jaEntregues || 0) + 1;
      log(`↷ ${r.name} — já entregue antes (lista #${ja.info.list}, praça ${ja.key})`);
      continue;
    }
    fresh.push(r);
  }
  log(`A qualificar: ${fresh.length} (pulados por já entregues: ${job.counts.jaEntregues || 0}).`);

  const raw = rows.map(r => ({ name: r.name, phone: '', website: '', category: '', address: '', rating: '', reviews: '' }));
  const cleanedAll = [];
  const cutAll = [...cut];
  const discarded = [];
  const qualified = [];
  const cidadesVistas = {};   // pra rotular a lista quando a planilha mistura cidades
  let queue = fresh.slice();

  job.counts.capturados = rows.length;
  job.counts.limpos = fresh.length;

  const session = await launchSession();
  const page = session.page;
  log('Chrome aberto — se aparecer captcha na busca do site, resolva na janela que eu continuo.');

  try {
    job.stage = 'enriquecimento';
    while (queue.length && qualified.length < target && !job.cancel) {
      const cand = queue.shift();
      job.counts.processando = cand.displayName || cand.name;
      log(`Qualificando (${qualified.length + 1}/${Math.min(target, fresh.length)}): ${cand.displayName || cand.name}`);

      let res;
      try {
        res = await enrichFromCnpj(page, cand, log);
      } catch (e) {
        res = { ok: false, reason: 'erro: ' + String(e.message).split('\n')[0].slice(0, 100) };
      }

      if (res.ok) {
        const dupNaRodada = qualified.find(q => q.cnpj === res.lead.cnpj);
        if (dupNaRodada) {
          const reason = `duplicado: mesmo CNPJ de "${dupNaRodada.displayName}"`;
          discarded.push({ name: cand.displayName || cand.name, reason });
          job.counts.descartados = discarded.length;
          log(`✖ ${cand.displayName || cand.name} — ${reason}`);
        } else {
          qualified.push(res.lead);
          cleanedAll.push(res.lead);
          cidadesVistas[res.lead.city] = (cidadesVistas[res.lead.city] || 0) + 1;
          job.counts.qualificados = qualified.length;
          log(`✅ ${res.lead.displayName} — ${res.lead.city}/${res.lead.uf} | decisor: ${res.lead.decisor} | IG: ${res.lead.instagram} (${res.lead.igStatus})`);
        }
      } else if (res.blocked) {
        // Bloqueio de segurança nunca vira descarte (mesma política do modo Maps).
        if (!cand._deferred) {
          cand._deferred = true;
          queue.push(cand);
          log(`⏸ ${cand.displayName || cand.name} — ${res.reason}; volta pro fim da fila (NÃO descartado)`);
        } else {
          job.counts.adiados = (job.counts.adiados || 0) + 1;
          log(`⏸ ${cand.displayName || cand.name} — adiado para a PRÓXIMA rodada (não descartado)`);
        }
      } else {
        discarded.push({ name: cand.displayName || cand.name, reason: res.reason });
        // Descarte da planilha vai pro ledger da praça pela cidade que a Receita
        // devolveu; sem cidade (CNPJ inexistente), usa o rótulo do pedido.
        ledgerLib.markDiscarded(ledger, ledgerLib.keyFor(segment, city || 'planilha'), cand, res.reason);
        job.counts.descartados = discarded.length;
        log(`✖ ${cand.displayName || cand.name} — ${res.reason}`);
      }

      await jitter(1200, 2600);
      if ((qualified.length + discarded.length) % 20 === 0 && (qualified.length + discarded.length) > 0) {
        log('Pausa longa anti-bloqueio (25s)…');
        await jitter(22000, 30000);
      }
    }
  } finally {
    await session.close().catch(() => {});
  }

  if (job.cancel && qualified.length === 0) {
    job.stage = 'cancelado';
    job.status = 'cancelado';
    log('Cancelado — nada foi gravado.');
    return null;
  }

  // -------- rótulo da lista: cidade do pedido, ou a que mais apareceu na planilha
  const cidadeTop = Object.entries(cidadesVistas).sort((a, b) => b[1] - a[1])[0];
  const cidadeRotulo = city || (cidadeTop ? cidadeTop[0] : 'planilha');
  const varias = Object.keys(cidadesVistas).length > 1;

  job.stage = 'exportando';
  const meta = readJson(META_PATH, { lastListNumber: 0 });
  const n = meta.lastListNumber + 1;

  const out = exportList({
    baseDir: BASE, n, segment, city: cidadeRotulo, uf,
    raw, cleaned: cleanedAll, cut: cutAll, qualified, discarded,
  });

  // Cada lead entra na praça da SUA cidade — assim o modo Maps depois já sabe
  // que aquela empresa saiu, mesmo tendo vindo por outro caminho.
  for (const q of qualified) {
    ledgerLib.markDelivered(ledger, ledgerLib.keyFor(segment, q.city || cidadeRotulo), q, n);
  }
  ledgerLib.save(ledger);
  meta.lastListNumber = n;
  writeJson(META_PATH, meta);

  let moskitResumo = null;
  if (qualified.length) {
    job.stage = 'subindo pro Moskit';
    try {
      const moskit = require('./moskit');
      moskitResumo = await moskit.uploadList(qualified, {
        cidade: titleCase(cidadeRotulo), uf,
        // quem pediu a lista no painel → responsável pelos leads no Moskit
        responsibleId: job.moskitUserId, responsavel: job.usuario,
      }, log);
    } catch (e) {
      log(`Moskit: falha geral no upload — ${String(e.message).slice(0, 120)} (a lista local está salva; dá pra reenviar)`);
    }
  }

  const lists = readJson(LISTS_PATH, []);
  const entry = {
    id: `${n}-${slug(cidadeRotulo)}-${Date.now()}`,
    n,
    date: new Date().toISOString(),
    segment: titleCase(segment),
    city: varias ? `${titleCase(cidadeRotulo)} (+${Object.keys(cidadesVistas).length - 1})` : titleCase(cidadeRotulo),
    uf: uf || '',
    key: ledgerLib.keyFor(segment, cidadeRotulo),
    origem: 'planilha',
    usuario: job.usuario || null,
    target,
    delivered: qualified.length,
    status: job.cancel ? 'cancelada'
      : queue.length === 0 ? 'completa'
      : 'esgotada',
    totals: {
      capturados: rows.length,
      limpos: fresh.length,
      cortadosLimpeza: cutAll.length,
      descartadosEnriquecimento: discarded.length,
      puladosJaEntregues: job.counts.jaEntregues || 0,
      adiadosPorSeguranca: job.counts.adiados || 0,
    },
    folder: out.folder,
    files: out.files,
    moskit: moskitResumo,
  };
  lists.unshift(entry);
  writeJson(LISTS_PATH, lists);

  job.result = entry;
  job.stage = 'concluído';
  job.status = job.cancel ? 'cancelado' : 'concluído';
  log(`Lista #${n} (planilha): ${qualified.length} qualificados de ${rows.length} linhas — ` +
      `${cutAll.length} cortados, ${discarded.length} descartados, ${job.counts.jaEntregues || 0} já entregues antes.`);
  return entry;
}

module.exports = { runJob, runImportJob, LISTS_PATH, META_PATH };
