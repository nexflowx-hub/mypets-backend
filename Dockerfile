FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache openssl
COPY package.json ./
RUN npm install
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache openssl && addgroup -S mypets && adduser -S mypets -G mypets
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
USER mypets
EXPOSE 8081
CMD ["node", "dist/index.js"]
