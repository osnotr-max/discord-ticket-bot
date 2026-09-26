use std::error::Error;

use chrono::{DateTime, Utc};
use serenity::builder::{
    CreateActionRow, CreateButton, CreateChannel, CreateEmbed, CreateFooter,
    CreateInteractionResponse, CreateInteractionResponseMessage, CreateMessage,
    CreatePermissionOverwrite,
};
use serenity::model::prelude::*;

use crate::state::{State, Ticket};
use crate::tickets::types::TicketType;
use crate::utils::{
    now_utc, sanitize_channel_name, staff_mention, truncate_embed_name, truncate_embed_value,
};

const WELCOME_COLOR: u32 = 0x5865F2;
const LOG_COLOR: u32 = 0x57F28A;

/// Full creation flow after a valid modal submit.
pub async fn create_ticket(
    ctx: &Context,
    interaction: Interaction,
    tt: &'static TicketType,
    answers: Vec<(String, String)>,
    owner_id: UserId,
    owner_username: String,
    owner_display: String,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let state = match State::get(ctx).await {
        Some(s) => s,
        None => {
            tracing::error!("state missing in create_ticket");
            reply_ephemeral(ctx, &interaction, "❌ Internal error. Try again.").await.ok();
            return Ok(());
        }
    };
    let cfg = state.config.clone();
    let now = now_utc();

    if let Some(last) = state.cooldowns.get(&owner_id) {
        let elapsed = now.signed_duration_since(*last);
        if elapsed.num_seconds() < cfg.cooldown_create_secs {
            let wait = cfg.cooldown_create_secs - elapsed.num_seconds();
            drop(last);
            reply_ephemeral(
                ctx,
                &interaction,
                &format!("⏳ Please wait {wait}s before creating another ticket."),
            )
            .await
            .ok();
            return Ok(());
        }
    }

    let user_open = state
        .tickets
        .iter()
        .filter(|t| t.value().owner_id == owner_id)
        .count();
    if user_open >= cfg.max_tickets_per_user {
        reply_ephemeral(
            ctx,
            &interaction,
            &format!(
                "❌ You reached the limit of {} open tickets.",
                cfg.max_tickets_per_user
            ),
        )
        .await
        .ok();
        return Ok(());
    }

    if state.tickets.len() >= cfg.max_tickets_per_guild {
        reply_ephemeral(
            ctx,
            &interaction,
            "❌ The server reached the global ticket limit.",
        )
        .await
        .ok();
        return Ok(());
    }

    let channel_name = format!(
        "{}{}",
        tt.channel_prefix,
        sanitize_channel_name(&owner_username)
    );
    let overwrites = build_permission_overwrites(&cfg, ctx, owner_id);

    let channel = match cfg
        .guild_id
        .create_channel(&ctx.http, |c: CreateChannel| {
            c.name(channel_name.clone())
                .kind(ChannelType::Text)
                .category(cfg.ticket_category_id)
                .permission_overwrites(overwrites)
        })
        .await
    {
        Ok(ch) => ch,
        Err(e) => {
            tracing::error!("failed to create ticket channel: {e}");
            reply_ephemeral(
                ctx,
                &interaction,
                "❌ Could not create the channel right now.",
            )
            .await
            .ok();
            return Err(Box::new(e));
        }
    };

    let ticket = Ticket {
        id: channel.id.to_string(),
        type_id: tt.type_id.to_string(),
        channel_id: channel.id,
        owner_id,
        owner_name: owner_display.clone(),
        answers: answers.clone(),
        created_at: now,
        claimed_by: None,
        claimed_at: None,
        last_activity: now,
        reminder_sent: false,
    };
    state.tickets.insert(channel.id, ticket);
    state.cooldowns.insert(owner_id, now);

    reply_ephemeral(
        ctx,
        &interaction,
        &format!("✅ Ticket created in <#{}>.", channel.id),
    )
    .await
    .ok();

    let welcome_embed = build_welcome_embed(tt, owner_id, &answers);
    let welcome_rows = build_ticket_buttons();
    let welcome_content = if cfg.mention_staff_on_create {
        staff_mention(&cfg)
    } else {
        String::new()
    };
    let log_embed = build_creation_log(
        &cfg,
        tt,
        owner_id,
        &owner_display,
        channel.id,
        answers.first().cloned(),
        now,
    );

    let bg_ctx = ctx.clone();
    let bg_channel_id = channel.id;
    let bg_log_channel = cfg.log_channel_id;

    tokio::spawn(async move {
        if let Err(e) = send_channel_message(
            &bg_ctx,
            bg_channel_id,
            welcome_embed,
            welcome_rows,
            welcome_content,
        )
        .await
        {
            tracing::error!("welcome msg failed: {e}");
        }
        if let Err(e) = send_embed_only(&bg_ctx, bg_log_channel, log_embed).await {
            tracing::error!("creation log failed: {e}");
        }
    });

    Ok(())
}

fn build_permission_overwrites(
    cfg: &crate::config::Config,
    ctx: &Context,
    owner_id: UserId,
) -> Vec<CreatePermissionOverwrite> {
    let everyone =
        CreatePermissionOverwrite::new(PermissionOverwriteType::Role(RoleId::from(
            cfg.guild_id.get(),
        )))
        .deny(Permissions::VIEW_CHANNEL);
    let owner = CreatePermissionOverwrite::new(PermissionOverwriteType::Member(owner_id)).allow(
        Permissions::VIEW_CHANNEL
            | Permissions::SEND_MESSAGES
            | Permissions::READ_MESSAGE_HISTORY,
    );
    let staff =
        CreatePermissionOverwrite::new(PermissionOverwriteType::Role(cfg.staff_role_id))
            .allow(Permissions::all());
    let bot_id = ctx.cache.current_user().id;
    let bot = CreatePermissionOverwrite::new(PermissionOverwriteType::Member(bot_id))
        .allow(Permissions::all());
    vec![everyone, owner, staff, bot]
}

fn build_welcome_embed(
    tt: &TicketType,
    owner_id: UserId,
    answers: &[(String, String)],
) -> CreateEmbed {
    let mut embed = CreateEmbed::new()
        .title(format!("{} {}", tt.button_emoji, tt.button_label))
        .description(format!(
            "Hello <@{owner_id}>, your ticket has been created. A staff member will attend you soon."
        ))
        .colour(WELCOME_COLOR);
    for (label, value) in answers {
        let shown = if value.trim().is_empty() { "—" } else { value.as_str() };
        embed = embed.field(
            truncate_embed_name(label),
            truncate_embed_value(shown),
            false,
        );
    }
    embed
}

fn build_ticket_buttons() -> Vec<CreateActionRow> {
    let claim = CreateButton::new("ticket_claim")
        .label("🔒 Claim")
        .style(ButtonStyle::Secondary);
    let close = CreateButton::new("ticket_close")
        .label("🔴 Close")
        .style(ButtonStyle::Danger);
    vec![CreateActionRow::Buttons(vec![claim, close])]
}

fn build_creation_log(
    cfg: &crate::config::Config,
    tt: &TicketType,
    owner_id: UserId,
    owner_display: &str,
    channel_id: ChannelId,
    first_answer: Option<(String, String)>,
    created_at: DateTime<Utc>,
) -> CreateEmbed {
    let mut embed = CreateEmbed::new()
        .title("🎫 Ticket created")
        .colour(LOG_COLOR)
        .field("Type", tt.button_label, true)
        .field("Owner", format!("{owner_display} (<@{owner_id}>)"), true)
        .field("Channel", format!("<#{channel_id}>"), true)
        .field(
            "Created at",
            created_at.format("%d/%m/%Y %H:%M UTC").to_string(),
            true,
        );
    if let Some((label, value)) = first_answer {
        let shown = if value.trim().is_empty() { "—" } else { value.as_str() };
        embed = embed
            .field("First question", truncate_embed_name(&label), true)
            .field("First answer", truncate_embed_value(shown), false);
    }
    embed = embed.footer(CreateFooter::new(format!("guild {}", cfg.guild_id)));
    embed
}

async fn send_channel_message(
    ctx: &Context,
    channel_id: ChannelId,
    embed: CreateEmbed,
    rows: Vec<CreateActionRow>,
    content: String,
) -> Result<(), Box<dyn Error + Send + Sync>> {
    let mut msg = CreateMessage::new().embed(embed).components(rows);
    if !content.is_empty() {
        msg = msg.content(content);
    }
    channel_id.send_message(&ctx.http, msg).await?;
    Ok(())
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
