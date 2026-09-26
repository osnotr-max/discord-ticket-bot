use serenity::model::interactions::modal::InputTextStyle;

#[derive(Clone, Copy, Debug)]
pub struct FormField {
    pub label: &'static str,
    pub style: InputTextStyle,
    pub max_length: u16,
    pub required: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct TicketType {
    pub type_id: &'static str,
    pub channel_prefix: &'static str,
    pub button_label: &'static str,
    pub button_emoji: &'static str,
    pub modal_title: &'static str,
    pub fields: &'static [FormField],
}

/// Single editable source of truth for the 4 ticket types.
pub static TICKET_TYPES: [TicketType; 4] = [
    TicketType {
        type_id: "script",
        channel_prefix: "script-",
        button_label: "Problems in the script",
        button_emoji: "🎫",
        modal_title: "Please answer the question below.",
        fields: &[
            FormField {
                label: "What is your executor?",
                style: InputTextStyle::Paragraph,
                max_length: 500,
                required: true,
            },
            FormField {
                label: "What operating system do you use (iOS, etc.)?",
                style: InputTextStyle::Paragraph,
                max_length: 500,
                required: true,
            },
            FormField {
                label: "Which game?",
                style: InputTextStyle::Paragraph,
                max_length: 500,
                required: true,
            },
        ],
    },
    TicketType {
        type_id: "general",
        channel_prefix: "support-",
        button_label: "General Support",
        button_emoji: "🎧",
        modal_title: "Please answer the question below.",
        fields: &[FormField {
            label: "What are you here for? (Be direct)",
            style: InputTextStyle::Paragraph,
            max_length: 4000,
            required: false,
        }],
    },
    TicketType {
        type_id: "staff_report",
        channel_prefix: "staff-report-",
        button_label: "Staff Report ticket",
        button_emoji: "⚠️",
        modal_title: "Please answer the question below.",
        fields: &[
            FormField {
                label: "Which staff are you reporting to?",
                style: InputTextStyle::Short,
                max_length: 300,
                required: true,
            },
            FormField {
                label: "Reason for report",
                style: InputTextStyle::Paragraph,
                max_length: 500,
                required: true,
            },
        ],
    },
    TicketType {
        type_id: "user_report",
        channel_prefix: "user-report-",
        button_label: "User report",
        button_emoji: "🚫",
        modal_title: "Please answer the question below.",
        fields: &[
            FormField {
                label: "Which member is the target of the report?",
                style: InputTextStyle::Short,
                max_length: 300,
                required: false,
            },
            FormField {
                label: "What did he do?",
                style: InputTextStyle::Paragraph,
                max_length: 500,
                required: false,
            },
        ],
    },
];

pub fn find_type(type_id: &str) -> Option<&'static TicketType> {
    TICKET_TYPES.iter().find(|t| t.type_id == type_id)
}

pub fn button_custom_id(tt: &TicketType) -> String {
    format!("ticket_open_{}", tt.type_id)
}
pub fn modal_custom_id(tt: &TicketType) -> String {
    format!("ticket_form_{}", tt.type_id)
}
pub fn button_full_label(tt: &TicketType) -> String {
    format!("{} {}", tt.button_emoji, tt.button_label)
}
