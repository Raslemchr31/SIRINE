# retrieval-api — small read-only catalog service.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
EXPOSE 8088
CMD ["node", "server.mjs"]
