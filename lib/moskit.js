'use strict';
// Integração Moskit CRM — sobe cada lista gerada automaticamente.
// Por lead qualificado cria: EMPRESA + CONTATO (decisor) + NEGÓCIO (R$ 3.000,
// funil Outbound → etapa Prospecto), sincronizando com os CAMPOS PERSONALIZADOS
// que já existem na conta. Anti-duplicado: se a empresa já existe no Moskit,
// o lead é pulado (não cria nada em dobro).
//
// Config (arquivo .env): MOSKIT_API_KEY, MOSKIT_STAGE_ID, MOSKIT_RESPONSIBLE_ID

const { norm, sleep } = require('./util');

const BASE = 'https://api.moskitcrm.com/v2';

// Campos personalizados existentes na conta (descobertos via API em 2026-07-10).
// Se você criar/renomear campos no Moskit, atualize aqui.
const CF = {
  company: {
    socios: 'CF_3nGqEZUrCyVAJMYA',          // "Socios" (TEXT)
    site: 'CF_2wpDloUnCG6yzmvL',            // "Site correto" (TEXT)
    instagram: 'CF_gPpD7kUkCBGkNDvo',       // "Instagram empresa correto" (TEXT)
  },
  contact: {
    cargo: 'CF_075MJBSjC9EgeMaz',           // "Cargo ou Função" (TEXT)
  },
  deal: {
    instagram: 'CF_3nGqEoirCNx60mYA',       // "Instagram Out" (URL → textValue)
    cidade: 'CF_lXODObiYCgZ0emaN',          // "Cidade" (TEXT)
    cnpj: 'CF_GwyMgWiaSaw4NMLA',            // "CNPJ" (NUMBER → numericValue)
    nomeSocio: 'CF_GwyMgWi9Caw49MLA',       // "Nome do Sócio" (TEXT)
    site: 'CF_2wpDlkinC4bx4mvL',            // "Site" (URL → textValue)
  },
};

function cfg() {
  const key = process.env.MOSKIT_API_KEY;
  if (!key) return null;
  return {
    key,
    stageId: parseInt(process.env.MOSKIT_STAGE_ID, 10) || 510043,        // Outbound → Prospecto
    userId: parseInt(process.env.MOSKIT_RESPONSIBLE_ID, 10) || 155074,   // Ana Julia
  };
}

async function mk(c, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { apikey: c.key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { /* html/erro */ }
  if (!r.ok || (Array.isArray(data) && data[0]?.messageError)) {
    const msg = Array.isArray(data)
      ? data.map(e => `${e.field}: ${e.messageError}`).join('; ')
      : `HTTP ${r.status}`;
    throw new Error(`Moskit ${method} ${path} → ${msg}`);
  }
  return data;
}

function orgName(displayName) {
  return String(displayName || '').replace(/^F - /, '').split('|')[0].trim();
}

/** Empresa já existe no Moskit? (busca por nome, comparação normalizada) */
async function findCompany(c, name) {
  const found = await mk(c, 'GET', `/companies?name=${encodeURIComponent(name)}&quantity=10`).catch(() => []);
  const alvo = norm(name);
  return (found || []).find(x => norm(x.name) === alvo) || null;
}

/** Sobe 1 lead. Retorna { status: 'criado'|'ja_existia', ids? } */
async function uploadLead(c, lead, listaInfo) {
  const org = orgName(lead.displayName || lead.nome || lead.name);

  const existente = await findCompany(c, org);
  if (existente) return { status: 'ja_existia', companyId: existente.id };

  const quem = { createdBy: { id: c.userId }, responsible: { id: c.userId } };

  // 1) EMPRESA
  const companyEcf = [];
  if (lead.socios) companyEcf.push({ id: CF.company.socios, textValue: String(lead.socios).slice(0, 900) });
  if (lead.site) companyEcf.push({ id: CF.company.site, textValue: lead.site });
  if (lead.instagramUrl) companyEcf.push({ id: CF.company.instagram, textValue: lead.instagramUrl });
  const company = await mk(c, 'POST', '/companies', {
    name: org, ...quem, entityCustomFields: companyEcf,
  });

  // 2) CONTATO (decisor)
  let contact = null;
  if (lead.decisor) {
    contact = await mk(c, 'POST', '/contacts', {
      name: lead.decisor,
      ...quem,
      phones: lead.phone ? [{ number: lead.phone }] : [],
      employers: [{ company: { id: company.id } }],
      entityCustomFields: [{ id: CF.contact.cargo, textValue: 'Sócio-Administrador' }],
    }).catch(e => { throw new Error('contato: ' + e.message); });
  }

  // 3) NEGÓCIO — padrão de nome da casa: "PrimeiroNome - Empresa"
  const primeiroNome = String(lead.decisor || '').split(' ')[0] || org;
  const dealEcf = [];
  if (lead.instagramUrl) dealEcf.push({ id: CF.deal.instagram, textValue: lead.instagramUrl });
  const cidadeUf = [listaInfo.cidade, listaInfo.uf].filter(Boolean).join(', ');
  if (cidadeUf) dealEcf.push({ id: CF.deal.cidade, textValue: cidadeUf });
  const cnpjDigits = String(lead.cnpj || '').replace(/\D/g, '');
  if (cnpjDigits.length === 14) dealEcf.push({ id: CF.deal.cnpj, numericValue: Number(cnpjDigits) });
  if (lead.decisor) dealEcf.push({ id: CF.deal.nomeSocio, textValue: lead.decisor });
  if (lead.site) dealEcf.push({ id: CF.deal.site, textValue: lead.site });

  const deal = await mk(c, 'POST', '/deals', {
    name: `${primeiroNome} - ${org}`,
    ...quem,
    stage: { id: c.stageId },
    status: 'OPEN',
    // SEM valor: decisão do usuário (2026-07-10) — negócio entra zerado no Moskit
    companies: [{ id: company.id }],
    contacts: contact ? [{ id: contact.id }] : [],
    entityCustomFields: dealEcf,
  });

  return { status: 'criado', companyId: company.id, contactId: contact?.id, dealId: deal.id };
}

/**
 * Sobe a lista inteira pro Moskit. Chamada pelo runner ao fim de cada geração.
 * Retorna { criados, jaExistiam, erros }.
 */
async function uploadList(leads, listaInfo, log = () => {}) {
  const c = cfg();
  if (!c) { log('Moskit: sem MOSKIT_API_KEY no .env — upload pulado.'); return null; }

  log(`Moskit: subindo ${leads.length} leads (funil Outbound → Prospecto, responsável Ana Julia)…`);
  let criados = 0, jaExistiam = 0, erros = 0;
  for (const lead of leads) {
    const org = orgName(lead.displayName || lead.name);
    try {
      const r = await uploadLead(c, lead, listaInfo);
      if (r.status === 'criado') { criados++; log(`Moskit ✓ ${org} — negócio #${r.dealId}`); }
      else { jaExistiam++; log(`Moskit ↷ ${org} — já existia (pulado)`); }
    } catch (e) {
      erros++;
      log(`Moskit ✖ ${org} — ${String(e.message).slice(0, 140)}`);
    }
    await sleep(350); // gentileza com a API
  }
  log(`Moskit: fim — ${criados} criados, ${jaExistiam} já existiam, ${erros} erros.`);
  return { criados, jaExistiam, erros };
}

module.exports = { uploadList };
