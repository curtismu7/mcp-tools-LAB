FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build -w web

FROM node:26-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=4810 DATA_DIR=/data
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --ignore-scripts -w server && mkdir /data && chown node:node /data && chmod 700 /data
COPY server/src server/src
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 4810
# Inside the container the server must listen on all interfaces; publish the port on loopback only
# (docker run -p 127.0.0.1:4810:4810 ...). The Host check still accepts only loopback names.
ENV MCPTOOLS_BIND=0.0.0.0
HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:4810/api/health').then(r=>r.json()).then(j=>process.exit(j.state==='broken'?1:0)).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
