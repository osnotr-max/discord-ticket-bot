use std::sync::atomic::Ordering;

use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serenity::builder::{CreateEmbed, CreateFooter, CreateMessage};
use serenity::model::prelude::*;

use crate::state::State;
use crate::tickets::claim::{post_unclaim_notice, unclaim};
use crate::tickets::close::close_ticket_auto;
use crate::utils::{now_utc, staff_mention};

const TICK_SECS: u64 = 60;
const UNCLAIM_HOURS: i64 = 6;
const CLOSE_HOURS: i64 = 24;
const REMINDER_HOURS: i64 = 10;
const RATING_TTL_HOURS: i64 = 48;
const RATING_IN_PROGRESS_TTL_MIN: i64 = 30;
const REMINDER_COLOR: u32 = 0xF0B429;

/// Spawn the maintenance task exactly once per process (idempotent).
pub fn spawn_if_needed(ctx: Context, state: State) {
    if !state
        .timeout_started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        return;
    }
    tokio::spawn(async move {
        run(ctx, state).await;
    });
}

async fn run(ctx: Context, state: State) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(TICK_SECS));
    loop {
        interval.tick().await;
        let now = now_utc();

        // Light snapshot: channel, claimed_by, last_activity, reminder_sent, owner.
        let snapshot: Vec<(ChannelId, Option<UserId>, DateTime<Utc>, bool, UserId)> = state
            .tickets
            .iter()
            .map(|e| {
                (
                    *e.key(),
                    e.value().claimed_by,
                    e.value().last_activity,
                    e.value().reminder_sent,
                    e.value().owner_id,
                )
            })
            .collect();

        for (channel_id, claimed_by, last_activity, reminder_sent, owner_id) in snapshot {
            let idle = now.signed_duration_since(last_activity);

            // Rule B (24h): close, takes precedence.
            if idle >= ChronoDuration::hours(CLOSE_HOURS) {
                if let Some(ticket) = state.tickets.get(&channel_id).map(|r| r.clone()) {
                    if let Err(e) = close_ticket_auto(&ctx, &state, ticket, now).await {
                        tracing::error!("auto-close failed for {channel_id}: {e}");
                    }
                }
                continue;
            }

            // Rule A (6h): unclaim a claimed-but-idle ticket, then skip reminder
            // this tick (unclaim resets last_activity, so the cycle restarts).
            if claimed_by.is_some() && idle >= ChronoDuration::hours(UNCLAIM_HOURS) {
                if unclaim(&state, channel_id, now) {
                    let ping = if state.config.mention_staff_on_unclaim {
                        Some(staff_mention(&state.config))
                    } else {
                        None
                    };
                    if let Err(e) = post_unclaim_notice(&ctx, channel_id, ping).await {
                        tracing::error!("unclaim notice failed for {channel_id}: {e}");
                    }
                }
                continue;
            }

            // New rule (10h): one DM reminder to the owner for an open ticket
            // with no activity. Marked before sending to avoid re-firing each
            // tick; does NOT reset last_activity (so 24h close still applies).
            if idle >= ChronoDuration::hours(REMINDER_HOURS) && !reminder_sent {
                let marked = if let Some(mut t) = state.tickets.get_mut(&channel_id) {
                    t.reminder_sent = true;
                    true
                } else {
                    false
                };
                if marked {
                    if let Err(e) = send_open_reminder(&ctx, &state, owner_id, channel_id).await {
                        tracing::error!("open-ticket reminder DM failed for {channel_id}: {e}");
                    }
                }
            }
        }

        prune_old_ratings(&state, now);
        prune_old_rating_in_progress(&state, now);
        prune_action_cooldowns(&state, now);
    }
}

/// DM the owner reminding that the ticket is still open after 10h idle.
async fn send_open_reminder(
    ctx: &Context,
    state: &State,
    owner_id: UserId,
    channel_id: ChannelId,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let embed = CreateEmbed::new()
        .title("⏰ Ticket reminder")
        .description(format!(
            "Hi <@{owner_id}>, your ticket in <#{channel_id}> has been open without activity for a while. \
             If you still need help, send a message there or ping staff. If it is resolved, you can close \
             it with the Close button."
        ))
        .colour(REMINDER_COLOR)
        .footer(CreateFooter::new(format!("guild {}", state.config.guild_id)));

    let dm = owner_id.dm(&ctx.http).await?;
    dm.send_message(&ctx.http, CreateMessage::new().embed(embed))
        .await?;
    Ok(())
}

/// Drop rating pendings older than 48h.
fn prune_old_ratings(state: &State, now: DateTime<Utc>) {
    let stale: Vec<UserId> = state
        .ratings
        .iter()
        .filter(|e| {
            now.signed_duration_since(e.value().created_at)
                >= ChronoDuration::hours(RATING_TTL_HOURS)
        })
        .map(|e| *e.key())
        .collect();
    for uid in stale {
        state.ratings.remove(&uid);
    }
}

/// Drop in-progress ratings (star clicked, feedback modal not submitted)
/// older than 30 min, so an abandoned modal does not leak memory.
fn prune_old_rating_in_progress(state: &State, now: DateTime<Utc>) {
    let stale: Vec<UserId> = state
        .rating_in_progress
        .iter()
        .filter(|e| {
            now.signed_duration_since(e.value().created_at)
                >= ChronoDuration::minutes(RATING_IN_PROGRESS_TTL_MIN)
        })
        .map(|e| *e.key())
        .collect();
    for uid in stale {
        state.rating_in_progress.remove(&uid);
    }
}

fn prune_action_cooldowns(state: &State, now: DateTime<Utc>) {
    let ttl_secs = state.config.action_cooldown_secs.max(60);
    let ttl = ChronoDuration::seconds(ttl_secs);
    let stale: Vec<(UserId, String)> = state
        .action_cooldowns
        .iter()
        .filter(|entry| now.signed_duration_since(*entry.value()) >= ttl)
        .map(|entry| entry.key().clone())
        .collect();
    for key in stale {
        state.action_cooldowns.remove(&key);
    }
}
