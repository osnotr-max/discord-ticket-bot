use serenity::model::prelude::*;
use serenity::prelude::*;

use crate::state::State;

pub mod interaction;
pub mod message;
pub mod ready;

/// Single point of EventHandler implementation. Carries the State clone
/// (cheap: only Arcs) and injects it into the TypeMap on ready.
#[derive(Clone)]
pub struct Framework {
    pub state: State,
}

#[async_trait::async_trait]
impl EventHandler for Framework {
    async fn ready(&self, ctx: Context, ready: ReadyEvent) {
        ready::handle_ready(ctx, ready, self.state.clone()).await;
    }
    async fn message(&self, ctx: Context, event: MessageCreateEvent) {
        message::handle_message(ctx, event).await;
    }
    async fn interaction_create(&self, ctx: Context, event: InteractionCreateEvent) {
        interaction::handle_interaction(ctx, event).await;
    }
}
