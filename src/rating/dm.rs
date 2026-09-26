use std::error::Error;

use serenity::builder::{
    CreateActionRow, CreateAttachment, CreateButton, CreateEmbed, CreateFooter, CreateInputText,
    CreateInteractionResponse, CreateInteractionResponseMessage, CreateMessage, CreateModal,
};
use serenity::model::interactions::modal::InputTextStyle;
use serenity::model::prelude::*;

use crate::state::{RatingInProgress, RatingPending, State, Ticket};
use crate::utils::{now_utc, truncate_embed_value};

const RATING_COLOR: u32 = 0xF0B429;
const RATING_LOG_COLOR: u32 = 0x9B59B6;
const FEEDBACK_MODAL_ID: &str = "rating_feedback";
const FEEDBACK_INPUT_ID: &str = "rating_feedback_text";

/// Send the rating DM (embed + 5 star buttons + transcript attachment) and
/// register the pending rating. Stored ONLY after the DM is delivered.
pub async fn send_rating_dm(
    ctx: &Context,
    user_id: UserId,
    ticket: &Ticket,
    html_bytes: &[u8],
    filename: &str,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let state = match State::get(ctx).await {
        Some(s) => s,
        None => return Err("state missing".into()),
    };
    let dm_channel = user_id.dm(&ctx.http).await?;

    let embed = CreateEmbed::new()
        .title("⭐ Rate support")
        .description("Tap a star to rate the support you received (1 = poor, 5 = excellent). After tapping, you may add optional feedback.")
        .field("Ticket", &ticket.id, true)
        .field("Type", &ticket.type_id, true)
        .colour(RATING_COLOR);
    let rows = build_rating_buttons();
    let attachment = CreateAttachment::bytes(html_bytes.to_vec(), filename);

    dm_channel
        .send_files(
            &ctx.http,
            vec![attachment],
            CreateMessage::new().embed(embed).components(rows),
        )
        .await?;

    state.ratings.insert(
        user_id,
        RatingPending {
            ticket_id: ticket.id.clone(),
            channel_id: ticket.channel_id,
            claimed_by: ticket.claimed_by,
            created_at: now_utc(),
        },
    );
    Ok(())
}

/// Handle a star click (rate_1..rate_5). Logs the score immediately (so a
/// cancelled feedback modal never loses the rating), then opens an optional
/// feedback modal when a pending rating existed.
pub async fn handle_rating_click(
    ctx: &Context,
    interaction: &Interaction,
    user_id: UserId,
    stars: u8,
) {
    let state = match State::get(ctx).await {
        Some(s) => s,
        None => {
            reply_ephemeral(ctx, interaction, "⭐ Thanks for your feedback!").await.ok();
            return;
        }
    };
    let pending = state.ratings.remove(&user_id).map(|(_, v)| v);

    // Log the score right away (best effort, background).
    let cfg = state.config.clone();
    let bg_ctx = ctx.clone();
    let score_log = build_rating_log(&cfg, user_id, stars, pending.as_ref());
    tokio::spawn(async move {
        if let Err(e) = send_embed_only(&bg_ctx, cfg.log_channel_id, score_log).await {
            tracing::error!("rating score log failed for {user_id}: {e}");
        }
    });

    match pending {
        Some(p) => {
            // Remember the chosen score until the feedback modal arrives.
            state.rating_in_progress.insert(
                user_id,
                RatingInProgress {
                    ticket_id: p.ticket_id,
                    channel_id: p.channel_id,
                    claimed_by: p.claimed_by,
                    stars,
                    created_at: now_utc(),
                },
            );
            let modal = build_feedback_modal();
            if let Err(e) = interaction
                .clone()
                .create_response(&ctx.http, CreateInteractionResponse::Modal(modal))
                .await
            {
                tracing::error!("feedback modal open failed for {user_id}: {e}");
            }
        }
        None => {
            // No pending link (expired): just thank, no modal.
            reply_ephemeral(
                ctx,
                interaction,
                &format!("⭐ Thank you! Rating {stars}/5 recorded."),
            )
            .await
            .ok();
        }
    }
}

/// Handle the optional feedback modal submit. Logs score + feedback text.
pub async fn handle_rating_feedback(
    ctx: &Context,
    interaction: &Interaction,
    user_id: UserId,
    feedback: &str,
) {
    let state = match State::get(ctx).await {
        Some(s) => s,
        None => {
            reply_ephemeral(ctx, interaction, "⭐ Thanks!").await.ok();
            return;
        }
    };
    let prog = state.rating_in_progress.remove(&user_id).map(|(_, v)| v);

    match prog {
        Some(pr) => {
            let cfg = state.config.clone();
            let bg_ctx = ctx.clone();
            let fb = feedback.trim().to_string();
            let log = build_feedback_log(&cfg, user_id, &pr, &fb);
            tokio::spawn(async move {
                if let Err(e) = send_embed_only(&bg_ctx, cfg.log_channel_id, log).await {
                    tracing::error!("rating feedback log failed for {user_id}: {e}");
                }
            });
            reply_ephemeral(
                ctx,
                interaction,
                &format!("⭐ Thank you! Rating {}/5 and your feedback were recorded.", pr.stars),
            )
            .await
            .ok();
        }
        None => {
            reply_ephemeral(ctx, interaction, "⭐ Thanks!").await.ok();
        }
    }
}

/// The custom_id of the feedback modal input, used by the dispatcher to
/// extract the text without depending on positional ordering.
pub fn feedback_input_id() -> &'static str {
    FEEDBACK_INPUT_ID
}

fn build_feedback_modal() -> CreateModal {
    let input = CreateInputText::new(
        InputTextStyle::Paragraph,
        "Tell us more (optional)",
        FEEDBACK_INPUT_ID,
    )
    .required(false)
    .max_length(1000);
    CreateModal::new(FEEDBACK_MODAL_ID, "⭐ Optional feedback")
        .add_component(CreateActionRow::TextInputs(vec![input]))
}

fn build_rating_buttons() -> Vec<CreateActionRow> {
    let labels = ["⭐", "⭐⭐", "⭐⭐⭐", "⭐⭐⭐⭐", "⭐⭐⭐⭐⭐"];
    let buttons: Vec<CreateButton> = (1..=5u8)
        .map(|n| {
            CreateButton::new(format!("rate_{n}"))
                .label(labels[(n - 1) as usize])
                .style(ButtonStyle::Secondary)
        })
        .collect();
    vec![CreateActionRow::Buttons(buttons)]
}

fn build_rating_log(
    cfg: &crate::config::Config,
    user_id: UserId,
    stars: u8,
    pending: Option<&RatingPending>,
) -> CreateEmbed {
    let mut embed = CreateEmbed::new()
        .title("⭐ Rating received")
        .colour(RATING_LOG_COLOR)
        .field("User", format!("<@{user_id}>"), true)
        .field("Rating", format!("{stars}/5"), true);
    match pending {
        Some(p) => {
            embed = embed
                .field("Ticket", &p.ticket_id, true)
                .field("Channel", format!("<#{}>", p.channel_id), true)
                .field(
                    "Handled by",
                    p.claimed_by
                        .map(|u| format!("<@{u}>"))
                        .unwrap_or_else(|| "no claim".to_string()),
                    true,
                );
        }
        None => {
            embed = embed.field(
                "Origin",
                "expired pending or no link (score still recorded)",
                false,
            );
        }
    }
    embed = embed.footer(CreateFooter::new(format!("guild {}", cfg.guild_id)));
    embed
}

fn build_feedback_log(
    cfg: &crate::config::Config,
    user_id: UserId,
    prog: &RatingInProgress,
    feedback: &str,
) -> CreateEmbed {
    let shown = if feedback.is_empty() { "—" } else { feedback };
    CreateEmbed::new()
        .title("⭐ Feedback received")
        .colour(RATING_LOG_COLOR)
        .field("User", format!("<@{user_id}>"), true)
        .field("Rating", format!("{}/5", prog.stars), true)
        .field("Ticket", &prog.ticket_id, true)
        .field("Channel", format!("<#{}>", prog.channel_id), true)
        .field(
            "Handled by",
            prog.claimed_by
                .map(|u| format!("<@{u}>"))
                .unwrap_or_else(|| "no claim".to_string()),
            true,
        )
        .field("Feedback", truncate_embed_value(shown), false)
        .footer(CreateFooter::new(format!("guild {}", cfg.guild_id)))
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
