# agent-handler — Chatwoot AgentBot webhook → Gemini agent (function-calling + memory + vision) → reply.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
COPY lib.mjs ./
COPY system-prompt.md ./
COPY shipping.json ./
EXPOSE 8082
CMD ["node", "server.mjs"]
