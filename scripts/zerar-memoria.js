'use strict';
// Zera a MEMÓRIA da ferramenta — o ledger anti-repetido, o histórico de listas
// e o contador de numeração. Depois disso a ferramenta volta a tratar toda praça
// como inédita e a próxima lista sai como #1.
//
// O mecanismo anti-repetido CONTINUA ligado: só o conteúdo é apagado, para que
// ele volte a acumular do zero.
//
// Uso (no VPS, com o container PARADO — senão o worker reescreve os arquivos):
//   docker compose down
//   node scripts/zerar-memoria.js
//   docker compose up -d --build
//
// Faz backup com data no nome antes de sobrescrever (data/backup-memoria-*/).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');

// Estado "recém-instalado" de cada arquivo. Precisa casar com os defaults que
// lib/ledger.js e lib/runner.js usam quando o arquivo não existe.
const ZERADO = {
  'ledger.json': { version: 1, entries: {} },
  'lists.json': [],
  'meta.json': { lastListNumber: 0 },
};

function carimbo() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function main() {
  if (!fs.existsSync(DATA)) {
    console.error(`✖ Não achei ${DATA} — rode este script de dentro da pasta do projeto.`);
    process.exit(1);
  }

  const backupDir = path.join(DATA, `backup-memoria-${carimbo()}`);
  fs.mkdirSync(backupDir, { recursive: true });

  for (const [arquivo, vazio] of Object.entries(ZERADO)) {
    const alvo = path.join(DATA, arquivo);

    if (fs.existsSync(alvo)) {
      fs.copyFileSync(alvo, path.join(backupDir, arquivo));
      // Resumo do que estava lá, pra ficar claro no log o que foi apagado.
      try {
        const antes = JSON.parse(fs.readFileSync(alvo, 'utf8'));
        if (arquivo === 'ledger.json') {
          const pracas = Object.keys(antes.entries || {});
          const leads = pracas.reduce(
            (n, k) => n + Object.values(antes.entries[k].delivered || {}).filter(v => !v.ref).length, 0);
          console.log(`  ${arquivo}: ${pracas.length} praça(s), ${leads} lead(s) entregue(s) → zerado`);
        } else if (arquivo === 'lists.json') {
          console.log(`  ${arquivo}: ${(antes || []).length} lista(s) no histórico → zerado`);
        } else {
          console.log(`  ${arquivo}: última lista era a #${antes.lastListNumber || 0} → próxima será a #1`);
        }
      } catch {
        console.log(`  ${arquivo}: conteúdo ilegível → sobrescrito`);
      }
    } else {
      console.log(`  ${arquivo}: não existia → criado zerado`);
    }

    fs.writeFileSync(alvo, JSON.stringify(vazio, null, 2));
  }

  console.log(`\n✅ Memória zerada. Backup do estado anterior: ${backupDir}`);
  console.log('   O anti-repetido segue ativo — volta a acumular a partir da próxima lista.');
}

main();
