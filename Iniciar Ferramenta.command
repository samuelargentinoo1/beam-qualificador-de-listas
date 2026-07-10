#!/bin/bash
# ⚡ Beam — Qualificador de Listas
# Duplo clique neste arquivo para ligar a ferramenta e abrir no navegador.

cd "$(dirname "$0")"

# 1ª execução nesta máquina: instala as dependências
if [ ! -d node_modules ]; then
  echo "Primeira execução: instalando dependências (só desta vez)…"
  npm install --no-fund --no-audit
fi

# sobe o servidor, se ainda não estiver no ar
if ! curl -s -m 2 http://localhost:3010/api/health > /dev/null 2>&1; then
  echo "Iniciando a Ferramenta…"
  nohup node server.js >> server.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    curl -s -m 2 http://localhost:3010/api/health > /dev/null 2>&1 && break
  done
fi

# liga o worker da nuvem (fila do painel na Vercel), se o .env existir
if [ -f .env ] && ! pgrep -f "node worker.js" > /dev/null 2>&1; then
  echo "Ligando o worker da nuvem (fila do painel)…"
  nohup node worker.js >> worker.log 2>&1 &
fi

open "http://localhost:3010"
echo ""
echo "✅ Ferramenta no ar: http://localhost:3010"
[ -f .env ] && echo "☁️  Worker da nuvem ligado — pedidos feitos no painel da Vercel rodam aqui."
echo "   Pode fechar esta janela — a ferramenta continua rodando."
