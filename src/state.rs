use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use dashmap::DashMap;
use serenity::model::prelude::*;

use crate::config::Config;

#[derive(Clone, Debug)]
pub struct Ticket {
    pub id: String,
    pub type_id: String,
    pub channel_id: ChannelId,
    pub owner_id: UserId,
    pub owner_name: String,
    pub answers: Vec<(String, String)>,
    pub created_at: DateTime<Utc>,
    pub claimed_by: Option<UserId>,
    pub claimed_at: Option<DateTime<Utc>>,
    pub last_activity: DateTime<Utc>,
    /// True once the 10h open-ticket DM reminder was sent for the current
    /// inactivity cycle. Reset to false by any new activity.
    pub reminder_sent: bool,
}

/// Rating pending after a ticket closes (the DM with the 5 stars).
#[derive(Clone, Debug)]
pub struct RatingPending {
    pub ticket_id: String,
    pub channel_id: ChannelId,
    pub claimed_by: Option<UserId>,
    pub created_at: DateTime<Utc>,
}

/// In-progress rating after the user clicked a star, waiting for the
/// optional feedback modal submit. Holds the chosen star value so the
/// feedback log can attach the rating text to the right score.
#[derive(Clone, Debug)]
pub struct RatingInProgress {
    pub ticket_id: String,
    pub channel_id: ChannelId,
    pub claimed_by: Option<UserId>,
    pub stars: u8,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone)]
pub struct State {
    pub config: Arc<Config>,
    pub tickets: Arc<DashMap<ChannelId, Ticket>>,
    pub ratings: Arc<DashMap<UserId, RatingPending>>,
    pub rating_in_progress: Arc<DashMap<UserId, RatingInProgress>>,
    pub cooldowns: Arc<DashMap<UserId, DateTime<Utc>>>,
    pub action_cooldowns: Arc<DashMap<(UserId, String), DateTime<Utc>>>,
    pub timeout_started: Arc<AtomicBool>,
}

impl TypeMapMarker for State {
    type ValueType = State;
}

impl State {
    pub fn new(config: Config) -> Self {
        Self {
            config: Arc::new(config),
            tickets: Arc::new(DashMap::new()),
            ratings: Arc::new(DashMap::new()),
            rating_in_progress: Arc::new(DashMap::new()),
            cooldowns: Arc::new(DashMap::new()),
            action_cooldowns: Arc::new(DashMap::new()),
            timeout_started: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Enforce a small per-user, per-action cooldown without delaying the
    /// interaction response. Returns the remaining seconds when blocked.
    pub fn action_cooldown_remaining(
        &self,
        user_id: UserId,
        action: &str,
        now: DateTime<Utc>,
    ) -> Option<i64> {
        let key = (user_id, action.to_string());
        if let Some(last) = self.action_cooldowns.get(&key) {
            let elapsed = now.signed_duration_since(*last).num_seconds();
            let remaining = self.config.action_cooldown_secs - elapsed;
            if remaining > 0 {
                return Some(remaining);
            }
        }
        self.action_cooldowns.insert(key, now);
        None
    }

    pub async fn get(ctx: &Context) -> Option<Self> {
        let data = ctx.data.read().await;
        data.get::<State>().cloned()
    }
}
