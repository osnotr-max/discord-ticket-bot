use std::env;

use serenity::model::id::{ChannelId, GuildId, RoleId};

const DEFAULT_STAFF_ROLE_ID: u64 = 1538753673847644270;

#[derive(Clone, Debug)]
pub struct Config {
    pub token: String,
    pub guild_id: GuildId,
    pub staff_role_id: RoleId,
    pub ticket_category_id: ChannelId,
    pub log_channel_id: ChannelId,
    pub transcript_channel_id: ChannelId,
    pub max_tickets_per_user: usize,
    pub cooldown_create_secs: i64,
    pub action_cooldown_secs: i64,
    pub max_tickets_per_guild: usize,
    pub mention_staff_on_create: bool,
    pub mention_staff_on_unclaim: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        dotenvy::dotenv().ok();

        let token =
            env::var("DISCORD_TOKEN").map_err(|_| "DISCORD_TOKEN is required.".to_string())?;
        if token.trim().is_empty() {
            return Err("DISCORD_TOKEN must not be empty.".to_string());
        }

        let guild_id = GuildId::from(parse_required_id("GUILD_ID")?);
        let staff_role_id =
            RoleId::from(parse_optional_id("STAFF_ROLE_ID")?.unwrap_or(DEFAULT_STAFF_ROLE_ID));
        let ticket_category_id = ChannelId::from(parse_required_id("TICKET_CATEGORY_ID")?);
        let log_channel_id = ChannelId::from(parse_required_id("LOG_CHANNEL_ID")?);

        // Transcript falls back to the log channel when empty/unset, so the
        // single audit channel receives transcripts too.
        let transcript_channel_id = match parse_optional_id("TRANSCRIPT_CHANNEL_ID")? {
            Some(id) => ChannelId::from(id),
            None => log_channel_id,
        };

        let max_tickets_per_user = parse_required_usize("MAX_TICKETS_PER_USER", 3)?;
        let cooldown_create_secs = parse_required_i64("COOLDOWN_CREATE_SECS", 30)?;
        let action_cooldown_secs = parse_required_i64("ACTION_COOLDOWN_SECS", 3)?;
        let max_tickets_per_guild = parse_required_usize("MAX_TICKETS_PER_GUILD", 50)?;

        if cooldown_create_secs < 0 {
            return Err("COOLDOWN_CREATE_SECS must be non-negative.".to_string());
        }
        if action_cooldown_secs < 0 {
            return Err("ACTION_COOLDOWN_SECS must be non-negative.".to_string());
        }
        if max_tickets_per_user == 0 {
            return Err("MAX_TICKETS_PER_USER must be at least 1.".to_string());
        }
        if max_tickets_per_guild == 0 {
            return Err("MAX_TICKETS_PER_GUILD must be at least 1.".to_string());
        }

        Ok(Self {
            token,
            guild_id,
            staff_role_id,
            ticket_category_id,
            log_channel_id,
            transcript_channel_id,
            max_tickets_per_user,
            cooldown_create_secs,
            action_cooldown_secs,
            max_tickets_per_guild,
            mention_staff_on_create: parse_bool("MENTION_STAFF_ON_CREATE", true),
            mention_staff_on_unclaim: parse_bool("MENTION_STAFF_ON_UNCLAIM", true),
        })
    }
}

fn parse_u64(raw: &str) -> Result<u64, String> {
    raw.trim()
        .parse::<u64>()
        .map_err(|_| format!("invalid integer value: {raw:?}"))
}

fn parse_required_id(name: &str) -> Result<u64, String> {
    let raw = env::var(name).map_err(|_| format!("{name} is required."))?;
    if raw.trim().is_empty() {
        return Err(format!("{name} must not be empty."));
    }
    parse_u64(&raw).map_err(|e| format!("{name}: {e}"))
}

fn parse_optional_id(name: &str) -> Result<Option<u64>, String> {
    match env::var(name) {
        Ok(raw) if !raw.trim().is_empty() => parse_u64(&raw)
            .map(Some)
            .map_err(|e| format!("{name}: {e}")),
        _ => Ok(None),
    }
}

fn parse_required_i64(name: &str, default: i64) -> Result<i64, String> {
    match env::var(name) {
        Ok(raw) if !raw.trim().is_empty() => raw
            .trim()
            .parse::<i64>()
            .map_err(|_| format!("{name} must be a valid integer.")),
        _ => Ok(default),
    }
}

fn parse_required_usize(name: &str, default: usize) -> Result<usize, String> {
    let v = parse_required_i64(name, default as i64)?;
    if v < 0 {
        return Err(format!("{name} must be non-negative."));
    }
    Ok(v as usize)
}

fn parse_bool(name: &str, default: bool) -> bool {
    match env::var(name) {
        Ok(raw) => {
            let v = raw.trim().to_lowercase();
            match v.as_str() {
                "1" | "true" | "yes" | "sim" => true,
                "0" | "false" | "no" | "nao" | "não" => false,
                _ => default,
            }
        }
        Err(_) => default,
    }
}
