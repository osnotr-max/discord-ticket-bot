use chrono::{DateTime, Utc};
use serenity::builder::{CreateEmbed, CreateMessage};
use serenity::model::prelude::*;

use crate::state::State;
use crate::utils::now_utc;

const CLAIM_COLOR: u32 = 0xF0B429;
const UNCLAIM_COLOR: u32 = 0xED4245;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimResult {
    Claimed,
    Already(UserId),
    NotFound,
}

/// In-memory staff-role check from the payload's role list. Never trust client.
pub fn has_staff_role(roles: &[RoleId], staff: RoleId) -> bool {
    roles.iter().any(|r| *r == staff)
}

/// Mutate state only (no HTTP). Any activity-driven mutation also clears
/// reminder_sent so a future 10h inactivity can fire the DM reminder again.
pub fn apply_claim(
    state: &State,
    channel_id: ChannelId,
    staff_id: UserId,
    now: DateTime<Utc>,
) -> ClaimResult {
    let mut ticket = match state.tickets.get_mut(&channel_id) {
        Some(t) => t,
        None => return ClaimResult::NotFound,
    };
    if let Some(prev) = ticket.claimed_by {
        ticket.last_activity = now;
        ticket.reminder_sent = false;
        return ClaimResult::Already(prev);
    }
    ticket.claimed_by = Some(staff_id);
    ticket.claimed_at = Some(now);
    ticket.last_activity = now;
    ticket.reminder_sent = false;
    ClaimResult::Claimed
}

pub fn unclaim(state: &State, channel_id: ChannelId, now: DateTime<Utc>) -> bool {
    if let Some(mut ticket) = state.tickets.get_mut(&channel_id) {
        if ticket.claimed_by.is_some() {
            ticket.claimed_by = None;
            ticket.claimed_at = None;
            ticket.last_activity = now;
            ticket.reminder_sent = false;
            return true;
        }
    }
    false
}

pub fn touch_activity(state: &State, channel_id: ChannelId, now: DateTime<Utc>) -> bool {
    if let Some(mut ticket) = state.tickets.get_mut(&channel_id) {
        ticket.last_activity = now;
        ticket.reminder_sent = false;
        return true;
    }
    false
}

pub async fn post_claim_notice(
    ctx: &Context,
    channel_id: ChannelId,
    staff_id: UserId,
    auto: bool,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let suffix = if auto { " (auto-claim)" } else { "" };
    let embed = CreateEmbed::new()
        .title("🔒 Ticket claimed")
        .description(format!("<@{staff_id}> claimed this ticket{suffix}."))
        .colour(CLAIM_COLOR);
    channel_id
        .send_message(&ctx.http, CreateMessage::new().embed(embed))
        .await?;
    Ok(())
}

/// staff_ping must come ONLY from utils::staff_mention(cfg) when enabled.
pub async fn post_unclaim_notice(
    ctx: &Context,
    channel_id: ChannelId,
    staff_ping: Option<String>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let embed = CreateEmbed::new()
        .title("⚠️ Claim removed")
        .description("Removed due to inactivity (6h).")
        .colour(UNCLAIM_COLOR);
    let mut msg = CreateMessage::new().embed(embed);
    if let Some(ping) = staff_ping {
        if !ping.is_empty() {
            msg = msg.content(ping);
        }
    }
    channel_id.send_message(&ctx.http, msg).await?;
    Ok(())
}

pub fn claim_now() -> DateTime<Utc> {
    now_utc()
}
