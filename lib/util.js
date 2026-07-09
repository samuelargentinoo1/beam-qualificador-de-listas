'use strict';
// Utilidades compartilhadas do pipeline.

const fs = require('fs');
const path = require('path');

/** Remove acentos, minúsculas, espaços colapsados. */
function norm(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Slug para nomes de arquivo/chaves: "São José do Rio Preto" -> "sao-jose-do-rio-preto" */
function slug(s) {
  return norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .split(' ')
    .map(w => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .replace(/^./, c => c.toUpperCase());
}

/** Normaliza o segmento para a chave do ledger (aliases comuns). */
function segmentKey(segment) {
  const s = slug(segment);
  if (s.startsWith('imob')) return 'imobiliarias';
  return s;
}

/** Nome "limpo" da empresa para buscas (sem "F - ", sem slogans depois de "|"). */
function cleanCompanyName(name) {
  let n = String(name || '').replace(/^F - /, '');
  n = n.split('|')[0];
  n = n.split(' — ')[0];
  return n.replace(/["“”]/g, '').replace(/\s+/g, ' ').trim();
}

const STOPWORDS = new Set([
  'imobiliaria', 'imobiliarias', 'imoveis', 'imovel', 'imob', 'negocios', 'negocio',
  'assessoria', 'consultoria', 'corretora', 'corretor', 'gestao', 'administradora',
  'ltda', 'me', 'eireli', 'sa', 's/a', 'epp', 'cia', 'grupo', 'rede',
  'de', 'da', 'do', 'dos', 'das', 'em', 'e', 'a', 'o', 'na', 'no', 'para', 'com',
  'porto', 'alegre', 'sao', 'jose', 'rio', 'preto', 'zona', 'norte', 'sul', 'leste', 'oeste', 'centro',
  'venda', 'vendas', 'locacao', 'aluguel', 'compra', 'alto', 'padrao', 'lider', 'anos',
]);

/** Tokens "distintivos" do nome (para conferir se o CNPJ achado é mesmo da empresa). */
function distinctiveTokens(name, city) {
  const cityToks = new Set(norm(city).split(' '));
  return norm(cleanCompanyName(name))
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(' ')
    .filter(t => t.length >= 3 && !STOPWORDS.has(t) && !cityToks.has(t));
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** Escreve CSV com BOM (Excel-friendly). rows = array de arrays. */
function writeCsv(filePath, rows) {
  const body = rows.map(r => r.map(csvEscape).join(',')).join('\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '﻿' + body + '\n', 'utf8');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Pausa "humana" com jitter. */
const jitter = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));

/** Extrai handles do instagram de uma lista de URLs. */
function instagramHandles(urls) {
  const skip = new Set(['p', 'reel', 'reels', 'explore', 'accounts', 'stories', 'share', 'tv', 'direct']);
  const out = [];
  for (const u of urls || []) {
    const m = String(u).match(/instagram\.com\/([A-Za-z0-9_.]+)/);
    if (m && !skip.has(m[1].toLowerCase()) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

module.exports = {
  norm, slug, titleCase, segmentKey, cleanCompanyName, distinctiveTokens,
  csvEscape, writeCsv, readJson, writeJson, sleep, jitter, instagramHandles,
};
