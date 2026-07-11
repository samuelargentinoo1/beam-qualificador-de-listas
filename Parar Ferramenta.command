#!/bin/bash
# ⏹ O sistema roda no SERVIDOR (VPS) — nada pra parar neste Mac.
pkill -f "node worker.js" 2>/dev/null
pkill -f "node server.js" 2>/dev/null
echo "Processos locais (se havia algum) foram parados."
echo "O gerador continua no servidor. Para pará-lo lá: docker stop beam-qualificador"
