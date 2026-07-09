'use strict';
// Mecanismo ANTI-REPETIDO ("ledger").
// Guarda, por praça (segmento+cidade), tudo que já foi ENTREGUE em listas
// anteriores e tudo que já foi DESCARTADO (com motivo). Na próxima geração
// da mesma praça, esses registros são pulados — só vêm leads novos.

const path = require('path');
const { readJson, writeJson, slug, segmentKey } = require('./util');

const LEDGER_PATH = path.join(__dirname, '..', 'data', 'ledger.json');

function load() {
  return readJson(LEDGER_PATH, { version: 1, entries: {} });
}

function save(ledger) {
  writeJson(LEDGER_PATH, ledger);
}

/** Chave da praça: "imobiliarias__sao-jose-do-rio-preto" */
function keyFor(segment, city) {
  return `${segmentKey(segment)}__${slug(city)}`;
}

function entry(ledger, key) {
  if (!ledger.entries[key]) ledger.entries[key] = { delivered: {}, discarded: {} };
  return ledger.entries[key];
}

/** Identificador de um lead: CNPJ (se houver) senão slug do nome. */
function idFor(lead) {
  const cnpjDigits = String(lead.cnpj || '').replace(/\D/g, '');
  return cnpjDigits.length === 14 ? 'cnpj:' + cnpjDigits : 'nome:' + slug(lead.name || lead.displayName);
}

/**
 * Descartes "recuperáveis": podem ter sido vítimas de bloqueio anti-robô ou
 * instabilidade (não do lead em si) — ganham uma 2ª chance (repescagem).
 */
function isRetryable(reason) {
  return /site inacess|CNPJ não encontrado|API de CNPJ|inacess[íi]vel|^erro:/i.test(String(reason || ''));
}

/** Filtra candidatos: remove já entregues e descartados definitivos.
 *  Descartados recuperáveis voltam UMA vez (tries < 2) — repescagem. */
function filterNew(ledger, key, candidates) {
  const e = entry(ledger, key);
  const fresh = [], skipped = [];
  for (const c of candidates) {
    const nameId = 'nome:' + slug(c.name);
    if (e.delivered[nameId]) { skipped.push(c); continue; }
    const disc = e.discarded[nameId];
    if (disc) {
      const tries = disc.tries || 1;
      if (!isRetryable(disc.reason) || tries >= 2) { skipped.push(c); continue; }
      c._repescagem = true; // recuperável, 1ª repescagem
    }
    // também confere por CNPJ caso já conhecido
    const known = Object.keys(e.delivered).some(k => e.delivered[k].name === c.name);
    if (known) { skipped.push(c); continue; }
    fresh.push(c);
  }
  return { fresh, skipped };
}

function markDelivered(ledger, key, lead, listNumber) {
  const e = entry(ledger, key);
  const id = idFor(lead);
  e.delivered[id] = {
    name: lead.name,
    cnpj: lead.cnpj || '',
    phone: lead.phone || '',
    list: listNumber,
    date: new Date().toISOString().slice(0, 10),
  };
  // índice extra por nome (o Maps devolve nome, não CNPJ)
  const nameId = 'nome:' + slug(lead.name);
  if (id !== nameId) e.delivered[nameId] = { ref: id, name: lead.name, list: listNumber };
}

function markDiscarded(ledger, key, cand, reason) {
  const e = entry(ledger, key);
  const nameId = 'nome:' + slug(cand.name);
  const prev = e.discarded[nameId];
  e.discarded[nameId] = {
    name: cand.name,
    reason,
    date: new Date().toISOString().slice(0, 10),
    tries: (prev?.tries || (prev ? 1 : 0)) + 1,
  };
}

/** Quantos já foram entregues nessa praça (leads únicos, sem os índices "ref"). */
function deliveredCount(ledger, key) {
  const e = ledger.entries[key];
  if (!e) return 0;
  return Object.values(e.delivered).filter(v => !v.ref).length;
}

module.exports = {
  load, save, keyFor, filterNew, markDelivered, markDiscarded, deliveredCount, LEDGER_PATH,
};
