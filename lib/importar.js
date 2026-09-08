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
// Aceita .xlsx e .xls (Excel) e CSV/TSV, com ou sem cabeçalho.

const { norm, slug } = require('./util');
const { ehXlsx, ehXls, lerXlsx, lerXls } = require('./planilha-excel');

// Cabeçalhos que reconhecemos, em ordem de preferência. A comparação é
// normalizada (sem acento, minúsculo, espaços extras colapsados), então
// "  RAZÃO   SOCIAL " casa com "razao social".
const COL_NOME = [
  'nome', 'razao social', 'nome empresarial', 'nome da empresa',
  'nome fantasia', 'fantasia', 'empresa', 'cliente',
];
const COL_CNPJ = [
  'cnpj', 'cpf/cnpj', 'cnpj/cpf', 'cpf cnpj', 'cnpj da empresa',
  'documento', 'doc', 'inscricao', 'cnpj basico',
];

// Cabeçalhos que NÃO podem virar o nome da empresa (o "contains" pegaria).
const NOME_PROIBIDO = ['nome do contato', 'nome do socio', 'nome do sócio', 'nome fantasia do grupo'];

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

/**
 * Dígitos do CNPJ, recuperando o zero à esquerda que o Excel come quando a
 * coluna está formatada como número (01.234.567/0001-89 vira 1234567000189).
 */
function digitosCnpj(valor) {
  const d = soDigitos(valor);
  if (d.length === 14 || d.length === 0 || d.length > 14) return d;
  const completo = d.padStart(14, '0');
  return cnpjValido(completo) ? completo : d;
}

/** A célula parece um CNPJ? (usado quando a planilha vem sem cabeçalho) */
function pareceCnpj(v) {
  return cnpjValido(digitosCnpj(v));
}

/** Acha a coluna cujo cabeçalho casa com a lista (exato primeiro, depois "contém"). */
function acharColuna(cabecalho, lista, proibidos = []) {
  const cab = cabecalho.map(norm);
  const proibido = i => proibidos.includes(cab[i]);
  for (const alvo of lista) {
    const i = cab.indexOf(alvo);
    if (i >= 0 && !proibido(i)) return i;
  }
  for (const alvo of lista) {
    const i = cab.findIndex((c, idx) => c.includes(alvo) && !proibido(idx));
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * Descobre quais colunas são nome e CNPJ.
 * 1º procura um cabeçalho nas primeiras linhas (exportação costuma ter título
 * antes); se não achar, olha o conteúdo. Retorna { iNome, iCnpj, linhaCabecalho }.
 * linhaCabecalho = -1 quando a planilha não tem cabeçalho.
 */
function mapearColunas(linhas) {
  const ate = Math.min(linhas.length, 10);
  for (let r = 0; r < ate; r++) {
    const linha = linhas[r] || [];
    if (linha.length < 2) continue;
    const iNome = acharColuna(linha, COL_NOME, NOME_PROIBIDO);
    const iCnpj = acharColuna(linha, COL_CNPJ);
    if (iNome >= 0 && iCnpj >= 0 && iNome !== iCnpj) {
      return { iNome, iCnpj, linhaCabecalho: r };
    }
  }

  // Sem cabeçalho reconhecível: acha a coluna que contém CNPJ válido e assume
  // que o nome é a primeira coluna de texto que sobrou.
  const amostra = linhas.slice(0, 8);
  const nCols = Math.max(0, ...amostra.map(l => (l || []).length));
  let iCnpj = -1, iNome = -1;
  for (let c = 0; c < nCols; c++) {
    if (amostra.some(l => pareceCnpj((l || [])[c]))) { iCnpj = c; break; }
  }
  if (iCnpj < 0) return { iNome: -1, iCnpj: -1, linhaCabecalho: -1 };
  for (let c = 0; c < nCols; c++) {
    if (c === iCnpj) continue;
    if (amostra.some(l => String((l || [])[c] || '').replace(/[\d\s.\-/]/g, '').length >= 3)) { iNome = c; break; }
  }
  return { iNome, iCnpj, linhaCabecalho: -1 };
}

const ERRO_COLUNAS =
  'Não achei as colunas de nome e CNPJ. A planilha precisa de um cabeçalho com ' +
  '"Nome" (ou "Razão Social", "Nome Empresarial", "Nome Fantasia") e "CNPJ" ' +
  '(ou "CPF/CNPJ") — maiúsculas, acentos e espaços a mais não atrapalham.';

/**
 * Núcleo: recebe a matriz de células e devolve os alvos prontos pro pipeline.
 *
 * Retorna { rows, descartes, info }:
 *   rows      — [{ name, cnpj, cnpjDigits }] no formato que o runner espera
 *   descartes — [{ name, reason }] linhas que não dá pra usar (CNPJ inválido, duplicado)
 *   info      — { totalLinhas, colunaNome, colunaCnpj, ... }
 */
function montarResultado(linhas, extra = {}) {
  if (!linhas || !linhas.length) {
    return { rows: [], descartes: [], info: { erro: 'Não consegui ler nenhuma linha.' } };
  }

  const { iNome, iCnpj, linhaCabecalho } = mapearColunas(linhas);
  if (iNome < 0 || iCnpj < 0) {
    return { rows: [], descartes: [], info: { erro: ERRO_COLUNAS } };
  }

  const dados = linhaCabecalho >= 0 ? linhas.slice(linhaCabecalho + 1) : linhas;
  const rows = [];
  const descartes = [];
  const vistos = new Map(); // cnpjDigits -> nome já aceito

  for (const linha of dados) {
    const name = String((linha || [])[iNome] || '').trim();
    const cnpjRaw = String((linha || [])[iCnpj] || '').trim();
    const digits = digitosCnpj(cnpjRaw);

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

  const cab = linhaCabecalho >= 0 ? linhas[linhaCabecalho] : null;
  return {
    rows,
    descartes,
    info: {
      totalLinhas: dados.length,
      colunaNome: cab ? cab[iNome] : `coluna ${iNome + 1}`,
      colunaCnpj: cab ? cab[iCnpj] : `coluna ${iCnpj + 1}`,
      temCabecalho: linhaCabecalho >= 0,
      ...extra,
    },
  };
}

/** Lê planilha em TEXTO (CSV/TSV). Mantido para quem já chamava assim. */
function lerPlanilha(texto) {
  const bruto = String(texto || '').replace(/^﻿/, '');
  if (!bruto.trim()) {
    return { rows: [], descartes: [], info: { erro: 'Arquivo vazio.' } };
  }
  const primeira = bruto.replace(/\r\n?/g, '\n').split('\n').find(l => l.trim()) || '';
  const delim = detectDelimiter(primeira);
  return montarResultado(parseDelimited(bruto, delim), {
    formato: 'csv',
    separador: delim === '\t' ? 'tab' : delim,
  });
}

/**
 * Texto a partir dos bytes: tenta UTF-8 e cai pra Latin-1 quando o arquivo veio
 * do Excel do Windows (senão "Razão Social" chega como "RazÃ£o" e não casa).
 */
function texto(buf) {
  const utf8 = buf.toString('utf8');
  return utf8.includes('�') ? buf.toString('latin1') : utf8;
}

/**
 * Lê o ARQUIVO enviado (bytes) — .xlsx, .xls ou CSV/TSV, detectado pelo
 * conteúdo (a extensão do nome só entra no recado de erro).
 */
function lerArquivo(buf, nomeArquivo = '') {
  if (!buf || !buf.length) {
    return { rows: [], descartes: [], info: { erro: 'Arquivo vazio.' } };
  }

  const excel = ehXlsx(buf) ? 'xlsx' : ehXls(buf) ? 'xls' : null;
  if (!excel) {
    // Não é Excel: só vale se for texto (CSV/TSV). Arquivo binário qualquer
    // (PDF, imagem, .numbers…) precisa de recado claro, não de 'faltam colunas'.
    const amostra = buf.subarray(0, 4000);
    let estranhos = 0;
    for (const b of amostra) if (b === 0 || b === 27 || (b > 0 && b < 9) || (b > 13 && b < 32)) estranhos++;
    if (estranhos > amostra.length * 0.05) {
      const ext = (String(nomeArquivo).match(/\.[a-z0-9]+$/i) || [''])[0].toLowerCase();
      const qual = ext ? ' (' + ext + ')' : '';
      return {
        rows: [], descartes: [],
        info: {
          erro: 'Esse arquivo' + qual + ' não é uma planilha que eu saiba ler. ' +
                'Envie .xlsx, .xls ou CSV — no Excel: Arquivo → Salvar como.',
        },
      };
    }
    return lerPlanilha(texto(buf));
  }

  let abas;
  try {
    abas = excel === 'xlsx' ? lerXlsx(buf) : lerXls(buf);
  } catch (e) {
    return {
      rows: [], descartes: [],
      info: { erro: `Não consegui abrir o arquivo do Excel (${e.message}). Tente salvar como CSV e subir de novo.` },
    };
  }
  const comLinhas = (abas || []).filter(a => a.linhas && a.linhas.length);
  if (!comLinhas.length) {
    return { rows: [], descartes: [], info: { erro: 'A planilha do Excel está vazia.' } };
  }

  // Uma pasta pode ter várias abas (instruções, resumo…): vale a primeira em
  // que as colunas de nome e CNPJ aparecem.
  let primeiroErro = null;
  for (const aba of comLinhas) {
    const r = montarResultado(aba.linhas, { formato: excel, aba: aba.nome });
    if (!r.info.erro) return r;
    primeiroErro = primeiroErro || r;
  }
  return primeiroErro;
}

module.exports = { lerPlanilha, lerArquivo, cnpjValido, soDigitos, digitosCnpj, slug };
