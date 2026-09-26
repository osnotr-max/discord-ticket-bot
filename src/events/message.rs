use serenity::model::prelude::*;

use crate::state::State;
use crate::tickets::claim::{
    apply_claim, has_staff_role, post_claim_notice, touch_activity, ClaimResult,
};
use crate::utils::now_utc;

/// MessageCreate handler: guild whitelist, ignore bots, update last_activity
/// on any human message in a ticket, and AUTO-CLAIM when a staff member
/// (verified in-memory from member.roles) posts in an unclaimed ticket.
pub async fn handle_message(ctx: Context, event: MessageCreateEvent) {
    let msg = &event.message;
    if msg.author.bot {
        return;
    }
    let guild_id = match msg.guild_id {
        Some(g) => g,
        None => return,
    };

    let state = match State::get(&ctx).await {
        Some(s) => s,
        None => {
            tracing::error!("state missing in handle_message");
            return;
        }
    };
    let cfg = state.config.clone();
    if guild_id != cfg.guild_id {
        return;
    }

    let channel_id = msg.channel_id;
    if !state.tickets.contains_key(&channel_id) {
        return;
    }

    let now = now_utc();
    touch_activity(&state, channel_id, now);

    let author_is_staff = match msg.member.as_ref() {
        Some(m) => has_staff_role(&m.roles, cfg.staff_role_id),
        None => false,
    };
    if !author_is_staff {
        return;
    }

    match apply_claim(&state, channel_id, msg.author.id, now) {
        ClaimResult::Claimed => {
            if let Err(e) = post_claim_notice(&ctx, channel_id, msg.author.id, true).await {
                tracing::error!("auto-claim notice failed: {e}");
            }
        }
        _ => {}
    }
}
