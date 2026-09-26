use std::collections::HashSet;
use std::error::Error;

use chrono::{DateTime, Utc};
use serenity::builder::{
    CreateAttachment, CreateEmbed, CreateFooter, CreateInteractionResponse,
    CreateInteractionResponseMessage, CreateMessage, HttpBuilder,
};
use serenity::model::prelude::*;

use crate::state::{State, Ticket};
use crate::transcript::build_transcription;
use crate::utils::now_utc;

const PAGE_SLEEP_MS: u64 = 800;
const MAX_PAGES: usize = 50;
const COUNTDOWN_SECS: u64 = 10;
const TRANSCRIPT_COLOR: u32 = 0x5865F2;
const CLOSE_LOG_COLOR: u32 = 0xED4245;
const COUNTDOWN_COLOR: u32 = 0x95A5A6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CloseReason {
    Manual,
    Auto,
}
impl CloseReason {
    pub fn label(self) -> &'static str {
        match self {
            CloseReason::Manual => "manual",
            CloseReason::Auto => "automatic (24h timeout)",
        }
    }
}

/// Manual close entry (button). Caller already authorized staff/owner.
pub async fn close_ticket_manual(
    ctx: &Context,
    interaction: &Interaction,
    channel_id: ChannelId,
    closer_id: UserId,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    reply_ephemeral(ctx, interaction, "🔒 Closing...").await.ok();
    let state = match State::get(ctx).await {
        Some(s) => s,
        None => return Ok(()),
    };
    let ticket = match state.tickets.get(&channel_id) {
        Some(r) => r.clone(),
        None => return Ok(()),
    };
    perform_close(ctx, &state, ticket, CloseReason::Manual, Some(closer_id), now_utc()).await
}

/// Automatic close entry (24h timeout task).
pub async fn close_ticket_auto(
    ctx: &Context,
    state: &State,
    ticket: Ticket,
    now: DateTime<Utc>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    perform_close(ctx, state, ticket, CloseReason::Auto, None, now).await
}

async fn perform_close(
    ctx: &Context,
    state: &State,
    ticket: Ticket,
    reason: CloseReason,
    closed_by: Option<UserId>,
    closed_at: DateTime<Utc>,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    if state.tickets.remove(&ticket.channel_id).is_none() {
        return Ok(());
    }

    let messages = collect_messages(ctx, ticket.channel_id).await;
    let html = build_transcription(&ticket, &messages, reason.label(), closed_by, closed_at);
    let filename = format!("transcript-{}.html", ticket.id);

    let dest = state.config.transcript_channel_id;
    let summary = build_transcript_summary(&ticket, &messages, reason, closed_by, closed_at);
    if let Err(e) = send_transcript(ctx, dest, &html, &filename, summary).await {
        tracing::error!("transcript send failed for {}: {e}", ticket.id);
    }

    if let Err(e) =
        crate::rating::dm::send_rating_dm(ctx, ticket.owner_id, &ticket, html.as_bytes(), &filename)
            .await
    {
        tracing::error!("rating DM failed for {}: {e}", ticket.id);
    }

    let close_log =
        build_close_log(&ticket, reason, closed_by, &messages.len().to_string(), closed_at);
    if let Err(e) = send_embed_only(ctx, state.config.log_channel_id, close_log).await {
        tracing::error!("close log failed for {}: {e}", ticket.id);
    }

    let countdown = CreateEmbed::new()
        .title("🗑️ Deleting")
        .description(format!(
            "This channel will be deleted in {COUNTDOWN_SECS}s. The transcript is already saved."
        ))
        .colour(COUNTDOWN_COLOR);
    if let Err(e) = send_embed_only(ctx, ticket.channel_id, countdown).await {
        tracing::error!("countdown failed in {}: {e}", ticket.channel_id);
    }

    tokio::time::sleep(std::time::Duration::from_secs(COUNTDOWN_SECS)).await;

    if let Err(e) = ticket
        .channel_id
        .delete(&ctx.http, Some("ticket closed"))
        .await
    {
        tracing::error!("delete channel failed for {}: {e}", ticket.channel_id);
    }
    Ok(())
}

async fn collect_messages(ctx: &Context, channel_id: ChannelId) -> Vec<Message> {
    let mut seen: HashSet<MessageId> = HashSet::new();
    let mut out: Vec<Message> = Vec::new();
    let mut before: Option<u64> = None;

    for _page in 0..MAX_PAGES {
        let page_result = match before {
            Some(b) => channel_id
                .messages(&ctx.http, |hb: HttpBuilder| {
                    hb.limit(100).before(MessageId::from(b))
                })
                .await,
            None => channel_id.messages(&ctx.http, |hb: HttpBuilder| hb.limit(100)).await,
        };
        let page = match page_result {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("pagination failed in {channel_id}: {e}");
                break;
            }
        };
        if page.is_empty() {
            break;
        }
        let mut min_in_page = u64::MAX;
        for m in &page {
            let idv = m.id.get();
            if idv < min_in_page {
                min_in_page = idv;
            }
            if seen.insert(m.id) {
                out.push(m.clone());
            }
        }
        if page.len() < 100 {
            break;
        }
        before = Some(min_in_page);
        tokio::time::sleep(std::time::Duration::from_millis(PAGE_SLEEP_MS)).await;
    }
    out.sort_by_key(|m| m.id.get());
    out
}

async fn send_transcript(
    ctx: &Context,
    channel_id: ChannelId,
    html: &str,
    filename: &str,
    summary: CreateEmbed,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let attachment = CreateAttachment::bytes(html.as_bytes().to_vec(), filename);
    channel_id
        .send_files(
            &ctx.http,
            vec![attachment],
            CreateMessage::new().embed(summary),
        )
        .await?;
    Ok(())
}

fn build_transcript_summary(
    ticket: &Ticket,
    messages: &[Message],
    reason: CloseReason,
    closed_by: Option<UserId>,
    closed_at: DateTime<Utc>,
) -> CreateEmbed {
    let duration =
        crate::utils::format_duration(closed_at.signed_duration_since(ticket.created_at));
    let claimed = ticket
        .claimed_by
        .map(|u| u.to_string())
        .unwrap_or_else(|| "—".to_string());
    let closer = closed_by
        .map(|u| u.to_string())
        .unwrap_or_else(|| "system".to_string());
    CreateEmbed::new()
        .title("📄 Transcript")
        .colour(TRANSCRIPT_COLOR)
        .field("Ticket", &ticket.id, true)
        .field("Type", &ticket.type_id, true)
        .field(
            "Owner",
            format!("{} ({})", ticket.owner_name, ticket.owner_id),
            true,
        )
        .field("Claimed by", claimed, true)
        .field("Closed by", closer, true)
        .field("Reason", reason.label(), true)
        .field("Messages", messages.len().to_string(), true)
        .field("Duration", duration, true)
        .footer(CreateFooter::new(format!(
            "created {}",
            ticket.created_at.format("%d/%m/%Y %H:%M UTC")
        )))
}

fn build_close_log(
    ticket: &Ticket,
    reason: CloseReason,
    closed_by: Option<UserId>,
    msg_count: &str,
    closed_at: DateTime<Utc>,
) -> CreateEmbed {
    let closer = closed_by
        .map(|u| format!("<@{u}>"))
        .unwrap_or_else(|| "system (timeout)".to_string());
    CreateEmbed::new()
        .title(match reason {
            CloseReason::Manual => "🔴 Closed (manual)",
            CloseReason::Auto => "🔴 Closed (automatic)",
        })
        .colour(CLOSE_LOG_COLOR)
        .field("Ticket", &ticket.id, true)
        .field("Type", &ticket.type_id, true)
        .field(
            "Owner",
            format!("{} (<@{}>)", ticket.owner_name, ticket.owner_id),
            true,
        )
        .field("Closed by", closer, true)
        .field("Messages", msg_count, true)
        .field(
            "Closed at",
            closed_at.format("%d/%m/%Y %H:%M:%S UTC").to_string(),
            true,
        )
}

async fn send_embed_only(
    ctx: &Context,
    channel_id: ChannelId,
    embed: CreateEmbed,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    channel_id
        .send_message(&ctx.http, CreateMessage::new().embed(embed))
        .await?;
    Ok(())
}

async fn reply_ephemeral(
    ctx: &Context,
    interaction: &Interaction,
    text: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    interaction
        .clone()
        .create_response(
            &ctx.http,
            CreateInteractionResponse::Message(
                CreateInteractionResponseMessage::new()
                    .content(text)
                    .ephemeral(true),
            ),
        )
        .await?;
    Ok(())
}
