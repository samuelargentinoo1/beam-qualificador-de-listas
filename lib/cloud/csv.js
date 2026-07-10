'use strict';
// Gera os CSVs (lista final e Pipedrive) a partir dos leads no Supabase —
// mesmo formato dos arquivos gerados localmente pelo exporter.

function esc(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}
const row = cols => cols.map(esc).join(',');

function finalCsv(leads) {
  const out = [row(['Nome da Empresa', 'Cidade', 'Estado', 'Telefone', 'Site', 'Instagram (link)',
    'Verificação Instagram', 'Sócios', 'Decisor (sócio/sócia adm)', 'CNPJ'])];
  for (const l of leads) {
    out.push(row([l.nome, l.cidade, l.estado, l.telefone, l.site,
      l.instagram_url || 'não encontrado', l.ig_status, l.socios, l.decisor, l.cnpj]));
  }
  return '﻿' + out.join('\n') + '\n';
}

function pipedriveCsv(leads) {
  const cols = ['Person - Name', 'Person - First name', 'Person - Last name', 'Person - Phone',
    'Person - Email (Work)', 'Person - Email (Home)', 'Organization - Name', 'Organization - Address',
    'Deal - Title', 'Deal - Value', 'Deal - Stage', 'Activity - Subject', 'Activity - Due date', 'Note - Content'];
  const out = [row(cols)];
  for (const l of leads) {
    const org = String(l.nome || '').replace(/^F - /, '').split('|')[0].trim();
    const parts = String(l.decisor || '').trim().split(/\s+/);
    const fn = parts[0] || '', ln = parts.slice(1).join(' ');
    const note = `Instagram: ${l.instagram_url || 'não encontrado'} (${l.ig_status || ''}) | Sócios: ${l.socios || ''} | Site: ${l.site || ''} | CNPJ: ${l.cnpj || ''}`;
    out.push(row([l.decisor, fn, ln, l.telefone, '', '', org,
      `${l.cidade}${l.estado ? ', ' + l.estado : ''}`,
      `Consultoria — ${org}`, '3000', 'Prospecto', '', '', note]));
  }
  return '﻿' + out.join('\n') + '\n';
}

module.exports = { finalCsv, pipedriveCsv };
