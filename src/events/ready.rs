use serenity::builder::CreateCommand;
use serenity::model::prelude::*;

use crate::state::State;
use crate::tickets::timeouts;

/// On ready: inject State into TypeMap FIRST, register /setup_panel in the
/// configured guild, then spawn the timeouts task exactly once.
pub async fn handle_ready(ctx: Context, ready: ReadyEvent, state: State) {
    let cfg = state.config.clone();

    {
        let mut data = ctx.data.write().await;
        data.insert::<State>(state.clone());
    }

    let bot_tag = ready.user.username.clone();
    tracing::info!("ready: connected as {bot_tag}");

    let setup = CreateCommand::new("setup_panel")
        .description("Send the ticket panel (administrators only)");

    if let Err(e) = cfg.guild_id.create_command(&ctx.http, setup).await {
        tracing::error!("failed to register /setup_panel: {e}");
    }

    timeouts::spawn_if_needed(ctx.clone(), state);
}
