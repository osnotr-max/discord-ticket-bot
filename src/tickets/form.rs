use serenity::builder::{CreateActionRow, CreateInputText, CreateModal};

use crate::tickets::types::{modal_custom_id, TicketType};

/// Deterministic custom_id for the i-th input of a type's modal.
pub fn input_custom_id(tt: &TicketType, index: usize) -> String {
    format!("{}_{}", modal_custom_id(tt), index)
}

/// Build the modal for a ticket type. One input per action row.
pub fn build_modal(tt: &TicketType) -> CreateModal {
    let mut modal = CreateModal::new(modal_custom_id(tt), tt.modal_title);
    for (i, field) in tt.fields.iter().enumerate() {
        let input = CreateInputText::new(field.style, field.label, input_custom_id(tt, i))
            .required(field.required)
            .max_length(field.max_length);
        modal = modal.add_component(CreateActionRow::TextInputs(vec![input]));
    }
    modal
}

/// Validate and reorder raw modal answers into the field order.
pub fn parse_submission(
    tt: &TicketType,
    raw: &[(String, String)],
) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::with_capacity(tt.fields.len());
    for (i, field) in tt.fields.iter().enumerate() {
        let expected = input_custom_id(tt, i);
        let value = raw
            .iter()
            .find(|(cid, _)| *cid == expected)
            .map(|(_, v)| v.as_str())
            .unwrap_or("");
        let trimmed = value.trim().to_string();
        if field.required && trimmed.is_empty() {
            return Err(format!("Required field \"{}\" is empty.", field.label));
        }
        out.push((field.label.to_string(), trimmed));
    }
    Ok(out)
}
