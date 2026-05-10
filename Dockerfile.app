FROM scratch

WORKDIR /app

COPY vendor/node-runtime/ /
COPY node_modules ./node_modules
COPY dist ./dist
COPY public ./public
COPY package.json ./package.json

ENV NODE_ENV=production
ENV APP_PORT=42110

EXPOSE 42110

CMD ["/usr/bin/node", "/app/dist/server.js"]
