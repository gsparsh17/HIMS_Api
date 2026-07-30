FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY apps/consent-validator ./apps/consent-validator
USER node
EXPOSE 8180
CMD ["node", "apps/consent-validator/server.js"]
