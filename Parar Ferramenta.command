#!/bin/bash
# ⏹ Beam — Qualificador de Listas
# Duplo clique para desligar a ferramenta.

pkill -f "node worker.js" 2>/dev/null && echo "⏹ Worker da nuvem desligado."
pkill -f "node server.js" 2>/dev/null && echo "⏹ Ferramenta desligada." || echo "A ferramenta já estava desligada."
