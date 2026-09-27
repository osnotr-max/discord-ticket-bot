# Ticket Bot

Discord ticket bot built with Rust and Serenity.

## Deploy

The project can run on any provider that supports Rust or Docker.

### Native Rust provider

- Build command: `cargo build --release`
- Start command: `./target/release/ticket-bot`

### Docker provider

The included `Dockerfile` builds and starts the bot automatically.

## WispByte

1. Create a WispByte server with the **Rust** Docker image.
2. In **GitHub Integration**, configure the repository URL and branch, then
   use **Clone and Pull**.
3. In **Startup**, use this startup command:

   ```bash
   cargo run --release
   ```

4. In **Startup → Server Configuration**, add the required and optional
   environment variables listed below.
5. Start the server and check the Console for `starting gateway...`.

This bot uses Discord Gateway WebSocket connections, so no HTTP port or
`PORT` variable is required.

The repository limits Rust compilation to one job and disables release LTO to
keep CPU and RAM usage safe on small WispByte servers.

## Required environment variables

Configure these as Secrets/Environment Variables in the provider. Do not
commit a real `.env` file or a Discord token.

```env
DISCORD_TOKEN=your_discord_bot_token
GUILD_ID=your_discord_server_id
TICKET_CATEGORY_ID=your_ticket_category_id
LOG_CHANNEL_ID=your_audit_channel_id
```

## Optional environment variables

```env
STAFF_ROLE_ID=1538753673847644270
TRANSCRIPT_CHANNEL_ID=your_transcript_channel_id
MAX_TICKETS_PER_USER=3
COOLDOWN_CREATE_SECS=30
ACTION_COOLDOWN_SECS=3
MAX_TICKETS_PER_GUILD=50
MENTION_STAFF_ON_CREATE=true
MENTION_STAFF_ON_UNCLAIM=true
RUST_LOG=info
```

If `TRANSCRIPT_CHANNEL_ID` is omitted, transcripts use `LOG_CHANNEL_ID`.

`ACTION_COOLDOWN_SECS` limits repeated interactions per user and per action.
It defaults to 3 seconds. Interaction responses remain immediate; the bot
does not sleep before acknowledging Discord buttons or modals.

## Discord setup

In the Discord Developer Portal, enable these privileged intents for the bot:

- Server Members Intent
- Message Content Intent

Invite the bot to the server with the permissions required to manage ticket
channels, send messages, embed links, attach files, and manage messages.

After the provider starts the bot, use `/setup_panel` in the configured server
to create the ticket panel.