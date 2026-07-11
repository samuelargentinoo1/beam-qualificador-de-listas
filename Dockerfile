# Beam — Qualificador de Listas · imagem do MOTOR (worker + gerador)
# Base oficial do Playwright: já vem com Chromium + todas as dependências
# (a versão da imagem PRECISA casar com a do playwright-core no package-lock).
FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

# dependências primeiro (cache de build)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-fund --no-audit

# código
COPY server.js worker.js ./
COPY lib ./lib
COPY public ./public

# Chromium roda em modo headful (melhor contra anti-bot) dentro do Xvfb.
# data/ (ledger, perfil do Chrome) e listas/ (CSVs) são volumes persistentes.
ENV NODE_ENV=production
CMD ["xvfb-run", "-a", "--server-args=-screen 0 1440x900x24", "node", "worker.js"]
