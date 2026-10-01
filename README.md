## Transcript 2.2.0

- Message author names are always rendered visibly, with optional @username.
- Member role badges are removed from normal messages; role names remain rendered when a role is actually mentioned.
- Ticket members can send images/attachments and use embedded links.
- Temporary claim/release/closing bot notices are excluded from saved transcripts.
- Mobile transcript layout is more compact and readable.

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
large history. `TRANSCRIPT_PAGE_DELAY_MS` defaults to 250ms to keep pagination
fast without hammering the Discord API. `DISCORD_REQUEST_TIMEOUT_MS` defaults
to 15s so a stalled Discord request cannot block the bot indefinitely.

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

Ticket channel topics are human-readable and show the ticket type and current
claim status. Open tickets are hydrated after a restart from their channel name
and permission overwrites, while legacy metadata topics are automatically cleaned
up when the bot reconnects.

The bot needs the Server Members intent only if another feature outside this
repository requires it; this implementation does not request it. Enable
**Message Content Intent** in the Discord Developer Portal.

After startup, an administrator can use `/setup_panel` in the configured
server.

### Transcript media

Transcripts are audit-focused: they preserve text, stickers, mentions, reactions,
replies and attachment metadata, but they do not download or embed uploaded
images, videos, audio or files. This keeps memory, disk and transcript size under
control while preserving the conversation record.

### Ticket management

The bot provides the following slash commands:

- `/setup_panel` — publish the support panel.
- `/close` — close the current ticket with a required reason.
- `/close-request` — request ticket closure.
- `/context` — show bot/runtime status.
- `/add-user` — give another server member access to the current ticket.
- `/remove-user` — remove an added member from the current ticket.
- `/create-ticket` — create an administrator-defined custom ticket with a custom
  name, description, owner and staff role IDs.

### Close reason
Closing a ticket opens a required reason modal. The exact reason is stored in the transcript and close log.


## v2.6.1
- Close requests now keep an audit history in the request message.
- Close request messages include a Close Ticket action and an integrated Rate Support button.
- Owners can open the rating flow directly from the ticket.
- Ratings remain available as a DM fallback when the ticket is closed.


## v2.7.0 Security & Performance Hardening

- Production builds are minified with Bun and do not emit source maps.
- Discord request retries are method-aware to avoid replaying non-idempotent POST operations after network or server failures.
- 429 responses remain retryable with Discord's retry timing.
- Runtime member, action-cooldown, and create-cooldown caches are explicitly bounded.
- Discord IDs are validated as Snowflakes during configuration loading.
- Token configuration rejects newline-containing values to reduce accidental header injection.
- Close-request history is capped to a small fixed window.
- The source remains TypeScript for maintainability; the production artifact is the minimized `dist/honeylua.js`.

## Support Lock
- Supported durations: `30m`, `4h`, `2h30m`, `1d` (1 minute minimum, 30 days maximum).
- `/support-unlock` re-enables support immediately.
- Existing tickets are unaffected.
- No `/support-status` command is included.

- `/staff-ranking` shows the top staff members by resolved tickets. Counts are stored in a tiny `staff-ranking.json` file.
