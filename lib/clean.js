'use strict';
// Passo 2 — Limpeza. Regras do processo BeamBrocker+Babuya:
//  - corta quem tem MENOS de 10 avaliações
//  - corta corretor solo (categoria "Corretor…")
//  - corta quem NÃO tem telefone
//  - corta quem NÃO tem site  (regra da Ferramenta: só lead com site — dá pra cruzar os dados)
//  - corta telefone duplicado
//  - franquias/redes são MANTIDAS, marcadas com "F - " no nome

const { norm } = require('./util');

const FRANQUIAS = [
  'auxiliadora predial', 'remax', 're/max', 'credito real', 'foxter',
  'century 21', 'keller williams', 'coldwell banker', 'sotheby',
];

function isFranquia(name) {
  const n = norm(name);
  return FRANQUIAS.some(f => n.includes(norm(f)));
}

function cleanRows(rows) {
  const kept = [];
  const cut = [];
  const seenPhones = new Set();

  for (const r of rows) {
    const name = String(r.name || '').trim();
    const reviews = r.reviews || 0;
    const phone = String(r.phone || '').trim();
    const site = String(r.website || '').trim();
    const phoneKey = phone.replace(/\D/g, '');

    // Nº de avaliações: o Maps às vezes não mostra na LISTA (layout experimental).
    // Se conhecido e <10, corta já; se desconhecido (0), o enriquecimento confere
    // na página do lugar antes de gastar tempo com o lead.
    if (reviews > 0 && reviews < 10) { cut.push({ name, reason: `<10 avaliações (${reviews})` }); continue; }
    if (!phone) { cut.push({ name, reason: 'sem telefone' }); continue; }
    if (!site) { cut.push({ name, reason: 'sem site (regra: só lead com site p/ cruzar dados)' }); continue; }
    if (seenPhones.has(phoneKey)) { cut.push({ name, reason: `telefone duplicado (${phone})` }); continue; }
    if (norm(r.category || '').includes('corretor')) { cut.push({ name, reason: 'corretor solo (categoria)' }); continue; }

    seenPhones.add(phoneKey);
    kept.push({
      ...r,
      displayName: isFranquia(name) ? 'F - ' + name : name,
    });
  }

  return { kept, cut };
}

module.exports = { cleanRows, isFranquia };
