# Honeylua Support

Honeylua' Discord support service is built in **TypeScript running on Bun**. It uses Bun's
native `fetch` and `WebSocket` implementations instead of `discord.js`, so the
production process has no npm dependencies, no message cache and no worker
thread pool.

## Why Bun

For a 512 MB server with a weak CPU, this implementation avoids the largest
avoidable cost in a Discord bot: a full client framework and its object cache.
Only the Discord Gateway intents required by this bot are enabled:

- `GUILDS`
- `GUILD_MESSAGES`
- `DIRECT_MESSAGES`
- `MESSAGE_CONTENT`

The bot keeps ticket state in bounded in-memory maps, prunes cooldowns and
expired ratings, uses one event loop, and builds a minified single-file
executable script for deployment.

## Run

```bash
cp .env.example .env
# fill .env with the Discord values
bun --smol run src/index.ts
```

For a production build:

```bash
bun run build
bun --smol /path/to/dist/honeylua.js
```

No HTTP port or `PORT` variable is needed. The bot connects through Discord's
Gateway WebSocket.

## WispByte

Use the Bun runtime and the startup command:

```bash
bun --smol run src/index.ts
```

Or build once and start the smaller bundled file:

```bash
bun build src/index.ts --target bun --minify --outfile dist/honeylua.js
bun --smol dist/honeylua.js
```

Configure the environment variables in the provider. Never commit a real
`.env` file or a Discord token.

`MAX_TRANSCRIPT_PAGES` defaults to 50 and is capped at 50 to keep transcript
closures bounded on a small server. Lower it if tickets can contain a very
large history.

## Required environment variables

```env
DISCORD_TOKEN=your_discord_bot_token
GUILD_ID=your_discord_server_id
TICKET_CATEGORY_ID=your_ticket_category_id
LOG_CHANNEL_ID=your_audit_channel_id
```

`TRANSCRIPT_CHANNEL_ID` falls back to `LOG_CHANNEL_ID`.

## Report channel security

Report channels use Discord permission overwrites, not only checks inside the
application:

- **Staff Report:** visible to roles `1525161651987284249`,
  `1531344415396991028`, and `1539430404220518410`.
- **User Report:** visible to Moderator+ role `1525161655053320385`.
- The report creator and Discord administrators retain access.
- Once claimed, only the creator, the responsible staff member, and
  administrators retain access. The `Release Ticket` action restores the
  appropriate role access.

The bot stores a compact metadata marker in each new ticket channel topic and
hydrates open ticket channels after a restart. Existing channels without that
marker are recovered from their channel name and member permission overwrites.

The bot needs the Server Members intent only if another feature outside this
repository requires it; this implementation does not request it. Enable
**Message Content Intent** in the Discord Developer Portal.

After startup, an administrator can use `/setup_panel` in the configured
server.