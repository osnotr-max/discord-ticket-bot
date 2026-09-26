use chrono::{DateTime, Duration, Utc};
use serenity::model::prelude::*;

use crate::config::Config;

/// Canonical staff-role mention. EVERY staff-role ping MUST come from here.
/// For the ping to work, the role must be mentionable OR the bot must have
/// the Mention Everyone permission.
pub fn staff_mention(cfg: &Config) -> String {
    format!("<@&{}>", cfg.staff_role_id)
}

/// Sanitize an arbitrary username into a valid Discord channel name.
pub fn sanitize_channel_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len().min(100));
    let mut prev_dash = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        return "ticket".to_string();
    }
    if out.len() > 80 {
        out.truncate(80);
        while out.ends_with('-') {
            out.pop();
        }
    }
    out
}

/// Truncate by characters (runes), appending an ellipsis. Safe for UTF-8.
pub fn truncate_chars(s: &str, max: usize) -> String {
    if max == 0 {
        return String::new();
    }
    let mut count = 0usize;
    for (idx, _) in s.char_indices() {
        if count == max {
            return format!("{}…", &s[..idx]);
        }
        count += 1;
    }
    s.to_string()
}

pub fn truncate_embed_name(s: &str) -> String {
    truncate_chars(s, 256)
}
pub fn truncate_embed_value(s: &str) -> String {
    truncate_chars(s, 1024)
}

/// Human duration: "3h 12m", "45m", "<1m".
pub fn format_duration(dur: Duration) -> String {
    let mins = dur.num_minutes();
    if mins < 1 {
        return "<1m".to_string();
    }
    let h = mins / 60;
    let m = mins % 60;
    if h > 0 {
        format!("{h}h {m}m")
    } else {
        format!("{m}m")
    }
}

pub fn now_utc() -> DateTime<Utc> {
    Utc::now()
}

/// Friendly display name for logs/UI only (NEVER used as AI context).
pub fn display_name(member: Option<&Member>, user: Option<&User>) -> String {
    if let Some(m) = member {
        if let Some(nick) = m.nick.as_ref() {
            let n = nick.trim();
            if !n.is_empty() {
                return n.to_string();
            }
        }
    }
    if let Some(u) = user {
        if let Some(g) = u.global_name.as_ref() {
            let g = g.trim();
            if !g.is_empty() {
                return g.to_string();
            }
        }
        let un = u.username.trim();
        if !un.is_empty() {
            return un.to_string();
        }
    }
    "user".to_string()
}
