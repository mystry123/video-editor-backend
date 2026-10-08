# Production image for the API (and, with a different command, the worker).
# Production currently runs on EC2 with pm2 (deploy/ecosystem.config.example.cjs);
# this image is for local stacks and any future container deploy.
#
#   docker build -t shotline-backend .
#   docker run --env-file .env -p 3000:3000 shotline-backend                    # API
#   docker run --env-file .env shotline-backend node dist/worker.js             # workers

FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

FROM node:20-bookworm-slim
WORKDIR /app
# ffmpeg/ffprobe for media probing and thumbnails.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/index.js"]
