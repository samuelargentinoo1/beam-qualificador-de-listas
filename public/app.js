'use strict';
/* Front do Qualificador de Listas — Beam + Babuya
   Funciona nos dois modos: local (localhost:3010) e painel na nuvem (Vercel). */

const $ = sel => document.querySelector(sel);

// ---------- senha do painel (só a nuvem exige; o local ignora) ----------
// LINK MÁGICO: abra o painel com  …vercel.app/#k=SENHA  e nunca mais digite nada —
// a senha entra sozinha, fica salva no navegador e some da barra de endereço.
(() => {
  const m = location.hash.match(/[#&]k=([^&]+)/);
  if (m) {
    localStorage.setItem('appPass', decodeURIComponent(m[1]).trim());
    history.replaceState(null, '', location.pathname); // limpa o link
  }
})();
const getPass = () => localStorage.getItem('appPass') || '';
const passQS = () => (getPass() ? `?pass=${encodeURIComponent(getPass())}` : '');

async function api(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), 'x-app-pass': getPass() };
  const r = await fetch(path, opts);
  if (r.status === 401) {
    const senha = prompt(
      getPass()
        ? '🔒 Senha incorreta. Digite a senha do painel (diferencia MAIÚSCULAS/minúsculas):'
        : '🔒 Senha do painel:'
    );
    if (senha != null && senha.trim() !== '') {
      localStorage.setItem('appPass', senha.trim()); // trim: mata espaço de colagem
      return api(path, opts); // tenta de novo com a senha nova
    }
    localStorage.removeItem('appPass'); // cancelou: limpa p/ pedir de novo depois
  }
  return r;
}

// ------------------------------------------------------------------- tabs
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'listas') loadLists();
  });
});

// --------------------------------------------------------------- gerar lista
$('#target').addEventListener('input', () => {
  $('#targetLabel').textContent = $('#target').value || '60';
});

$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  hide('#formError');
  const body = {
    query: $('#query').value.trim(),
    uf: $('#uf').value.trim(),
    target: parseInt($('#target').value, 10) || 60,
  };
  if (!body.query) return showError('Digite o que você quer, ex.: "imobiliárias de São José do Rio Preto".');

  $('#btnGerar').disabled = true;
  try {
    const r = await api('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) return showError(j.error || 'Erro ao iniciar.');
    show('#progress'); hide('#done');
    $('#hero').scrollIntoView({ behavior: 'smooth', block: 'start' });
    pollJob();
  } catch (err) {
    showError('Servidor fora do ar? ' + err.message);
  } finally {
    $('#btnGerar').disabled = false;
  }
});

$('#btnCancelar').addEventListener('click', async () => {
  await api('/api/job/cancel', { method: 'POST' });
});

$('#btnNova').addEventListener('click', () => {
  hide('#done'); hide('#progress');
  $('#query').value = ''; $('#query').focus();
});

// ------------------------------------------------------------------ polling
let pollTimer = null;

async function pollJob() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    try {
      const r = await api('/api/job/active');
      const { job } = await r.json();
      if (!job) return;
      renderJob(job);
      if (['concluído', 'erro', 'cancelado'].includes(job.status)) {
        clearInterval(pollTimer);
        renderDone(job);
      }
    } catch { /* servidor pode estar ocupado; tenta de novo */ }
  }, 1500);
}

function renderJob(job) {
  show('#progress');
  $('#progTitle').textContent =
    job.queued || job.status === 'na_fila' ? '🕐 Na fila — aguardando o computador de geração…'
    : job.status === 'rodando' ? `Gerando lista — ${etapa(job.stage)}` : `Status: ${job.status}`;
  $('#progQuery').textContent = `"${job.query}" · meta: ${job.target} leads qualificados`;
  const c = job.counts || {};
  $('#stCapturados').textContent = c.capturados || 0;
  $('#stLimpos').textContent = c.limpos || 0;
  $('#stJaEntregues').textContent = c.jaEntregues || 0;
  $('#stDescartados').textContent = c.descartados || 0;
  $('#stAdiados').textContent = c.adiados || 0;
  $('#stQualificados').textContent = c.qualificados || 0;
  const pct = Math.min(100, Math.round(((c.qualificados || 0) / job.target) * 100));
  $('#meterFill').style.width = pct + '%';
  $('#meterText').textContent = `${c.qualificados || 0} / ${job.target} qualificados`;
  $('#progStage').textContent = c.processando ? `Agora: ${c.processando}` : '';
  const logEl = $('#log');
  logEl.textContent = (job.log || []).join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

function renderDone(job) {
  hide('#progress'); show('#done');
  const r = job.result;
  if (job.status === 'erro') {
    $('#doneTitle').textContent = '❌ Deu erro na geração';
    $('#doneSub').textContent = job.error || '';
    $('#doneDownloads').innerHTML = '';
    return;
  }
  if (!r) return;
  const icon = r.status === 'completa' ? '✅' : r.status === 'esgotada' ? '🟡' : '⚠️';
  $('#doneTitle').textContent = `${icon} Lista #${r.n} — ${r.delivered} leads qualificados`;
  $('#doneSub').textContent =
    `${r.segment} · ${r.city}${r.uf ? '/' + r.uf : ''} · ` +
    (r.status === 'completa'
      ? 'meta batida, dados cruzados e prontos pro Pipedrive.'
      : r.status === 'esgotada'
        ? `a praça rendeu ${r.delivered} de ${r.target} hoje (sem repetir listas anteriores).`
        : 'geração cancelada — salvei o que já estava pronto.');
  $('#doneDownloads').innerHTML = downloadsHtml(r);
  loadLists();
}

function downloadsHtml(r) {
  const has = kind => !r.files || !!r.files[kind];
  const link = (kind, label, cls = '') => has(kind)
    ? `<a class="dl ${cls}" href="/api/lists/${r.id}/file/${kind}${passQS()}">⬇ ${label}</a>` : '';
  return [
    link('final', 'Lista Final (cruzada)', 'primary'),
    link('pipedrive', 'CSV Pipedrive'),
    link('limpa', 'Lista Limpa'),
    link('bruta', 'Lista Bruta'),
    link('descartes', 'Descartes'),
  ].join('');
}

function etapa(stage) {
  return ({
    iniciando: 'preparando…',
    captura: 'capturando no Google Maps',
    enriquecimento: 'cruzando dados (site ✚ CNPJ ✚ Instagram)',
    exportando: 'gerando os arquivos',
    'concluído': 'concluído',
  })[stage] || stage;
}

// -------------------------------------------------------------- minhas listas
async function loadLists() {
  const r = await api('/api/lists');
  const { lists, deliveredByKey } = await r.json();
  const wrap = $('#listas');
  wrap.innerHTML = '';
  if (!lists.length) { show('#listasVazio'); return; }
  hide('#listasVazio');
  for (const l of lists) {
    const d = new Date(l.date);
    const dateStr = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
    const totalPraca = deliveredByKey[l.key] ?? l.delivered;
    const el = document.createElement('div');
    el.className = 'lista-card';
    el.innerHTML = `
      <div class="lista-num">#${l.n}</div>
      <div class="lista-info">
        <h3>${l.segment} · ${l.city}${l.uf ? '/' + l.uf : ''}
          <span class="badge ${l.status}">${l.status}</span></h3>
        <p>${dateStr} · <b>${l.delivered}</b> leads entregues nesta lista ·
           total na praça: <b>${totalPraca}</b> (não repetem nas próximas)</p>
      </div>
      <div class="lista-actions">${downloadsHtml(l)}</div>`;
    wrap.appendChild(el);
  }
}

// ------------------------------------------------------------------- helpers
function show(sel) { $(sel).classList.remove('hidden'); }
function hide(sel) { $(sel).classList.add('hidden'); }
function showError(msg) { $('#formError').textContent = msg; show('#formError'); }

// retoma job em andamento se a página recarregar
(async () => {
  try {
    const r = await api('/api/job/active');
    const { job } = await r.json();
    if (job && job.status === 'rodando') { show('#progress'); pollJob(); }
    else if (job && job.result) { renderDone(job); }
  } catch {}
  loadLists();
})();
