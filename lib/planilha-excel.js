'use strict';
// ============================================================
// LEITURA DE PLANILHAS DO EXCEL — .xlsx (moderno) e .xls (antigo).
//
// Sem biblioteca externa, de propósito: são só dois formatos bem documentados e
// a ferramenta roda em servidor nosso, então evitamos pendurar uma dependência
// (e as falhas de segurança dela) num caminho que recebe arquivo de fora.
//
//   .xlsx → é um ZIP com XML dentro (planilha + textos compartilhados)
//   .xls  → arquivo binário OLE2 com registros BIFF8
//
// As duas funções devolvem o MESMO formato, pronto pro importador:
//   [{ nome: 'Planilha1', linhas: [['CNPJ','Nome'], ['11.222...','Solar']] }]
// Toda célula vira texto. Número inteiro não vira notação científica (senão um
// CNPJ guardado como número viraria "1.1222333e+13").
// ============================================================

const zlib = require('zlib');

// ---------------------------------------------------------------- utilidades
/** Número → texto, sem notação científica e sem ".0" no fim. */
function numeroParaTexto(v) {
  if (!isFinite(v)) return '';
  if (Number.isInteger(v) && Math.abs(v) < 1e21) return v.toFixed(0);
  return String(v);
}

function entidadesXml(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** "BC" → 55 (índice da coluna, base 0). */
function colunaDaRef(ref) {
  const m = /^([A-Z]+)/.exec(String(ref || '').toUpperCase());
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const ehXlsx = buf => buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 3 || buf[2] === 5 || buf[2] === 7);
const ehXls = buf => buf.length > 8 && buf.readUInt32LE(0) === 0xe011cfd0 && buf.readUInt32LE(4) === 0xe11ab1a1;

// ==========================================================================
// .xlsx — ZIP + XML
// ==========================================================================

/** Lê o diretório central do ZIP e devolve Map(nome do arquivo → conteúdo). */
function abrirZip(buf) {
  // O fim do diretório central (EOCD) fica no fim do arquivo, depois de um
  // comentário de tamanho variável — por isso a procura de trás pra frente.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('arquivo .xlsx corrompido (não achei o índice do zip)');

  let n = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);

  // ZIP64: quando os campos de 32 bits estouram, os valores reais ficam em
  // outro registro. Planilha grande de verdade cai aqui.
  if (pos === 0xffffffff || n === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x07064b50) {           // localizador do EOCD64
        const off64 = Number(buf.readBigUInt64LE(i + 8));
        if (buf.readUInt32LE(off64) === 0x06064b50) {      // EOCD64
          n = Number(buf.readBigUInt64LE(off64 + 32));
          pos = Number(buf.readBigUInt64LE(off64 + 48));
        }
        break;
      }
    }
  }

  const arquivos = new Map();
  for (let i = 0; i < n && pos + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(pos + 10);
    let tamComprimido = buf.readUInt32LE(pos + 20);
    const nomeLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const comentLen = buf.readUInt16LE(pos + 32);
    let inicio = buf.readUInt32LE(pos + 42);
    const nome = buf.toString('utf8', pos + 46, pos + 46 + nomeLen);

    // ZIP64: valores reais no campo "extra" (cabeçalho 0x0001)
    if (tamComprimido === 0xffffffff || inicio === 0xffffffff) {
      let e = pos + 46 + nomeLen;
      const fim = e + extraLen;
      while (e + 4 <= fim) {
        const id = buf.readUInt16LE(e), tam = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (buf.readUInt32LE(pos + 24) === 0xffffffff) q += 8;         // tamanho original
          if (tamComprimido === 0xffffffff) { tamComprimido = Number(buf.readBigUInt64LE(q)); q += 8; }
          if (inicio === 0xffffffff) inicio = Number(buf.readBigUInt64LE(q));
          break;
        }
        e += 4 + tam;
      }
    }

    // cabeçalho local: o conteúdo começa depois do nome e do extra DELE
    if (buf.readUInt32LE(inicio) === 0x04034b50) {
      const nomeLenL = buf.readUInt16LE(inicio + 26);
      const extraLenL = buf.readUInt16LE(inicio + 28);
      const dados = buf.subarray(inicio + 30 + nomeLenL + extraLenL,
                                 inicio + 30 + nomeLenL + extraLenL + tamComprimido);
      try {
        arquivos.set(nome, metodo === 0 ? dados : zlib.inflateRawSync(dados));
      } catch { /* entrada ilegível: ignora, pode não ser a que precisamos */ }
    }
    pos += 46 + nomeLen + extraLen + comentLen;
  }
  return arquivos;
}

/** Textos compartilhados (o xlsx guarda cada texto uma vez só). */
function lerTextosCompartilhados(xml) {
  if (!xml) return [];
  const out = [];
  // cada <si> é um texto; pode vir picado em vários <t> (formatação no meio)
  const re = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g;
  let m;
  while ((m = re.exec(xml))) {
    const dentro = m[1] || '';
    let txt = '';
    const reT = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
    let t;
    while ((t = reT.exec(dentro))) txt += entidadesXml(t[1] || '');
    out.push(txt);
  }
  return out;
}

/** Uma aba do xlsx → matriz de textos. */
function lerAbaXlsx(xml, textos) {
  const linhas = [];
  const reLinha = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let mLinha;
  while ((mLinha = reLinha.exec(xml))) {
    const attrs = mLinha[1] || mLinha[3] || '';
    const conteudo = mLinha[2] || '';
    const rAttr = /\br="(\d+)"/.exec(attrs);
    const nLinha = rAttr ? parseInt(rAttr[1], 10) - 1 : linhas.length;

    const celulas = [];
    const reCel = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let mCel;
    while ((mCel = reCel.exec(conteudo))) {
      const at = mCel[1] || mCel[3] || '';
      const dentro = mCel[2] || '';
      const ref = /\br="([A-Z]+\d+)"/i.exec(at);
      const tipo = (/\bt="([^"]+)"/.exec(at) || [, 'n'])[1];
      let idx = ref ? colunaDaRef(ref[1]) : celulas.length;
      if (idx < 0) idx = celulas.length;

      let valor = '';
      if (tipo === 'inlineStr') {
        const reT = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let t; while ((t = reT.exec(dentro))) valor += entidadesXml(t[1] || '');
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(dentro);
        const cru = v ? entidadesXml(v[1]) : '';
        if (tipo === 's') valor = textos[parseInt(cru, 10)] ?? '';
        else if (tipo === 'b') valor = cru === '1' ? 'VERDADEIRO' : 'FALSO';
        else if (tipo === 'e') valor = '';
        else if (cru !== '' && !isNaN(Number(cru))) valor = numeroParaTexto(Number(cru));
        else valor = cru;
      }
      while (celulas.length < idx) celulas.push('');
      celulas[idx] = String(valor).trim();
    }
    while (linhas.length < nLinha) linhas.push([]);
    linhas[nLinha] = celulas;
  }
  return linhas;
}

/** .xlsx → [{ nome, linhas }] (todas as abas, na ordem do arquivo). */
function lerXlsx(buf) {
  const zip = abrirZip(buf);
  const txt = nome => { const b = zip.get(nome); return b ? b.toString('utf8') : ''; };

  const textos = lerTextosCompartilhados(txt('xl/sharedStrings.xml'));

  // ordem e nomes das abas ficam no workbook.xml; o arquivo de cada uma, no .rels
  const rels = new Map();
  const relsXml = txt('xl/_rels/workbook.xml.rels');
  for (const m of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const id = /Id="([^"]+)"/.exec(m[0]);
    const alvo = /Target="([^"]+)"/.exec(m[0]);
    if (id && alvo) rels.set(id[1], alvo[1].replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const abas = [];
  const wbXml = txt('xl/workbook.xml');
  for (const m of wbXml.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const nome = /name="([^"]+)"/.exec(m[0]);
    const rid = /r:id="([^"]+)"/.exec(m[0]);
    const alvo = rid ? rels.get(rid[1]) : null;
    const chave = alvo ? (zip.has('xl/' + alvo) ? 'xl/' + alvo : alvo) : null;
    if (chave && zip.has(chave)) {
      abas.push({ nome: nome ? entidadesXml(nome[1]) : chave, linhas: lerAbaXlsx(txt(chave), textos) });
    }
  }
  // sem workbook.xml legível: pega as planilhas na marra
  if (!abas.length) {
    for (const chave of [...zip.keys()].filter(k => /^xl\/worksheets\/sheet\d*\.xml$/.test(k)).sort()) {
      abas.push({ nome: chave, linhas: lerAbaXlsx(txt(chave), textos) });
    }
  }
  return abas;
}

// ==========================================================================
// .xls — OLE2 (CFB) + registros BIFF8
// ==========================================================================

/** Abre o container OLE2 e devolve o stream pedido (ex.: "Workbook"). */
function streamDoOle(buf, nomesAceitos) {
  const tamSetor = 1 << buf.readUInt16LE(0x1e);
  const tamMini = 1 << buf.readUInt16LE(0x20);
  const nFat = buf.readUInt32LE(0x2c);
  const dirInicio = buf.readUInt32LE(0x30);
  const miniInicio = buf.readUInt32LE(0x3c);
  const difatInicio = buf.readUInt32LE(0x44);
  const nDifat = buf.readUInt32LE(0x48);

  const setor = i => buf.subarray(512 + i * tamSetor, 512 + (i + 1) * tamSetor);

  // DIFAT → lista dos setores que formam a FAT
  const setoresFat = [];
  for (let i = 0; i < 109 && setoresFat.length < nFat; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4);
    if (s < 0xfffffffc) setoresFat.push(s);
  }
  let prox = difatInicio;
  for (let k = 0; k < nDifat && prox < 0xfffffffc; k++) {
    const s = setor(prox);
    const porSetor = tamSetor / 4 - 1;
    for (let i = 0; i < porSetor && setoresFat.length < nFat; i++) {
      const v = s.readUInt32LE(i * 4);
      if (v < 0xfffffffc) setoresFat.push(v);
    }
    prox = s.readUInt32LE(tamSetor - 4);
  }

  // FAT: cadeia de setores
  const fat = [];
  for (const s of setoresFat) {
    const d = setor(s);
    for (let i = 0; i < tamSetor / 4; i++) fat.push(d.readUInt32LE(i * 4));
  }
  const cadeia = (inicio, fatTab) => {
    const out = [];
    let i = inicio, guarda = 0;
    while (i < 0xfffffffc && guarda++ < 1e6) { out.push(i); i = fatTab[i]; }
    return out;
  };
  const juntar = ids => Buffer.concat(ids.map(setor));

  // diretório: entradas de 128 bytes
  const dir = juntar(cadeia(dirInicio, fat));
  const entradas = [];
  for (let p = 0; p + 128 <= dir.length; p += 128) {
    const tamNome = dir.readUInt16LE(p + 0x40);
    if (!tamNome) continue;
    const nome = dir.toString('utf16le', p, p + Math.max(0, tamNome - 2));
    entradas.push({ nome, tipo: dir[p + 0x42], setor: dir.readUInt32LE(p + 0x74), tam: dir.readUInt32LE(p + 0x78) });
  }

  const raiz = entradas.find(e => e.tipo === 5);
  const alvo = entradas.find(e => nomesAceitos.includes(e.nome));
  if (!alvo) throw new Error('arquivo .xls sem planilha reconhecível');

  // arquivo pequeno mora no "mini stream", dentro do stream da raiz
  if (alvo.tam < 4096 && raiz) {
    const miniFatBuf = juntar(cadeia(miniInicio, fat));
    const miniFat = [];
    for (let i = 0; i < miniFatBuf.length / 4; i++) miniFat.push(miniFatBuf.readUInt32LE(i * 4));
    const miniStream = juntar(cadeia(raiz.setor, fat));
    const pedacos = cadeia(alvo.setor, miniFat)
      .map(i => miniStream.subarray(i * tamMini, (i + 1) * tamMini));
    return Buffer.concat(pedacos).subarray(0, alvo.tam);
  }
  return juntar(cadeia(alvo.setor, fat)).subarray(0, alvo.tam);
}

/** Lê os registros BIFF: [{ id, dados }]. */
function registrosBiff(buf) {
  const out = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const id = buf.readUInt16LE(p);
    const tam = buf.readUInt16LE(p + 2);
    if (p + 4 + tam > buf.length) break;
    out.push({ id, dados: buf.subarray(p + 4, p + 4 + tam) });
    p += 4 + tam;
  }
  return out;
}

/** Tabela de textos (SST) — pode continuar em vários registros CONTINUE. */
function lerSst(pedacos) {
  const textos = [];
  let iBuf = 0, pos = 8; // pula cstTotal e cstUnique
  const buf = () => pedacos[iBuf];
  const restam = () => (iBuf < pedacos.length ? buf().length - pos : 0);
  const proximo = () => { iBuf++; pos = 0; return iBuf < pedacos.length; };
  const garante = n => { while (iBuf < pedacos.length && restam() < n) { if (!proximo()) return false; } return iBuf < pedacos.length; };
  const u8 = () => { garante(1); const v = buf()[pos]; pos += 1; return v; };
  const u16 = () => { garante(2); const v = buf().readUInt16LE(pos); pos += 2; return v; };
  const u32 = () => { garante(4); const v = buf().readUInt32LE(pos); pos += 4; return v; };
  const pular = n => { let f = n; while (f > 0 && iBuf < pedacos.length) { const d = Math.min(f, restam()); pos += d; f -= d; if (f > 0 && !proximo()) break; } };

  if (!pedacos.length) return textos;
  const total = pedacos[0].readUInt32LE(4); // cstUnique

  for (let i = 0; i < total && iBuf < pedacos.length; i++) {
    const cch = u16();
    let flags = u8();
    let alto = flags & 0x01, rico = flags & 0x08, ext = flags & 0x04;
    const nRuns = rico ? u16() : 0;
    const nExt = ext ? u32() : 0;

    let txt = '';
    let faltam = cch;
    while (faltam > 0 && iBuf < pedacos.length) {
      if (restam() === 0) {
        if (!proximo()) break;
        // cada CONTINUE recomeça dizendo se o pedaço é de 1 ou 2 bytes por letra
        alto = buf()[pos] & 0x01; pos += 1;
      }
      const cabem = alto ? Math.floor(restam() / 2) : restam();
      const n = Math.min(faltam, cabem);
      if (n <= 0) { if (!proximo()) break; alto = buf()[pos] & 0x01; pos += 1; continue; }
      txt += alto
        ? buf().toString('utf16le', pos, pos + n * 2)
        : Buffer.from(buf().subarray(pos, pos + n)).toString('latin1');
      pos += alto ? n * 2 : n;
      faltam -= n;
    }
    pular(nRuns * 4);
    pular(nExt);
    textos.push(txt);
  }
  return textos;
}

/** Número codificado em RK (o Excel comprime números pequenos assim). */
function valorRk(rk) {
  const inteiro = rk & 0x02, dividir = rk & 0x01;
  let v;
  if (inteiro) v = (rk | 0) >> 2;
  else {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(0, 0);
    b.writeUInt32LE(rk & 0xfffffffc, 4);
    v = b.readDoubleLE(0);
  }
  return dividir ? v / 100 : v;
}

/** Texto curto no formato do BIFF8 (usado em LABEL e nos nomes das abas). */
function textoBiff(buf, pos, tamCch) {
  const cch = tamCch === 1 ? buf[pos] : buf.readUInt16LE(pos);
  const flags = buf[pos + tamCch];
  const inicio = pos + tamCch + 1;
  return flags & 0x01
    ? buf.toString('utf16le', inicio, inicio + cch * 2)
    : Buffer.from(buf.subarray(inicio, inicio + cch)).toString('latin1');
}

/** .xls → [{ nome, linhas }]. */
function lerXls(buf) {
  const wb = streamDoOle(buf, ['Workbook', 'Book']);
  const regs = registrosBiff(wb);

  // --- globais: nomes/posições das abas e a tabela de textos
  const abasInfo = [];
  const pedacosSst = [];
  let dentroSst = false;
  for (const r of regs) {
    if (r.id === 0x0085) { // BOUNDSHEET
      abasInfo.push({ pos: r.dados.readUInt32LE(0), nome: textoBiff(r.dados, 6, 1) });
      dentroSst = false;
    } else if (r.id === 0x00fc) { pedacosSst.push(r.dados); dentroSst = true; }
    else if (r.id === 0x003c && dentroSst) pedacosSst.push(r.dados); // CONTINUE
    else if (r.id === 0x0809 && pedacosSst.length) dentroSst = false;
    else if (r.id !== 0x003c) dentroSst = dentroSst && false;
  }
  const textos = lerSst(pedacosSst);

  // --- cada aba é um "sub-arquivo" que começa na posição dita pelo BOUNDSHEET
  const abas = [];
  for (const info of abasInfo) {
    const regsAba = registrosBiff(wb.subarray(info.pos));
    const linhas = [];
    const por = (l, c, v) => {
      while (linhas.length <= l) linhas.push([]);
      const linha = linhas[l];
      while (linha.length <= c) linha.push('');
      linha[c] = String(v == null ? '' : v).trim();
    };
    let ultimaFormula = null;

    for (const r of regsAba) {
      const d = r.dados;
      if (r.id === 0x000a) break;                       // EOF da aba
      if (r.id === 0x00fd && d.length >= 10) {          // LABELSST
        por(d.readUInt16LE(0), d.readUInt16LE(2), textos[d.readUInt32LE(6)] ?? '');
      } else if (r.id === 0x0204 && d.length >= 8) {    // LABEL
        por(d.readUInt16LE(0), d.readUInt16LE(2), textoBiff(d, 6, 2));
      } else if (r.id === 0x0203 && d.length >= 14) {   // NUMBER
        por(d.readUInt16LE(0), d.readUInt16LE(2), numeroParaTexto(d.readDoubleLE(6)));
      } else if (r.id === 0x027e && d.length >= 10) {   // RK
        por(d.readUInt16LE(0), d.readUInt16LE(2), numeroParaTexto(valorRk(d.readUInt32LE(6))));
      } else if (r.id === 0x00bd && d.length >= 6) {    // MULRK
        const l = d.readUInt16LE(0); let c = d.readUInt16LE(2);
        for (let p = 4; p + 6 <= d.length - 2; p += 6, c++) {
          por(l, c, numeroParaTexto(valorRk(d.readUInt32LE(p + 2))));
        }
      } else if (r.id === 0x0006 && d.length >= 20) {   // FORMULA
        const l = d.readUInt16LE(0), c = d.readUInt16LE(2);
        if (d.readUInt16LE(12) === 0xffff && d[6] === 0) ultimaFormula = { l, c }; // texto vem no STRING
        else if (d.readUInt16LE(12) !== 0xffff) por(l, c, numeroParaTexto(d.readDoubleLE(6)));
      } else if (r.id === 0x0207 && ultimaFormula) {    // STRING (resultado de fórmula)
        por(ultimaFormula.l, ultimaFormula.c, textoBiff(d, 0, 2));
        ultimaFormula = null;
      }
    }
    abas.push({ nome: info.nome, linhas });
  }
  return abas;
}

module.exports = { ehXlsx, ehXls, lerXlsx, lerXls, numeroParaTexto };
