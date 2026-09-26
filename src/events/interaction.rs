use serenity::builder::{CreateInteractionResponse, CreateInteractionResponseMessage};
use serenity::model::prelude::*;

use crate::commands::setup_panel;
use crate::state::State;
use crate::tickets::{claim, close, create, form, types};

/// Central dispatcher for ALL interactions (slash, buttons, modals).
/// Guild whitelist applied; routes by custom_id; extracts modal answers as
/// (custom_id, value) pairs; delegates to specialized modules.
pub async fn handle_interaction(ctx: Context, event: InteractionCreateEvent) {
    let interaction = event.interaction;

    let state = match State::get(&ctx).await {
        Some(s) => s,
        None => {
            tracing::error!("state missing in handle_interaction");
            return;
        }
    };
    let cfg = state.config.clone();

    if interaction.guild_id != Some(cfg.guild_id) {
        reply_ephemeral(
            &ctx,
            &interaction,
            "❌ This bot only operates in the configured server.",
        )
        .await
        .ok();
        return;
    }

    match &interaction.data {
        InteractionData::ApplicationCommand(data) => {
            if data.name == "setup_panel" {
                handle_setup_panel(&ctx, &state, &interaction).await;
            }
        }
        InteractionData::MessageComponent(data) => {
            route_component(&ctx, &state, &interaction, &data.custom_id).await;
        }
        InteractionData::ModalSubmit(data) => {
            if data.custom_id == "rating_feedback" {
                handle_rating_feedback_modal(&ctx, &interaction, data).await;
            } else if let Some(type_id) = data.custom_id.strip_prefix("ticket_form_") {
                handle_modal_submit(&ctx, &interaction, type_id, data).await;
            }
        }
        _ => {}
    }
}

async fn route_component(
    ctx: &Context,
    state: &State,
    interaction: &Interaction,
    custom_id: &str,
) {
    if let Some(type_id) = custom_id.strip_prefix("ticket_open_") {
        handle_open_modal(ctx, interaction, type_id).await;
        return;
    }
    match custom_id {
        "ticket_claim" => handle_claim(ctx, state, interaction).await,
        "ticket_close" => handle_close(ctx, state, interaction).await,
        c => {
            if let Some(rest) = c.strip_prefix("rate_") {
                if let Ok(stars) = rest.parse::<u8>() {
                    if (1..=5).contains(&stars) {
                        let user_id = author_id(interaction);
                        crate::rating::dm::handle_rating_click(ctx, interaction, user_id, stars)
                            .await;
                    }
                }
            }
        }
    }
}

async fn handle_setup_panel(ctx: &Context, _state: &State, interaction: &Interaction) {
    if !is_administrator(ctx, interaction).await {
        reply_ephemeral(
            ctx,
            interaction,
            "❌ Only administrators can use this command.",
        )
        .await
        .ok();
        return;
    }
    if let Err(e) = setup_panel::send_panel(ctx, interaction).await {
        tracing::error!("panel send failed: {e}");
    }
}

async fn handle_open_modal(ctx: &Context, interaction: &Interaction, type_id: &str) {
    let tt = match types::find_type(type_id) {
        Some(t) => t,
        None => return,
    };
    let modal = form::build_modal(tt);
    if let Err(e) = interaction
        .clone()
        .create_response(&ctx.http, CreateInteractionResponse::Modal(modal))
        .await
    {
        tracing::error!("modal open failed ({type_id}): {e}");
    }
}

/// Extract (custom_id, value) pairs from any modal payload, ignoring rows
/// that are not InputText. Used by both ticket forms and the feedback modal.
fn modal_inputs(data: &ModalInteractionData) -> Vec<(String, String)> {
    data.components
        .iter()
        .flat_map(|row| row.components.iter())
        .filter_map(|component| match component {
            ActionRowComponent::InputText(it) => {
                Some((it.custom_id.clone(), it.value.clone().unwrap_or_default()))
            }
            _ => None,
        })
        .collect()
}

async fn handle_modal_submit(
    ctx: &Context,
    interaction: &Interaction,
    type_id: &str,
    data: &ModalInteractionData,
) {
    let tt = match types::find_type(type_id) {
        Some(t) => t,
        None => return,
    };

    let raw = modal_inputs(data);
    let answers = match form::parse_submission(tt, &raw) {
        Ok(a) => a,
        Err(msg) => {
            reply_ephemeral(ctx, interaction, &format!("❌ {msg}")).await.ok();
            return;
        }
    };

    let (owner_id, owner_username, owner_display) = author_info(interaction);
    if let Err(e) = create::create_ticket(
        ctx,
        interaction.clone(),
        tt,
        answers,
        owner_id,
        owner_username,
        owner_display,
    )
    .await
    {
        tracing::error!("ticket creation failed ({type_id}): {e}");
    }
}

async fn handle_rating_feedback_modal(
    ctx: &Context,
    interaction: &Interaction,
    data: &ModalInteractionData,
) {
    let raw = modal_inputs(data);
    let feedback = raw
        .iter()
        .find(|(cid, _)| *cid == crate::rating::dm::feedback_input_id())
        .map(|(_, v)| v.clone())
        .unwrap_or_default();
    let user_id = author_id(interaction);
    crate::rating::dm::handle_rating_feedback(ctx, interaction, user_id, &feedback).await;
}

async fn handle_claim(ctx: &Context, state: &State, interaction: &Interaction) {
    let channel_id = interaction.channel_id;
    let author_id = author_id(interaction);

    let is_staff = interaction
        .member
        .as_ref()
        .map(|m| claim::has_staff_role(&m.roles, state.config.staff_role_id))
        .unwrap_or(false);
    if !is_staff {
        reply_ephemeral(ctx, interaction, "❌ Only staff can use this command.")
            .await
            .ok();
        return;
    }

    let now = claim::claim_now();
    match claim::apply_claim(state, channel_id, author_id, now) {
        claim::ClaimResult::Claimed => {
            reply_ephemeral(ctx, interaction, "🔒 Ticket claimed.").await.ok();
            let bg_ctx = ctx.clone();
            tokio::spawn(async move {
                if let Err(e) =
                    claim::post_claim_notice(&bg_ctx, channel_id, author_id, false).await
                {
                    tracing::error!("claim notice failed in {channel_id}: {e}");
                }
            });
        }
        claim::ClaimResult::Already(prev) => {
            reply_ephemeral(
                ctx,
                interaction,
                &format!("⚠️ This ticket already belongs to <@{prev}>."),
            )
            .await
            .ok();
        }
        claim::ClaimResult::NotFound => {
            reply_ephemeral(ctx, interaction, "❌ Ticket not found or already closed.")
                .await
                .ok();
        }
    }
}

async fn handle_close(ctx: &Context, state: &State, interaction: &Interaction) {
    let channel_id = interaction.channel_id;
    let author_id = author_id(interaction);

    let owner_id = match state.tickets.get(&channel_id) {
        Some(t) => t.owner_id,
        None => {
            reply_ephemeral(ctx, interaction, "❌ Ticket not found or already closed.")
                .await
                .ok();
            return;
        }
    };

    let is_staff = interaction
        .member
        .as_ref()
        .map(|m| claim::has_staff_role(&m.roles, state.config.staff_role_id))
        .unwrap_or(false);
    if !is_staff && author_id != owner_id {
        reply_ephemeral(
            ctx,
            interaction,
            "❌ You do not have permission to close this ticket.",
        )
        .await
        .ok();
        return;
    }

    let bg_ctx = ctx.clone();
    let bg_interaction = interaction.clone();
    tokio::spawn(async move {
        if let Err(e) =
            close::close_ticket_manual(&bg_ctx, &bg_interaction, channel_id, author_id).await
        {
            tracing::error!("manual close failed for {channel_id}: {e}");
        }
    });
}

/// Administrator check from cached guild roles. Fail-closed on missing data.
async fn is_administrator(ctx: &Context, interaction: &Interaction) -> bool {
    let guild_id = match interaction.guild_id {
        Some(g) => g,
        None => return false,
    };
    let member = match interaction.member.as_ref() {
        Some(m) => m,
        None => return false,
    };
    if let Some(guild) = ctx.cache.guild(guild_id) {
        for rid in &member.roles {
            if let Some(role) = guild.roles.get(rid) {
                if role.permissions.administrator() {
                    return true;
                }
            }
        }
    }
    false
}

fn author_id(interaction: &Interaction) -> UserId {
    if let Some(m) = interaction.member.as_ref() {
        return m.user.id;
    }
    if let Some(u) = interaction.user.as_ref() {
        return u.id;
    }
    UserId::from(0u64)
}

fn author_info(interaction: &Interaction) -> (UserId, String, String) {
    let user = interaction
        .member
        .as_ref()
        .map(|m| m.user.clone())
        .or_else(|| interaction.user.clone());
    let id = user.as_ref().map(|u| u.id).unwrap_or_else(|| UserId::from(0u64));
    let username = user
        .as_ref()
        .map(|u| u.username.clone())
        .unwrap_or_else(|| "user".to_string());
    let display = crate::utils::display_name(interaction.member.as_ref(), user.as_ref());
    (id, username, display)
}

async fn reply_ephemeral(
    ctx: &Context,
    interaction: &Interaction,
    text: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
