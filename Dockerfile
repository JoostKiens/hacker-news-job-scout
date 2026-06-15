FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# /data is where Railway mounts the persistent volume for seen_ids.json
VOLUME ["/data"]

CMD ["node", "dist/index.js"]
