FROM oven/bun:1.3-alpine

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src

# The runtime has no third-party dependency to install.
RUN bun build src/index.ts --target bun --minify --outfile /usr/local/bin/ticket-bot.js

ENV NODE_ENV=production
CMD ["bun", "/usr/local/bin/ticket-bot.js"]