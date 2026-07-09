'use strict';
// Passos 4 e 5 — Gera os arquivos da lista no padrão do processo:
//   #N-lista-bruta-de-prospeccao-<slug>.csv
//   #N-lista-limpa-de-prospeccao-<slug>.csv
//   #N-lista-final-de-prospeccao-<slug>.csv     (só os qualificados)
//   #N-pipedrive-import-<slug>.csv              (14 colunas)
//   #N-descartes-<slug>.csv                     (transparência do funil)

const path = require('path');
const { writeCsv, slug, titleCase } = require('./util');

const PIPE_COLS = [
  'Person - Name', 'Person - First name', 'Person - Last name', 'Person - Phone',
  'Person - Email (Work)', 'Person - Email (Home)', 'Organization - Name', 'Organization - Address',
  'Deal - Title', 'Deal - Value', 'Deal - Stage', 'Activity - Subject', 'Activity - Due date', 'Note - Content',
];

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length <= 1) return [full, ''];
  return [parts[0], parts.slice(1).join(' ')];
}

function orgName(displayName) {
  return String(displayName || '').replace(/^F - /, '').split('|')[0].trim();
}

function exportList({ baseDir, n, segment, city, uf, raw, cleaned, cut, qualified, discarded }) {
  const now = new Date();
  const ym = `${now.getFullYear()} - ${String(now.getMonth() + 1).padStart(2, '0')}`;
  const slugFull = [slug(segment), slug(city), uf ? slug(uf) : '', 'beambrocker+babuya']
    .filter(Boolean).join('-');
  const folder = path.join(baseDir, 'listas', `lista de prospeccao - ${ym}`, `#${n}-${slugFull}`);

  const f = kind => path.join(folder, `#${n}-${kind}-${slugFull}.csv`);
  const files = {
    bruta: f('lista-bruta-de-prospeccao'),
    limpa: f('lista-limpa-de-prospeccao'),
    final: f('lista-final-de-prospeccao'),
    pipedrive: f('pipedrive-import'),
    descartes: f('descartes'),
  };

  const cityT = titleCase(city);

  // BRUTA
  writeCsv(files.bruta, [
    ['Nome', 'Nota', 'Avaliacoes', 'Telefone', 'Site', 'Categoria', 'Endereco'],
    ...raw.map(r => [r.name, r.rating, r.reviews, r.phone, r.website, r.category, r.address]),
  ]);

  // LIMPA
  writeCsv(files.limpa, [
    ['Nome da Empresa', 'Cidade', 'Estado', 'Telefone', 'Site'],
    ...cleaned.map(c => [c.displayName, cityT, uf || '', c.phone, c.website]),
  ]);

  // FINAL (qualificados — dados cruzados). Site e Instagram como LINK completo.
  writeCsv(files.final, [
    ['Nome da Empresa', 'Cidade', 'Estado', 'Telefone', 'Site', 'Instagram (link)',
     'Verificação Instagram', 'Sócios', 'Decisor (sócio/sócia adm)', 'CNPJ'],
    ...qualified.map(q => [q.displayName, cityT, uf || '', q.phone, q.site,
      q.instagramUrl || 'não encontrado', q.igStatus, q.socios, q.decisor, q.cnpj]),
  ]);

  // PIPEDRIVE (14 colunas)
  const pipeRows = [PIPE_COLS];
  for (const q of qualified) {
    const org = orgName(q.displayName);
    const [fn, ln] = splitName(q.decisor);
    const note = `Instagram: ${q.instagramUrl || 'não encontrado'} (${q.igStatus}) | Sócios: ${q.socios} | Site: ${q.site} | CNPJ: ${q.cnpj}`;
    pipeRows.push([
      q.decisor, fn, ln, q.phone, '', '', org, `${cityT}${uf ? ', ' + uf : ''}`,
      `Consultoria — ${org}`, '3000', 'Prospecto', '', '', note,
    ]);
  }
  writeCsv(files.pipedrive, pipeRows);

  // DESCARTES (limpeza + enriquecimento)
  writeCsv(files.descartes, [
    ['Nome', 'Etapa', 'Motivo'],
    ...cut.map(c => [c.name, 'limpeza', c.reason]),
    ...discarded.map(d => [d.name, 'enriquecimento', d.reason]),
  ]);

  return { folder, files, slugFull };
}

module.exports = { exportList };
