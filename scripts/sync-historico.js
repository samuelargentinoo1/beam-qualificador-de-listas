'use strict';
// Migra o HISTÓRICO local (data/lists.json + CSVs finais) para o Supabase,
// para o painel na nuvem mostrar e permitir baixar TODAS as listas.
// Idempotente: pode rodar de novo sem duplicar (upsert + delete/insert).
// Uso:  node scripts/sync-historico.js

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// .env
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { createClient } = require('@supabase/supabase-js');
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } });

function parseCsv(txt) {
  const lines = txt.replace(/^﻿/, '').split('\n').filter(Boolean);
  const parse = s => {
    const o = []; let cur = '', q = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { o.push(cur); cur = ''; }
      else cur += c;
    }
    o.push(cur); return o;
  };
  return lines.map(parse);
}

(async () => {
  const lists = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'lists.json'), 'utf8'));
  let listsOk = 0, leadsOk = 0;

  for (const l of lists) {
    await db.from('lists').upsert({
      id: l.id, n: l.n, date: l.date, segment: l.segment, city: l.city,
      uf: l.uf || '', key: l.key, target: l.target, delivered: l.delivered,
      status: l.status, totals: l.totals,
    });
    listsOk++;

    const csvPath = l.files && l.files.final;
    if (!csvPath || !fs.existsSync(csvPath)) { console.log(`#${l.n}: sem CSV final — só metadados`); continue; }

    const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
    const header = rows[0].map(h => h.toLowerCase());
    const idx = name => header.findIndex(h => h.includes(name));
    const iNome = idx('nome da empresa'), iCid = idx('cidade'), iEst = idx('estado'),
      iTel = idx('telefone'), iSite = idx('site'), iIg = idx('instagram'),
      iVer = idx('verифica') >= 0 ? idx('verифica') : idx('verifica'),
      iSoc = idx('cios') >= 0 ? idx('cios') : idx('socios'),
      iDec = idx('decisor'), iCnpj = idx('cnpj');

    const leads = rows.slice(1)
      .filter(r => iDec >= 0 && (r[iDec] || '').trim()) // só leads enriquecidos de verdade
      .map(r => {
        const igRaw = iIg >= 0 ? (r[iIg] || '') : '';
        const h = igRaw.match(/instagram\.com\/([A-Za-z0-9_.]+)/);
        return {
          list_id: l.id, praca: l.key,
          nome: r[iNome], cidade: r[iCid], estado: r[iEst] || l.uf || '',
          telefone: r[iTel], site: r[iSite],
          instagram_url: /^https?:/.test(igRaw) ? igRaw : '',
          instagram: h ? '@' + h[1] : (igRaw.startsWith('@') ? igRaw : ''),
          ig_status: iVer >= 0 ? r[iVer] : '',
          socios: iSoc >= 0 ? r[iSoc] : '',
          decisor: r[iDec],
          cnpj: iCnpj >= 0 ? r[iCnpj] : '',
        };
      });

    await db.from('leads').delete().eq('list_id', l.id);
    for (let i = 0; i < leads.length; i += 200) {
      const { error } = await db.from('leads').insert(leads.slice(i, i + 200));
      if (error) { console.log(`#${l.n}: ERRO leads — ${error.message}`); break; }
    }
    leadsOk += leads.length;
    console.log(`#${l.n} ${l.city}: ${leads.length} leads sincronizados`);
  }
  console.log(`\nFIM: ${listsOk} listas, ${leadsOk} leads no Supabase.`);
})();
