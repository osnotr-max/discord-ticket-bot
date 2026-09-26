mod commands;
mod config;
mod events;
mod rating;
mod state;
mod tickets;
mod transcript;
mod utils;

use std::sync::Arc;

use serenity::cache::CacheSettings;
use serenity::model::prelude::*;
use serenity::prelude::*;

use crate::config::Config;
use crate::events::Framework;
use crate::state::State;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let cfg = match Config::from_env() {
        Ok(c) => Arc::new(c),
        Err(e) => {
            tracing::error!("invalid configuration: {e}");
            eprintln!("invalid configuration: {e}");
            std::process::exit(1);
        }
    };

    let state = State::new((*cfg).clone());

    let intents = GatewayIntents::GUILDS
        | GatewayIntents::GUILD_MEMBERS
        | GatewayIntents::GUILD_MESSAGES
        | GatewayIntents::DIRECT_MESSAGES
        | GatewayIntents::MESSAGE_CONTENT;

    let mut cache_settings = CacheSettings::default();
    cache_settings.max_messages = 100;
    cache_settings.guild_subscriptions = false;

    let client = match ClientBuilder::new(cfg.token.clone(), intents)
        .event_handler(Framework { state })
        .cache_settings(cache_settings)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("failed to build client: {e}");
            eprintln!("failed to build client: {e}");
            std::process::exit(1);
        }
    };

    tracing::info!("starting gateway...");
    if let Err(e) = client.start().await {
        tracing::error!("fatal client error: {e}");
        eprintln!("fatal client error: {e}");
        std::process::exit(1);
    }
}
