FROM oven/bun:1.3-alpine

WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src

# The runtime has no third-party dependency to install. Delete the source
# after bundling so the deployment image contains only the executable bundle.
RUN bun build src/index.ts --target bun --minify --outfile /usr/local/bin/osvaldo-systems.js \
    && rm -rf /app/src /app/package.json /app/tsconfig.json

ENV NODE_ENV=production
CMD ["bun", "--smol", "/usr/local/bin/osvaldo-systems.js"]