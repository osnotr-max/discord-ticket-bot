use serenity::builder::{
    CreateActionRow, CreateButton, CreateEmbed, CreateFooter, CreateInteractionResponse,
    CreateInteractionResponseMessage,
};
use serenity::model::prelude::*;

use crate::tickets::types::{button_custom_id, button_full_label, find_type, TicketType};

const PANEL_DESCRIPTION: &str = "We have 4 options of tickets you can make\n\n\
Problems in the script: For reporting Bugs in the script\n\n\
General support: Questions concerns suggestions. Etc\n\n\
User report: To report Server members that are breaking the rules.\n\n\
Staff Report Ticket: For reporting staff members. (WARNING: Beta testers and \
content creators are NOT staff DO NOT use this option to report beta testers \
or content creators use the user report option!)";

const PANEL_COLOR: u32 = 0xF0B429;

/// Publish the panel as a PUBLIC response to /setup_panel.
pub async fn send_panel(
    ctx: &Context,
    interaction: &Interaction,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let rows = build_panel_rows()?;
    let bot_name = ctx.cache.current_user().username.clone();

    let embed = CreateEmbed::new()
        .title("Support")
        .description(PANEL_DESCRIPTION)
        .colour(PANEL_COLOR)
        .footer(CreateFooter::new(bot_name));

    interaction
        .clone()
        .create_response(
            &ctx.http,
            CreateInteractionResponse::Message(
                CreateInteractionResponseMessage::new()
                    .embed(embed)
                    .components(rows),
            ),
        )
        .await?;
    Ok(())
}

fn build_panel_rows() -> Result<Vec<CreateActionRow>, String> {
    let script = find_type("script").ok_or("missing script type")?;
    let general = find_type("general").ok_or("missing general type")?;
    let staff = find_type("staff_report").ok_or("missing staff_report type")?;
    let user = find_type("user_report").ok_or("missing user_report type")?;
    Ok(vec![
        CreateActionRow::Buttons(vec![panel_button(script)]),
        CreateActionRow::Buttons(vec![panel_button(general)]),
        CreateActionRow::Buttons(vec![panel_button(staff), panel_button(user)]),
    ])
}

fn panel_button(tt: &TicketType) -> CreateButton {
    CreateButton::new(button_custom_id(tt))
        .label(button_full_label(tt))
        .style(ButtonStyle::Primary)
}
