'use strict';
/* Front do Qualificador de Listas — Beam + Babuya
   Funciona nos dois modos: local (localhost:3010, sem login) e painel na nuvem (login individual). */

const $ = sel => document.querySelector(sel);
const esc = s => String(s == null ? '' : s)
  .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- login individual (só a nuvem exige; o local ignora) ----------
// Cada SDR entra com o SEU usuário: é assim que os leads da lista caem no Moskit
// com essa pessoa como responsável.
// LINK MÁGICO: abra o painel com  …/#u=julia&k=SENHA  — entra sozinho, fica salvo
// no navegador e some da barra de endereço.
(() => {
  const u = location.hash.match(/[#&]u=([^&]+)/);
  const k = location.hash.match(/[#&]k=([^&]+)/);
  if (u) localStorage.setItem('appUser', decodeURIComponent(u[1]).trim().toLowerCase());
  if (k) localStorage.setItem('appPass', decodeURIComponent(k[1]).trim());
  if (u || k) history.replaceState(null, '', location.pathname); // limpa o link
})();
const getUser = () => localStorage.getItem('appUser') || '';
const getPass = () => localStorage.getItem('appPass') || '';
// links de download não mandam cabeçalho → credenciais vão na query
const authQS = () => (getPass() ? `?user=${encodeURIComponent(getUser())}&pass=${encodeURIComponent(getPass())}` : '');

let loginAberto = null; // Promise única enquanto a tela de login está na frente
function pedirLogin(msg) {
  if (!loginAberto) {
    loginAberto = new Promise(resolve => {
      $('#loginMsg').textContent = msg || '';
      $('#loginUser').value = getUser();
      $('#loginPass').value = '';
      $('#loginBtn').disabled = false;
      show('#login');
      (getUser() ? $('#loginPass') : $('#loginUser')).focus();
      $('#loginForm').onsubmit = e => {
        e.preventDefault();
        localStorage.setItem('appUser', $('#loginUser').value.trim().toLowerCase());
        localStorage.setItem('appPass', $('#loginPass').value.trim()); // trim: mata espaço de colagem
        // a tela NÃO some agora: ela só sai quando uma chamada passar de verdade
        // (senão ela pisca e volta a cada senha errada)
        $('#loginMsg').textContent = 'conferindo…';
        $('#loginBtn').disabled = true;
        loginAberto = null;
        resolve();
      };
    });
  }
  return loginAberto;
}

async function api(path, opts = {}) {
  opts.headers = { ...(opts.headers || {}), 'x-app-user': getUser(), 'x-app-pass': getPass() };
  const r = await fetch(path, opts);
  if (r.status === 401) {
    const j = await r.json().catch(() => ({}));
    // primeira visita (nada salvo): tela limpa; com credencial salva: mostra o motivo
    await pedirLogin(getPass() ? (j.error || 'Usuário ou senha incorretos.') : '');
    return api(path, opts); // tenta de novo com o login novo
  }
  hide('#login'); // deu certo (ou é erro de servidor): a tela de login sai
  if (r.status === 503) {
    // servidor sem banco/tabela: mostra a instrução na tela (não adianta insistir)
    const j = await r.clone().json().catch(() => ({}));
    if (j.error) showError(j.error);
  }
  return r;
}

// quem está logado → nome no topo (no modo local não tem login: fica escondido)
async function carregaUsuario() {
  try {
    const r = await api('/api/me');
    const me = await r.json();
    if (me && me.nome) { $('#whoNome').innerHTML = `👤 <b>${esc(me.nome)}</b>`; show('#who'); }
    else hide('#who');
  } catch { /* servidor fora */ }
}
$('#btnSair').addEventListener('click', () => {
  localStorage.removeItem('appUser');
  localStorage.removeItem('appPass');
  location.reload();
});

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
  // no modo planilha o botão não tem o contador (o alvo é a planilha inteira)
  const label = $('#targetLabel');
  if (label) label.textContent = $('#target').value || '60';
});

// ------------------------------------------------------- planilha (nome+CNPJ)
// O arquivo é lido aqui só pra virar texto; quem valida colunas e CNPJ é o
// servidor (lib/importar.js), pra ter UMA regra só — e não duas divergindo.
let planilhaTexto = null;

$('#btnPlanilha').addEventListener('click', () => $('#planilha').click());

$('#planilha').addEventListener('change', async e => {
  const file = e.target.files[0];
  if (!file) return;
  hide('#formError');
  planilhaTexto = await file.text();
  const linhas = planilhaTexto.split('\n').filter(l => l.trim()).length;
  $('#planilhaNome').textContent = `${file.name} — ~${Math.max(0, linhas - 1)} linhas`;
  show('#planilhaInfo');
  $('#btnPlanilha').classList.add('hidden');
  $('#query').placeholder = 'ex.: imobiliárias  (só o segmento — a cidade vem do CNPJ)';
  atualizaBotao();
});

$('#btnTirarPlanilha').addEventListener('click', () => {
  planilhaTexto = null;
  $('#planilha').value = '';
  hide('#planilhaInfo');
  $('#btnPlanilha').classList.remove('hidden');
  $('#query').placeholder = 'ex.: imobiliárias de São José do Rio Preto';
  atualizaBotao();
});

function atualizaBotao() {
  $('#btnGerar').textContent = planilhaTexto ? 'Qualificar planilha' : '';
  if (!planilhaTexto) {
    $('#btnGerar').innerHTML = 'Gerar <span id="targetLabel">' + ($('#target').value || '60') + '</span> leads';
  }
}

$('#searchForm').addEventListener('submit', async e => {
  e.preventDefault();
  hide('#formError');
  const body = {
    query: $('#query').value.trim(),
    uf: $('#uf').value.trim(),
    target: parseInt($('#target').value, 10) || 60,
  };
  if (planilhaTexto) {
    body.planilha = planilhaTexto;
    delete body.target; // planilha: o alvo é qualificar tudo que veio nela
  }
  if (!body.query) {
    return showError(planilhaTexto
      ? 'Escreva o segmento da planilha, ex.: "imobiliárias" — é ele que forma a praça do anti-repetido.'
      : 'Digite o que você quer, ex.: "imobiliárias de São José do Rio Preto".');
  }

  $('#btnGerar').disabled = true;
  try {
    const r = await api('/api/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) return showError(j.error || 'Erro ao iniciar.');
    if (j.planilha) {
      const d = j.planilha.descartadas;
      $('#planilhaNome').textContent =
        `${j.planilha.validas} empresa(s) na fila` + (d ? ` · ${d} linha(s) sem CNPJ válido, ignorada(s)` : '');
    }
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
    if (loginAberto) return; // tela de login na frente: não empilha chamadas
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
  const filaExtra = job.queueCount > 1 ? ` (+${job.queueCount - 1} na fila)` : '';
  $('#progTitle').textContent =
    job.queued || job.status === 'na_fila' ? `🕐 Na fila${filaExtra} — aguardando o computador de geração…`
    : job.status === 'rodando' ? `Gerando lista — ${etapa(job.stage)}${job.queueCount ? ` · fila: +${job.queueCount}` : ''}` : `Status: ${job.status}`;
  const daPlanilha = job.origem === 'planilha' || job.linhasPlanilha > 0;
  const quem = job.usuario ? `pedido de ${job.usuario} · ` : '';
  $('#progQuery').textContent = quem + (daPlanilha
    ? `"${job.query}" · planilha com ${job.linhasPlanilha || job.target} empresa(s)`
    : `"${job.query}" · meta: ${job.target} leads qualificados`);
  // no modo planilha nada é "capturado no Maps" — são as linhas que você subiu
  const rotuloCap = $('#stCapturados').parentElement.querySelector('label');
  if (rotuloCap) rotuloCap.innerHTML = daPlanilha ? 'linhas<br>da planilha' : 'capturados<br>no Maps';
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
  const m = r.moskit;
  const moskitTxt = m && m.responsavel
    ? ` Moskit: ${m.criados} criado(s), responsável ${m.responsavel}.` : '';
  $('#doneSub').textContent =
    `${r.segment} · ${r.city}${r.uf ? '/' + r.uf : ''} · ` +
    (r.status === 'completa'
      ? 'meta batida, dados cruzados e prontos.'
      : r.status === 'esgotada'
        ? `a praça rendeu ${r.delivered} de ${r.target} hoje (sem repetir listas anteriores).`
        : 'geração cancelada — salvei o que já estava pronto.') + moskitTxt;
  $('#doneDownloads').innerHTML = downloadsHtml(r);
  loadLists();
}

function downloadsHtml(r) {
  const has = kind => !r.files || !!r.files[kind];
  const link = (kind, label, cls = '') => has(kind)
    ? `<a class="dl ${cls}" href="/api/lists/${r.id}/file/${kind}${authQS()}">⬇ ${label}</a>` : '';
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
    'subindo pro Moskit': 'subindo pro Moskit',
    'concluído': 'concluído',
  })[stage] || stage;
}

// -------------------------------------------------------------- minhas listas
async function loadLists() {
  const r = await api('/api/lists');
  if (!r.ok) return;
  const { lists, deliveredByKey } = await r.json();
  const wrap = $('#listas');
  wrap.innerHTML = '';
  if (!lists.length) { show('#listasVazio'); return; }
  hide('#listasVazio');
  for (const l of lists) {
    const d = new Date(l.date);
    const dateStr = d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
    const totalPraca = deliveredByKey[l.key] ?? l.delivered;
    // nuvem: usuario_nome (+ login em usuario); local: só o nome em usuario
    const autor = l.usuario_nome || l.usuario;
    const el = document.createElement('div');
    el.className = 'lista-card';
    el.innerHTML = `
      <div class="lista-num">#${l.n}</div>
      <div class="lista-info">
        <h3>${l.segment} · ${l.city}${l.uf ? '/' + l.uf : ''}
          <span class="badge ${l.status}">${l.status}</span></h3>
        <p>${dateStr}${autor ? ` · por <b>${esc(autor)}</b>` : ''} · <b>${l.delivered}</b> leads entregues nesta lista ·
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

// primeiro o login (se precisar), depois retoma job em andamento e carrega o histórico
(async () => {
  await carregaUsuario();
  try {
    const r = await api('/api/job/active');
    const { job } = r.ok ? await r.json() : {};
    if (job && job.status === 'rodando') { show('#progress'); pollJob(); }
    else if (job && job.result) { renderDone(job); }
  } catch {}
  loadLists();
})();
