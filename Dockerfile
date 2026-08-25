FROM node:slim AS base
RUN npm i -g corepack
RUN corepack enable
WORKDIR /home/container

FROM base AS ts-compiler

COPY . .
RUN pnpm install --ignore-scripts
RUN pnpm run build

FROM base AS ts-remover

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*
WORKDIR /home/container

COPY --from=ts-compiler /home/container/package.json ./
COPY --from=ts-compiler /home/container/dist ./

COPY docker-init.sh /docker-init.sh
RUN chmod +x /docker-init.sh && pnpm install --production && pnpm cache clean

CMD ["/docker-init.sh"]
