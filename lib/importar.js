'use strict';
// Passo 1 (ALTERNATIVO) — Importação de planilha.
//
// Em vez de capturar no Google Maps, a lista de alvos vem de uma planilha do
// banco de dados do usuário. A planilha traz o MÍNIMO: nome da empresa e CNPJ.
// Todo o resto (cidade, telefone, sócio-administrador, site, Instagram) é
// descoberto pelo enriquecimento — igual ao fluxo do Maps.
//
// Ter o CNPJ de mão muda o jogo: a etapa que mais derrubava lead no fluxo do
// Maps era justamente DESCOBRIR o CNPJ ("CNPJ não encontrado/validado"). Aqui
// ela deixa de existir.
//
// Aceita CSV/TSV (é o que toda planilha exporta) com ou sem cabeçalho.

const { norm, slug } = require('./util');

// Cabeçalhos que reconhecemos, em ordem de preferência. Comparação normalizada
// (sem acento, minúsculo), então "Razão Social" casa com "razao social".
const COL_NOME = ['nome da empresa', 'razao social', 'nome fantasia', 'empresa', 'nome', 'fantasia', 'cliente'];
const COL_CNPJ = ['cnpj', 'cnpj/cpf', 'documento', 'doc', 'cnpj da empresa'];

/** Detecta o separador olhando a 1ª linha: vence quem aparece mais. */
function detectDelimiter(firstLine) {
  const cand = [',', ';', '\t'];
  let best = ',', bestN = 0;
  for (const d of cand) {
    const n = firstLine.split(d).length - 1;
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

/** Parser de CSV que respeita aspas e aspas escapadas (""). */
function parseDelimited(txt, delim) {
  const linhas = String(txt).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const linha of linhas) {
    if (!linha.trim()) continue;
    const campos = [];
    let cur = '', aspas = false;
    for (let i = 0; i < linha.length; i++) {
      const c = linha[i];
      if (aspas) {
        if (c === '"') { if (linha[i + 1] === '"') { cur += '"'; i++; } else aspas = false; }
        else cur += c;
      } else if (c === '"') aspas = true;
      else if (c === delim) { campos.push(cur); cur = ''; }
      else cur += c;
    }
    campos.push(cur);
    out.push(campos.map(s => s.trim()));
  }
  return out;
}

/** Valida CNPJ pelos dígitos verificadores (pega erro de digitação/coluna trocada). */
function cnpjValido(digits) {
  if (!/^\d{14}$/.test(digits)) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false; // 00000000000000 e afins
  const calc = (base, pesos) => {
    const soma = base.split('').reduce((s, d, i) => s + Number(d) * pesos[i], 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const d1 = calc(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = calc(digits.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === Number(digits[12]) && d2 === Number(digits[13]);
}

const soDigitos = s => String(s || '').replace(/\D/g, '');

/** A célula parece um CNPJ? (usado quando a planilha vem sem cabeçalho) */
function pareceCnpj(v) {
  return cnpjValido(soDigitos(v));
}

/**
 * Descobre quais colunas são nome e CNPJ.
 * 1º tenta pelo cabeçalho; se não achar, olha o conteúdo da 1ª linha de dados.
 * Retorna { iNome, iCnpj, temCabecalho }.
 */
function mapearColunas(linhas) {
  const cab = linhas[0].map(norm);

  const acha = (lista) => {
    // casamento exato primeiro (evita "nome do contato" virar "nome da empresa")
    for (const alvo of lista) {
      const i = cab.indexOf(alvo);
      if (i >= 0) return i;
    }
    for (const alvo of lista) {
      const i = cab.findIndex(c => c.includes(alvo));
      if (i >= 0) return i;
    }
    return -1;
  };

  let iNome = acha(COL_NOME);
  let iCnpj = acha(COL_CNPJ);
  if (iNome >= 0 && iCnpj >= 0 && iNome !== iCnpj) {
    return { iNome, iCnpj, temCabecalho: true };
  }

  // Sem cabeçalho reconhecível: acha a coluna que contém CNPJ válido e assume
  // que o nome é a primeira coluna de texto que sobrou.
  const amostra = linhas.slice(0, 5);
  const nCols = Math.max(...amostra.map(l => l.length));
  for (let c = 0; c < nCols; c++) {
    if (amostra.some(l => pareceCnpj(l[c]))) { iCnpj = c; break; }
  }
  if (iCnpj < 0) return { iNome: -1, iCnpj: -1, temCabecalho: false };
  for (let c = 0; c < nCols; c++) {
    if (c === iCnpj) continue;
    if (amostra.some(l => String(l[c] || '').replace(/[\d\s.\-/]/g, '').length >= 3)) { iNome = c; break; }
  }
  return { iNome, iCnpj, temCabecalho: false };
}

/**
 * Lê a planilha e devolve os alvos prontos pro pipeline.
 *
 * Retorna { rows, descartes, info }:
 *   rows      — [{ name, cnpj, cnpjDigits }] no formato que o runner espera
 *   descartes — [{ name, reason }] linhas que não dá pra usar (CNPJ inválido, duplicado)
 *   info      — { totalLinhas, colunaNome, colunaCnpj, temCabecalho }
 */
function lerPlanilha(texto) {
  const bruto = String(texto || '').replace(/^﻿/, '');
  if (!bruto.trim()) {
    return { rows: [], descartes: [], info: { erro: 'Arquivo vazio.' } };
  }

  const primeira = bruto.replace(/\r\n?/g, '\n').split('\n').find(l => l.trim()) || '';
  const delim = detectDelimiter(primeira);
  const linhas = parseDelimited(bruto, delim);
  if (!linhas.length) {
    return { rows: [], descartes: [], info: { erro: 'Não consegui ler nenhuma linha.' } };
  }

  const { iNome, iCnpj, temCabecalho } = mapearColunas(linhas);
  if (iNome < 0 || iCnpj < 0) {
    return {
      rows: [], descartes: [],
      info: {
        erro: 'Não achei as colunas de nome e CNPJ. Deixe um cabeçalho com "Nome" (ou "Razão Social") ' +
              'e "CNPJ" — ou garanta que a coluna de CNPJ tenha CNPJs válidos.',
      },
    };
  }

  const dados = temCabecalho ? linhas.slice(1) : linhas;
  const rows = [];
  const descartes = [];
  const vistos = new Map(); // cnpjDigits -> nome já aceito

  for (const linha of dados) {
    const name = String(linha[iNome] || '').trim();
    const cnpjRaw = String(linha[iCnpj] || '').trim();
    const digits = soDigitos(cnpjRaw);

    if (!name && !digits) continue; // linha em branco no meio da planilha

    if (!cnpjValido(digits)) {
      descartes.push({
        name: name || '(sem nome)',
        reason: digits ? `CNPJ inválido (${cnpjRaw})` : 'sem CNPJ na planilha',
      });
      continue;
    }
    if (vistos.has(digits)) {
      descartes.push({ name: name || digits, reason: `CNPJ repetido na planilha (já veio como "${vistos.get(digits)}")` });
      continue;
    }
    vistos.set(digits, name || digits);

    rows.push({
      name: name || `CNPJ ${digits}`,
      cnpj: digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5'),
      cnpjDigits: digits,
      origem: 'planilha',
    });
  }

  return {
    rows,
    descartes,
    info: {
      totalLinhas: dados.length,
      colunaNome: temCabecalho ? linhas[0][iNome] : `coluna ${iNome + 1}`,
      colunaCnpj: temCabecalho ? linhas[0][iCnpj] : `coluna ${iCnpj + 1}`,
      temCabecalho,
      separador: delim === '\t' ? 'tab' : delim,
    },
  };
}

module.exports = { lerPlanilha, cnpjValido, soDigitos, slug };
