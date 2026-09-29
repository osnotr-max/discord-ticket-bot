/*
 * Low-memory Honeylua Discord support service.
 *
 * This intentionally uses only Bun/TypeScript built-ins:
 *   - native fetch for Discord REST
 *   - native WebSocket for the Gateway
 *   - Map for small, bounded application state
 *
 * Keeping the protocol layer here avoids loading a large Discord client
 * framework and its message/guild object cache on a 512 MB server.
 */

const API = "https://discord.com/api/v10";
const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const DEFAULT_STAFF_ROLE_ID = "1538753673847644270";
const STAFF_REPORT_ROLE_IDS = [
  "1525161651987284249",
  "1531344415396991028",
  "1539430404220518410"
] as const;
const USER_REPORT_ROLE_ID = "1525161655053320385";
const BRAND = "Honeylua";
const SUPPORT_NAME = "Honeylua Support";

type Snowflake = string;
type Json = Record<string, any>;

const PERMISSIONS = {
  VIEW_CHANNEL: 1024,
  SEND_MESSAGES: 2048,
  MANAGE_CHANNELS: 16,
  MANAGE_MESSAGES: 8192,
  EMBED_LINKS: 16384,
  ATTACH_FILES: 32768,
  READ_MESSAGE_HISTORY: 65536
} as const;

interface Config {
  token: string;
  guildId: Snowflake;
  staffRoleId: Snowflake;
  ticketCategoryId: Snowflake;
  logChannelId: Snowflake;
  transcriptChannelId: Snowflake;
  maxTicketsPerUser: number;
  cooldownCreateMs: number;
  actionCooldownMs: number;
  maxTicketsPerGuild: number;
  mentionStaffOnCreate: boolean;
  mentionStaffOnUnclaim: boolean;
  maxTranscriptPages: number;
  requestTimeoutMs: number;
  transcriptPageDelayMs: number;
  maxTranscriptBytes: number;
}

interface Ticket {
  id: Snowflake;
  typeId: string;
  channelId: Snowflake;
  ownerId: Snowflake;
  ownerName: string;
  answers: [string, string][];
  createdAt: number;
  claimedBy?: Snowflake;
  claimedAt?: number;
  controlMessageId?: Snowflake;
  lastActivity: number;
  reminderSent: boolean;
}

interface RatingPending {
  ticketId: Snowflake;
  ownerId: Snowflake;
  channelId: Snowflake;
  claimedBy?: Snowflake;
  createdAt: number;
}

interface RatingInProgress extends RatingPending {
  stars: number;
}

interface Interaction {
  id: string;
  token: string;
  application_id: Snowflake;
  type: number;
  guild_id?: Snowflake;
  channel_id?: Snowflake;
  user?: Json;
  member?: Json;
  message?: Json;
  data?: Json;
}

interface GatewayPayload {
  op: number;
  d: any;
  s?: number;
  t?: string;
}

interface TicketField {
  label: string;
  style: number;
  maxLength: number;
  required: boolean;
}

interface TicketType {
  typeId: string;
  channelPrefix: string;
  buttonLabel: string;
  emoji: string;
  fields: TicketField[];
  accessRoleIds?: Snowflake[];
  mentionRoleIds?: Snowflake[];
}

const TYPES: TicketType[] = [
  {
    typeId: "script",
    channelPrefix: "script-",
    buttonLabel: "Script Support",
    emoji: "🎫",
    fields: [
      { label: "What is your executor?", style: 2, maxLength: 500, required: true },
      { label: "What operating system do you use (iOS, etc.)?", style: 2, maxLength: 500, required: true },
      { label: "Which game?", style: 2, maxLength: 500, required: true }
    ]
  },
  {
    typeId: "general",
    channelPrefix: "support-",
    buttonLabel: "General Support",
    emoji: "🎧",
    fields: [
      { label: "What are you here for? (Be direct)", style: 2, maxLength: 4000, required: false }
    ]
  },
  {
    typeId: "staff_report",
    channelPrefix: "staff-report-",
    buttonLabel: "Report a Staff Member",
    emoji: "⚠️",
    accessRoleIds: [...STAFF_REPORT_ROLE_IDS],
    mentionRoleIds: [...STAFF_REPORT_ROLE_IDS],
    fields: [
      { label: "Which staff are you reporting to?", style: 1, maxLength: 300, required: true },
      { label: "Reason for report", style: 2, maxLength: 500, required: true }
    ]
  },
  {
    typeId: "user_report",
    channelPrefix: "user-report-",
    buttonLabel: "Report a User",
    emoji: "🚫",
    accessRoleIds: [USER_REPORT_ROLE_ID],
    mentionRoleIds: [USER_REPORT_ROLE_ID],
    fields: [
      { label: "Which member is the target of the report?", style: 1, maxLength: 300, required: false },
      { label: "What did he do?", style: 2, maxLength: 500, required: false }
    ]
  }
];

const PANEL_DESCRIPTION = `Welcome to Honeylua Support!

Choose the option that best matches what you need. Please provide clear,
complete answers so our team can help you faster.

🎫 Script Support
Report bugs, executor issues, game problems, or script questions.

🎧 General Support
Ask a question, share a suggestion, or request general assistance.

⚠️ Report a Staff Member
Use this only for a genuine staff-related report.

🚫 Report a User
Report a member who is breaking the server rules.

Please do not report beta testers or content creators as staff members.`;

const state = {
  tickets: new Map<Snowflake, Ticket>(),
  ratings: new Map<Snowflake, RatingPending>(),
  ratingInProgress: new Map<Snowflake, RatingInProgress>(),
  completedRatings: new Map<Snowflake, number>(),
  createCooldowns: new Map<Snowflake, number>(),
  actionCooldowns: new Map<string, number>(),
  config: null as Config | null,
  botId: "",
  applicationId: "",
  gateway: null as WebSocket | null,
  sessionId: "",
  resumeUrl: "",
  sequence: null as number | null,
  reconnecting: false,
  reconnectDelay: 3000,
  heartbeat: null as ReturnType<typeof setInterval> | null,
  heartbeatAck: true,
  claiming: new Set<Snowflake>(),
  closing: new Set<Snowflake>(),
  creating: new Set<string>(),
  creatingUsers: new Set<Snowflake>(),
  pendingCreations: 0,
  guildRoleIds: new Set<Snowflake>(),
  guildRoleNames: new Map<Snowflake, string>(),
  guildRolePermissions: new Map<Snowflake, bigint>(),
  memberRoles: new Map<Snowflake, Snowflake[]>(),
  memberNames: new Map<Snowflake, string>(),
  guildRolesLoaded: false,
  guildRoleLoad: null as Promise<void> | null,
  ticketsHydrated: false,
  hydratingTickets: false
};

function requiredEnv(name: string): string {
  const value = Bun.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function idEnv(name: string, fallback?: string): Snowflake {
  const value = Bun.env[name]?.trim() || fallback;
  if (!value || !/^\d+$/.test(value)) throw new Error(`${name} must be a Discord ID.`);
  return value;
}

function integerEnv(name: string, fallback: number): number {
  const raw = Bun.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = Bun.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "sim"].includes(raw)) return true;
  if (["0", "false", "no", "nao", "não"].includes(raw)) return false;
  return fallback;
}

function loadConfig(): Config {
  const token = requiredEnv("DISCORD_TOKEN");
  return {
    token,
    guildId: idEnv("GUILD_ID"),
    staffRoleId: idEnv("STAFF_ROLE_ID", DEFAULT_STAFF_ROLE_ID),
    ticketCategoryId: idEnv("TICKET_CATEGORY_ID"),
    logChannelId: idEnv("LOG_CHANNEL_ID"),
    transcriptChannelId: idEnv("TRANSCRIPT_CHANNEL_ID", idEnv("LOG_CHANNEL_ID")),
    maxTicketsPerUser: Math.max(1, integerEnv("MAX_TICKETS_PER_USER", 3)),
    cooldownCreateMs: integerEnv("COOLDOWN_CREATE_SECS", 30) * 1000,
    actionCooldownMs: integerEnv("ACTION_COOLDOWN_SECS", 3) * 1000,
    maxTicketsPerGuild: Math.max(1, integerEnv("MAX_TICKETS_PER_GUILD", 50)),
    mentionStaffOnCreate: boolEnv("MENTION_STAFF_ON_CREATE", true),
    mentionStaffOnUnclaim: boolEnv("MENTION_STAFF_ON_UNCLAIM", true),
    maxTranscriptPages: Math.min(50, Math.max(1, integerEnv("MAX_TRANSCRIPT_PAGES", 50))),
    requestTimeoutMs: Math.min(60_000, Math.max(5_000, integerEnv("DISCORD_REQUEST_TIMEOUT_MS", 15_000))),
    transcriptPageDelayMs: Math.min(2_000, Math.max(100, integerEnv("TRANSCRIPT_PAGE_DELAY_MS", 250))),
    // Keep generated HTML below Discord's commonly available upload ceiling.
    // The transcript will gracefully keep the newest messages if this is exceeded.
    maxTranscriptBytes: Math.min(24 * 1024 * 1024, Math.max(1 * 1024 * 1024, integerEnv("MAX_TRANSCRIPT_BYTES", 20 * 1024 * 1024)))
  };
}

function log(message: string, error?: unknown): void {
  if (error) console.error(`[honeylua] ${message}`, error);
  else console.log(`[honeylua] ${message}`);
}

function cfg(): Config {
  if (!state.config) throw new Error("Configuration is not loaded.");
  return state.config;
}

async function discordRequest(path: string, init: RequestInit = {}, json?: unknown): Promise<any> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${cfg().token}`);
  headers.set("User-Agent", "honeylua/2.1 (Bun)");
  let body = init.body;
  if (json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(json);
  }

  for (let attempt = 0; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg().requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(`${API}${path}`, { ...init, headers, body, signal: controller.signal });
    } catch (error) {
      if (attempt >= 3) throw error;
      await Bun.sleep(Math.min(4_000, 500 * 2 ** attempt));
      continue;
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) return response.status === 204 ? null : response.json();

    const text = await response.text();
    const retryableServerError = [500, 502, 503, 504].includes(response.status);
    if ((response.status === 429 || retryableServerError) && attempt < 3) {
      let retryMs = 500 * 2 ** attempt;
      if (response.status === 429) {
        let retryAfter = Number(response.headers.get("Retry-After") || "0");
        try {
          const details = JSON.parse(text);
          retryAfter = Number(details.retry_after || retryAfter);
        } catch {
          // Use the header/backoff when the body is not JSON.
        }
        if (Number.isFinite(retryAfter) && retryAfter > 0) retryMs = retryAfter * 1000;
      }
      await Bun.sleep(Math.min(15_000, Math.max(250, Math.ceil(retryMs))));
      continue;
    }
    throw new Error(`Discord ${response.status} ${path}: ${text.slice(0, 500)}`);
  }
  throw new Error(`Discord request exhausted retries: ${path}`);
}

async function sendMessage(channelId: Snowflake, payload: Json, file?: { name: string; content: string }): Promise<Json> {
  if (!file) return discordRequest(`/channels/${channelId}/messages`, { method: "POST" }, payload);
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  form.append("files[0]", new Blob([file.content], { type: "text/html; charset=utf-8" }), file.name);
  return discordRequest(`/channels/${channelId}/messages`, { method: "POST", body: form });
}

async function sendClaimNotice(
  ticket: Ticket,
  title: string,
  color: number,
  description: string,
  mentionOwner = true
): Promise<void> {
  const ownerMention = mentionOwner ? `<@${ticket.ownerId}>` : undefined;
  const message = await sendMessage(ticket.channelId, {
    content: ownerMention,
    embeds: [embed(title, color, description)]
  });
  if (!message?.id) return;

  // Claim/release notices are temporary. The persistent ticket control message
  // is updated separately, so the channel does not accumulate bot status messages.
  setTimeout(() => {
    void discordRequest(`/channels/${ticket.channelId}/messages/${message.id}`, { method: "DELETE" })
      .catch((error) => {
        if (!String(error).includes("Discord 404")) log(`claim notice deletion failed in ${ticket.channelId}`, error);
      });
  }, 10_000);
}

async function sendAutoClaimNotice(ticket: Ticket, staffId: Snowflake): Promise<void> {
  await sendClaimNotice(
    ticket,
    `🔒 ${BRAND} • Ticket Claimed`,
    0xf0b429,
    `<@${staffId}> started handling this ticket automatically.`
  );
}

function embed(title: string, color: number, description?: string): Json {
  const result: Json = { title, color };
  if (description) result.description = description;
  return result;
}

function button(customId: string, label: string, style: number, disabled = false): Json {
  return { type: 2, custom_id: customId, label, style, ...(disabled ? { disabled: true } : {}) };
}

function row(components: Json[]): Json {
  return { type: 1, components };
}

function roleMention(roleIds: Snowflake[]): string {
  return roleIds.map((id) => `<@&${id}>`).join(" ");
}

function ticketAccessRoleIds(type: TicketType): Snowflake[] {
  return type.accessRoleIds?.length ? type.accessRoleIds : [cfg().staffRoleId];
}

function ticketMention(type: TicketType): string {
  return roleMention(type.mentionRoleIds?.length ? type.mentionRoleIds : [cfg().staffRoleId]);
}

function findType(typeId: string): TicketType | undefined {
  return TYPES.find((type) => type.typeId === typeId);
}

function ticketTypeFromChannelName(name: string): TicketType | undefined {
  return TYPES.find((type) => name.startsWith(type.channelPrefix));
}

function sanitizeChannelName(raw: string): string {
  const clean = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return clean || "ticket";
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : value;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function displayName(member: Json | undefined, user: Json | undefined): string {
  const nick = member?.nick?.trim();
  if (nick) return nick;
  return user?.global_name?.trim() || user?.username?.trim() || "user";
}

function interactionUser(interaction: Interaction): Json {
  return interaction.member?.user || interaction.user || {};
}

function interactionUserId(interaction: Interaction): Snowflake {
  return interactionUser(interaction).id || "0";
}

function hasAnyRole(roles: unknown, allowedRoleIds: Snowflake[]): boolean {
  return Array.isArray(roles) && allowedRoleIds.some((roleId) => roles.includes(roleId));
}

function hasTicketStaffAccess(interaction: Interaction, ticket: Ticket): boolean {
  const type = findType(ticket.typeId);
  return Boolean(type && hasAnyRole(interaction.member?.roles, ticketAccessRoleIds(type)));
}

function canInteractWithTicket(interaction: Interaction, ticket: Ticket): boolean {
  const userId = interactionUserId(interaction);
  if (isAdministrator(interaction) || userId === ticket.ownerId) return true;
  if (ticket.claimedBy) return ticket.claimedBy === userId;
  return hasTicketStaffAccess(interaction, ticket);
}

function isAdministrator(interaction: Interaction): boolean {
  try {
    const permissions = BigInt(interaction.member?.permissions || "0");
    return (permissions & 8n) === 8n;
  } catch {
    return false;
  }
}

function permissionOverwrite(
  id: Snowflake,
  type: 0 | 1,
  allow = 0,
  deny = 0
): Json {
  return { id, type, allow: String(allow), deny: String(deny) };
}

function ticketPermissionOverwrites(ticket: Ticket, claimedBy?: Snowflake): Json[] {
  const type = findType(ticket.typeId);
  const view = PERMISSIONS.VIEW_CHANNEL;
  const memberAccess = view | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.READ_MESSAGE_HISTORY;
  const staffAccess = memberAccess | PERMISSIONS.MANAGE_MESSAGES;
  const botAccess = staffAccess |
    PERMISSIONS.MANAGE_CHANNELS |
    PERMISSIONS.EMBED_LINKS |
    PERMISSIONS.ATTACH_FILES;
  const overwrites: Json[] = [
    permissionOverwrite(cfg().guildId, 0, 0, view),
    permissionOverwrite(ticket.ownerId, 1, memberAccess, 0)
  ];

  if (claimedBy) {
    overwrites.push(permissionOverwrite(claimedBy, 1, staffAccess, 0));
  } else {
    for (const roleId of ticketAccessRoleIds(type || TYPES[0])) {
      overwrites.push(permissionOverwrite(roleId, 0, staffAccess, 0));
    }
  }
  overwrites.push(permissionOverwrite(state.botId, 1, botAccess, 0));
  return overwrites;
}

function normalizedOverwrites(overwrites: Json[] | undefined): string[] {
  return (overwrites || [])
    .map((item) => `${item.id}:${item.type}:${item.allow || "0"}:${item.deny || "0"}`)
    .sort();
}

function overwritesEqual(left: Json[] | undefined, right: Json[]): boolean {
  const current = normalizedOverwrites(left);
  const expected = normalizedOverwrites(right);
  return current.length === expected.length && current.every((value, index) => value === expected[index]);
}

function mergeManagedPermissionOverwrites(
  current: Json[] | undefined,
  expected: Json[],
  ticket: Ticket,
  previousClaimedBy?: Snowflake
): Json[] {
  const type = findType(ticket.typeId);
  const managedIds = new Set<Snowflake>([
    cfg().guildId,
    state.botId,
    ticket.ownerId,
    ...(type ? ticketAccessRoleIds(type) : []),
    ...(previousClaimedBy ? [previousClaimedBy] : []),
    ...(ticket.claimedBy ? [ticket.claimedBy] : [])
  ]);
  const preserved = (current || []).filter((overwrite) => !managedIds.has(String(overwrite.id || "")));
  return [...preserved, ...expected];
}

async function synchronizeTicketPermissions(
  ticket: Ticket,
  currentOverwrites?: Json[],
  previousClaimedBy?: Snowflake
): Promise<boolean> {
  const expected = ticketPermissionOverwrites(ticket, ticket.claimedBy);
  let current = currentOverwrites;
  if (!current) {
    const channel = await discordRequest(`/channels/${ticket.channelId}`);
    current = channel?.permission_overwrites;
  }
  const merged = mergeManagedPermissionOverwrites(current, expected, ticket, previousClaimedBy);
  if (overwritesEqual(current, merged)) return false;
  await discordRequest(`/channels/${ticket.channelId}`, { method: "PATCH" }, {
    permission_overwrites: merged
  });
  return true;
}

async function interactionCallback(interaction: Interaction, type: number, data?: Json): Promise<void> {
  await discordRequest(`/interactions/${interaction.id}/${interaction.token}/callback`, { method: "POST" }, { type, data });
}

async function reply(interaction: Interaction, content: string, extra: Json = {}): Promise<void> {
  await interactionCallback(interaction, 4, { content, ...extra });
}

async function ephemeral(interaction: Interaction, content: string): Promise<void> {
  await reply(interaction, content, { flags: 64 });
}

async function defer(interaction: Interaction): Promise<void> {
  await interactionCallback(interaction, 5, { flags: 64 });
}

async function followup(interaction: Interaction, content: string): Promise<void> {
  await discordRequest(`/webhooks/${interaction.application_id}/${interaction.token}`, { method: "POST" }, { content, flags: 64 });
}

function modal(type: TicketType): Json {
  return {
    custom_id: `ticket_form_${type.typeId}`,
    title: `${BRAND} • ${type.buttonLabel}`.slice(0, 45),
    components: type.fields.map((field, index) => ({
      type: 1,
      components: [{
        type: 4,
        custom_id: `ticket_form_${type.typeId}_${index}`,
        style: field.style,
        label: field.label,
        required: field.required,
        max_length: field.maxLength
      }]
    }))
  };
}

function modalInputs(interaction: Interaction): Map<string, string> {
  const values = new Map<string, string>();
  for (const componentRow of interaction.data?.components || []) {
    for (const component of componentRow.components || []) {
      if (component.type === 4) values.set(component.custom_id, String(component.value || ""));
    }
  }
  return values;
}

function parseAnswers(type: TicketType, inputs: Map<string, string>): [string, string][] {
  return type.fields.map((field, index) => {
    const value = (inputs.get(`ticket_form_${type.typeId}_${index}`) || "").trim();
    if (field.required && !value) throw new Error(`Required field "${field.label}" is empty.`);
    if (value.length > field.maxLength) throw new Error(`Field "${field.label}" is too long.`);
    return [field.label, value];
  });
}

function ticketTopic(type: TicketType, ownerId: Snowflake, createdAt: number, claimedBy?: Snowflake): string {
  return `honeylua:v1;type=${type.typeId};owner=${ownerId};created=${createdAt};claimed=${claimedBy || ""}`;
}

async function updateTicketTopic(ticket: Ticket): Promise<void> {
  const type = findType(ticket.typeId) || TYPES[0];
  await discordRequest(`/channels/${ticket.channelId}`, { method: "PATCH" }, {
    topic: ticketTopic(type, ticket.ownerId, ticket.createdAt, ticket.claimedBy)
  });
}

function ticketControlPayload(ticket: Ticket, mention = false): Json {
  const type = findType(ticket.typeId) || TYPES[0];
  const fields = ticket.answers.map(([name, value]) => ({
    name: truncate(name, 256),
    value: truncate(value || "—", 1024),
    inline: false
  }));
  const status = ticket.claimedBy
    ? `Claimed by: <@${ticket.claimedBy}>.`
    : "This ticket is currently waiting for a staff member.";
  const components = ticket.claimedBy
    ? row([
      button("ticket_claim", "🔒 Claimed", 2, true),
      button("ticket_unclaim", "↩️ Release Ticket", 1),
      button("ticket_close", "🔴 Close Ticket", 4)
    ])
    : row([
      button("ticket_claim", "🔒 Claim Ticket", 2),
      button("ticket_close", "🔴 Close Ticket", 4)
    ]);
  return {
    content: mention ? ticketMention(type) : undefined,
    embeds: [{
      ...embed(
        `${type.emoji} ${BRAND} • ${type.buttonLabel}`,
        0x5865f2,
        `Welcome <@${ticket.ownerId}>! Your ${BRAND} support ticket is open. ${status}`
      ),
      fields
    }],
    components: [components]
  };
}

async function updateTicketControlMessage(ticket: Ticket): Promise<void> {
  if (!ticket.controlMessageId) return;
  await discordRequest(
    `/channels/${ticket.channelId}/messages/${ticket.controlMessageId}`,
    { method: "PATCH" },
    ticketControlPayload(ticket)
  );
}

async function loadGuildRoles(): Promise<void> {
  if (state.guildRoleLoad) return state.guildRoleLoad;
  const load = (async () => {
    try {
      const roles = await discordRequest(`/guilds/${cfg().guildId}/roles`);
      if (!Array.isArray(roles)) throw new Error("Discord returned an invalid role list.");
      state.guildRoleIds = new Set(roles.map((role) => role.id).filter(Boolean));
      state.guildRoleNames = new Map(roles.filter((role) => role?.id && role?.name).map((role) => [role.id, String(role.name)] as [Snowflake, string]));
      state.guildRolePermissions = new Map(
        roles
          .filter((role) => role?.id)
          .map((role) => [role.id, BigInt(role.permissions || "0")] as [Snowflake, bigint])
      );
      state.guildRolesLoaded = true;
    } catch (error) {
      state.guildRolesLoaded = false;
      state.guildRoleIds.clear();
      state.guildRoleNames.clear();
      state.guildRolePermissions.clear();
      log(`guild role discovery failed; ticket creation is paused to prevent insecure permissions`, error);
    }
  })();
  state.guildRoleLoad = load;
  try {
    await load;
  } finally {
    if (state.guildRoleLoad === load) state.guildRoleLoad = null;
  }
}

function memberDisplayLabel(userId: Snowflake): string {
  return state.memberNames.get(userId) || userId;
}

function renderRoleBadges(roleIds: unknown): string {
  if (!Array.isArray(roleIds)) return "";
  const badges = roleIds
    .filter((roleId) => roleId && roleId !== cfg().guildId)
    .map((roleId) => {
      const name = state.guildRoleNames.get(String(roleId));
      if (!name) return "";
      return "<span class=\"role-badge\" title=\"" + escapeHtml(name) + "\">@" + escapeHtml(name) + "</span>";
    })
    .filter(Boolean)
    .slice(0, 6)
    .join("");
  return badges ? "<div class=\"roles\">" + badges + "</div>" : "";
}

function cacheTranscriptMember(userId: Snowflake, label: string, roles: Snowflake[]): void {
  if (!state.memberRoles.has(userId) && state.memberRoles.size >= 2000) {
    const oldest = state.memberRoles.keys().next().value as Snowflake | undefined;
    if (oldest) {
      state.memberRoles.delete(oldest);
      state.memberNames.delete(oldest);
    }
  }
  if (label) state.memberNames.set(userId, label);
  state.memberRoles.set(userId, roles);
}

async function hydrateTranscriptMembers(messages: Json[], extraIds: Snowflake[] = []): Promise<void> {
  const ids = [...new Set([...messages.map((message) => String(message.author?.id || "")), ...extraIds])]
    .filter(Boolean)
    .filter((id) => !state.memberRoles.has(id));
  for (let offset = 0; offset < ids.length; offset += 5) {
    await Promise.all(ids.slice(offset, offset + 5).map(async (userId) => {
      try {
        const member = await discordRequest(`/guilds/${cfg().guildId}/members/${userId}`);
        const user = member?.user || {};
        const label = displayName(member, user);
        if (label) state.memberNames.set(userId, label);
        cacheTranscriptMember(userId, label, Array.isArray(member?.roles) ? member.roles : []);
      } catch (error) {
        cacheTranscriptMember(userId, "", []);
        log(`transcript member lookup failed for ${userId}`, error);
      }
    }));
  }
}

async function setupPanel(interaction: Interaction): Promise<void> {
  if (!isAdministrator(interaction)) {
    await ephemeral(interaction, "❌ Only administrators can use this command.");
    return;
  }
  const components = [
    row([button("ticket_open_script", "🎫 Script Support", 1)]),
    row([button("ticket_open_general", "🎧 General Support", 1)]),
    row([button("ticket_open_staff_report", "⚠️ Report a Staff Member", 1), button("ticket_open_user_report", "🚫 Report a User", 1)])
  ];
  await reply(interaction, "", {
    embeds: [{ ...embed(`🍯 ${SUPPORT_NAME}`, 0xf0b429, PANEL_DESCRIPTION), footer: { text: `${BRAND} • Support Center` } }],
    components
  });
}

function actionKey(interaction: Interaction): string | undefined {
  const customId = interaction.data?.custom_id || "";
  if (interaction.type === 2) return `command:${interaction.data?.name || ""}`;
  if (interaction.type === 3) {
    if (customId.startsWith("ticket_open_")) return "ticket_open";
    if (customId === "ticket_claim") return "ticket_claim";
    if (customId === "ticket_unclaim") return "ticket_unclaim";
    if (customId === "ticket_close") return "ticket_close";
    if (customId.startsWith("rate_")) return "rating";
  }
  if (interaction.type === 5) {
    if (customId.startsWith("rating_feedback_")) return "rating_feedback";
    if (customId.startsWith("ticket_form_")) return "ticket_form";
  }
  return undefined;
}

function checkActionCooldown(userId: Snowflake, action: string): number {
  const now = Date.now();
  const key = `${userId}:${action}`;
  const last = state.actionCooldowns.get(key) || 0;
  const remaining = cfg().actionCooldownMs - (now - last);
  if (remaining > 0) return Math.ceil(remaining / 1000);
  state.actionCooldowns.set(key, now);
  return 0;
}

async function createTicket(interaction: Interaction, type: TicketType, answers: [string, string][]): Promise<void> {
  const owner = interactionUser(interaction);
  const ownerId = owner.id;
  const now = Date.now();
  if (state.hydratingTickets) {
    await followup(interaction, "⏳ Honeylua is restoring open tickets. Please submit this form again in a moment.");
    return;
  }
  const createKey = `${ownerId}:${type.typeId}`;
  if (state.creatingUsers.has(ownerId)) {
    await followup(interaction, "⏳ A ticket for you is already being created. Please wait a moment.");
    return;
  }
  if (!state.guildRolesLoaded) await loadGuildRoles();
  if (!state.guildRolesLoaded) {
    await followup(interaction, "❌ This ticket type is temporarily unavailable because Discord role access could not be verified.");
    return;
  }
  const missingRoles = ticketAccessRoleIds(type).filter((roleId) => !state.guildRoleIds.has(roleId));
  if (missingRoles.length) {
    log(`cannot create ${type.typeId} ticket; missing role IDs: ${missingRoles.join(", ")}`);
    await followup(interaction, "❌ This report type is temporarily unavailable because a required Discord role no longer exists.");
    return;
  }
  const lastCreated = state.createCooldowns.get(ownerId) || 0;
  if (now - lastCreated < cfg().cooldownCreateMs) {
    await followup(interaction, `⏳ Please wait ${Math.ceil((cfg().cooldownCreateMs - (now - lastCreated)) / 1000)}s before creating another ticket.`);
    return;
  }
  let userOpen = 0;
  for (const ticket of state.tickets.values()) if (ticket.ownerId === ownerId) userOpen++;
  if (userOpen >= cfg().maxTicketsPerUser) {
    await followup(interaction, `❌ You reached the limit of ${cfg().maxTicketsPerUser} open tickets.`);
    return;
  }
  if (state.tickets.size + state.pendingCreations >= cfg().maxTicketsPerGuild) {
    await followup(interaction, "❌ The server reached the global ticket limit.");
    return;
  }

  state.creating.add(createKey);
  state.creatingUsers.add(ownerId);
  state.pendingCreations++;
  try {
    const draft: Ticket = {
      id: "",
      typeId: type.typeId,
      channelId: "",
      ownerId,
      ownerName: displayName(interaction.member, owner),
      answers,
      createdAt: now,
      lastActivity: now,
      reminderSent: false
    };
    const channel = await discordRequest(`/guilds/${cfg().guildId}/channels`, { method: "POST" }, {
      name: `${type.channelPrefix}${sanitizeChannelName(owner.username || "user")}`,
      type: 0,
      parent_id: cfg().ticketCategoryId,
      topic: ticketTopic(type, ownerId, now),
      permission_overwrites: ticketPermissionOverwrites(draft)
    });

    const ticket: Ticket = { ...draft, id: channel.id, channelId: channel.id };
    state.tickets.set(channel.id, ticket);
    state.createCooldowns.set(ownerId, now);

    await followup(interaction, `✅ Your ${BRAND} ticket was created in <#${channel.id}>.`);
    const logFields = [
      { name: "Type", value: type.buttonLabel, inline: true },
      { name: "Owner", value: `${ticket.ownerName} (<@${ownerId}>)`, inline: true },
      { name: "Channel", value: `<#${channel.id}>`, inline: true },
      { name: "Created at", value: discordTimestamp(now), inline: true },
      { name: "First answer", value: truncate(answers[0]?.[1] || "—", 1024), inline: false }
    ];
    const controlMessage = sendMessage(
      channel.id,
      ticketControlPayload(ticket, Boolean(type.mentionRoleIds?.length || cfg().mentionStaffOnCreate))
    ).then((message) => {
      ticket.controlMessageId = message?.id;
      return message;
    });
    await Promise.allSettled([
      controlMessage,
      sendMessage(cfg().logChannelId, {
        embeds: [{
          ...embed(`🎫 ${BRAND} • Ticket Created`, 0x57f28a),
          fields: logFields,
          footer: { text: `${BRAND} • Guild ${cfg().guildId}` }
        }]
      })
    ]);
  } finally {
    state.creating.delete(createKey);
    state.creatingUsers.delete(ownerId);
    state.pendingCreations = Math.max(0, state.pendingCreations - 1);
  }
}

async function claimTicket(ticket: Ticket, staffId: Snowflake): Promise<"claimed" | "already" | "missing"> {
  if (!state.tickets.has(ticket.channelId)) return "missing";
  if (ticket.claimedBy || state.claiming.has(ticket.channelId)) return "already";
  state.claiming.add(ticket.channelId);
  const previousClaim = ticket.claimedBy;
  const previousClaimedAt = ticket.claimedAt;
  ticket.claimedBy = staffId;
  ticket.claimedAt = Date.now();
  ticket.lastActivity = Date.now();
  ticket.reminderSent = false;
  try {
    await synchronizeTicketPermissions(ticket, undefined, previousClaim);
    await updateTicketTopic(ticket).catch((error) => log(`claim topic update failed in ${ticket.channelId}; permission state remains authoritative`, error));
  } catch (error) {
    ticket.claimedBy = previousClaim;
    ticket.claimedAt = previousClaimedAt;
    log(`claim permissions failed in ${ticket.channelId}`, error);
    throw error;
  } finally {
    state.claiming.delete(ticket.channelId);
  }
  await updateTicketControlMessage(ticket).catch((error) => log(`claim UI update failed in ${ticket.channelId}`, error));
  return "claimed";
}

async function handleClaim(interaction: Interaction): Promise<void> {
  const ticket = state.tickets.get(interaction.channel_id || "");
  if (!ticket) {
    await ephemeral(interaction, `❌ ${BRAND} ticket not found or already closed.`);
    return;
  }
  if (!isAdministrator(interaction) && !hasTicketStaffAccess(interaction, ticket)) {
    await ephemeral(interaction, "❌ You do not have permission to claim this ticket.");
    return;
  }
  if (interaction.message?.id) ticket.controlMessageId = interaction.message.id;
  if (ticket.claimedBy || state.claiming.has(ticket.channelId)) {
    await ephemeral(interaction, "⚠️ This ticket is already claimed by another team member.");
    return;
  }
  await defer(interaction);
  let result: "claimed" | "already" | "missing";
  try {
    result = await claimTicket(ticket, interactionUserId(interaction));
  } catch {
    await followup(interaction, "❌ The ticket could not be claimed because its Discord permissions could not be updated.");
    return;
  }
  if (result === "missing") {
    await followup(interaction, `❌ ${BRAND} ticket not found or already closed.`);
    return;
  }
  if (result === "already") {
    await followup(interaction, "⚠️ This ticket is already claimed by another team member.");
    return;
  }
  await followup(interaction, `🔒 Ticket claimed. <@${interactionUserId(interaction)}> is now responsible for this ticket.`);
  await sendClaimNotice(
    ticket,
    `🔒 ${BRAND} • Ticket Claimed`,
    0xf0b429,
    `<@${interactionUserId(interaction)}> is now handling this ticket. Other non-administrator staff members can no longer access it.`
  ).catch((error) => log("claim notice failed", error));
}

async function releaseTicket(ticket: Ticket): Promise<"released" | "already" | "missing"> {
  if (!state.tickets.has(ticket.channelId)) return "missing";
  if (!ticket.claimedBy || state.claiming.has(ticket.channelId)) return "already";
  state.claiming.add(ticket.channelId);
  const previousClaim = ticket.claimedBy;
  const previousClaimedAt = ticket.claimedAt;
  ticket.claimedBy = undefined;
  ticket.claimedAt = undefined;
  ticket.lastActivity = Date.now();
  ticket.reminderSent = false;
  try {
    await synchronizeTicketPermissions(ticket, undefined, previousClaim);
    await updateTicketTopic(ticket).catch((error) => log(`release topic update failed in ${ticket.channelId}; permission state remains authoritative`, error));
  } catch (error) {
    ticket.claimedBy = previousClaim;
    ticket.claimedAt = previousClaimedAt;
    log(`release permissions failed in ${ticket.channelId}`, error);
    throw error;
  } finally {
    state.claiming.delete(ticket.channelId);
  }
  await updateTicketControlMessage(ticket).catch((error) => log(`release UI update failed in ${ticket.channelId}`, error));
  return "released";
}

async function handleUnclaim(interaction: Interaction): Promise<void> {
  const ticket = state.tickets.get(interaction.channel_id || "");
  if (!ticket) {
    await ephemeral(interaction, `❌ ${BRAND} ticket not found or already closed.`);
    return;
  }
  if (!ticket.claimedBy) {
    await ephemeral(interaction, "⚠️ This ticket is not currently claimed.");
    return;
  }
  if (!isAdministrator(interaction)) {
    await ephemeral(interaction, "❌ Only administrators can release a claimed ticket.");
    return;
  }
  if (interaction.message?.id) ticket.controlMessageId = interaction.message.id;
  await defer(interaction);
  let result: "released" | "already" | "missing";
  try {
    result = await releaseTicket(ticket);
  } catch {
    await followup(interaction, "❌ The ticket could not be released because its Discord permissions could not be updated.");
    return;
  }
  if (result === "missing") {
    await followup(interaction, `❌ ${BRAND} ticket not found or already closed.`);
    return;
  }
  if (result === "already") {
    await followup(interaction, "⚠️ This ticket is not currently claimed.");
    return;
  }
  await followup(interaction, "↩️ Ticket released. The appropriate staff roles can access it again.");
  await sendClaimNotice(
    ticket,
    `↩️ ${BRAND} • Ticket Released`,
    0x57f28a,
    "The ticket is available for an authorized staff member to claim."
  ).catch((error) => log(`release notice failed in ${ticket.channelId}`, error));
}

function discordTimestamp(milliseconds: number, style: "t" | "T" | "d" | "D" | "f" | "F" | "R" = "F"): string {
  return `<t:${Math.floor(milliseconds / 1000)}:${style}>`;
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

async function fetchMessages(channelId: Snowflake, extraMemberIds: Snowflake[] = []): Promise<string[]> {
  const messages: string[] = [];
  let before = "";
  for (let page = 0; page < cfg().maxTranscriptPages; page++) {
    const query = before ? `?limit=100&before=${before}` : "?limit=100";
    const current = await discordRequest(`/channels/${channelId}/messages${query}`);
    if (!Array.isArray(current) || current.length === 0) break;
    // Render and release each REST page immediately. Keeping 5,000 raw
    // Discord message objects alive while also building HTML can cause a
    // large transient memory spike on a small server.
    await hydrateTranscriptMembers(current, extraMemberIds);
    messages.push(...current.map(renderMessage));
    if (current.length < 100) break;
    before = current[current.length - 1].id;
    await Bun.sleep(cfg().transcriptPageDelayMs);
  }
  messages.reverse();
  return messages;
}

const TRANSCRIPT_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
const TRANSCRIPT_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit" });

const TRANSCRIPT_CSS = `<style>
:root{color-scheme:dark;--bg:#0b0b0d;--surface:#111216;--surface-2:#17191e;--surface-3:#1d2026;--surface-4:#242832;--line:#2b3039;--line-soft:rgba(255,255,255,.07);--text:#f4f5f7;--muted:#969da9;--muted-2:#6f7682;--accent:#f0b429;--accent-strong:#ffd76a;--green:#4ade80;--red:#f87171;--blue:#7289da;--shadow:0 24px 70px rgba(0,0,0,.34)}
*{box-sizing:border-box}html{scroll-behavior:smooth;background:var(--bg)}body{margin:0;min-height:100vh;background:radial-gradient(900px 420px at 50% -120px,rgba(240,180,41,.12),transparent 68%),var(--bg);color:var(--text);font:14px/1.55 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}button,input{font:inherit}.shell{width:min(1120px,100%);margin:0 auto;padding:24px 18px 54px}a{color:inherit;text-decoration:none}a:hover{text-decoration:none}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:14px;margin:-24px -18px 22px;padding:12px 18px;border-bottom:1px solid var(--line-soft);background:rgba(11,11,13,.84);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}.brand{display:flex;align-items:center;gap:10px;font-weight:800}.brand-mark{display:grid;place-items:center;width:32px;height:32px;border:1px solid rgba(240,180,41,.35);border-radius:10px;background:rgba(240,180,41,.1);color:var(--accent-strong);font-size:15px}.brand small{display:block;color:var(--muted);font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase}.toolbar{display:flex;align-items:center;gap:8px}.search{width:min(300px,38vw);padding:8px 11px;border:1px solid var(--line);border-radius:9px;outline:0;background:var(--surface-2);color:var(--text)}.search:focus{border-color:rgba(240,180,41,.65);box-shadow:0 0 0 3px rgba(240,180,41,.08)}.tool-btn{padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--surface-2);color:var(--muted);cursor:pointer}.tool-btn:hover{border-color:#444b57;color:var(--text)}
.hero{position:relative;overflow:hidden;padding:26px;border:1px solid rgba(240,180,41,.18);border-radius:18px;background:linear-gradient(135deg,rgba(240,180,41,.10),rgba(17,18,22,.96) 42%);box-shadow:var(--shadow)}.hero:after{content:"";position:absolute;width:320px;height:320px;right:-180px;top:-210px;border:1px solid rgba(240,180,41,.15);border-radius:50%;box-shadow:0 0 0 32px rgba(240,180,41,.025),0 0 0 64px rgba(240,180,41,.018)}.eyebrow{color:var(--accent-strong);font-size:10px;font-weight:850;letter-spacing:.13em;text-transform:uppercase}.hero-row{position:relative;z-index:1;display:flex;align-items:flex-start;justify-content:space-between;gap:20px}.hero-title{display:flex;align-items:center;gap:12px}.ticket-icon{display:grid;place-items:center;width:44px;height:44px;border:1px solid rgba(240,180,41,.28);border-radius:13px;background:rgba(240,180,41,.10);font-size:20px}.hero h1{margin:5px 0 5px;font-size:clamp(25px,4vw,38px);line-height:1.1;letter-spacing:-.035em}.hero p{margin:0;color:#aeb4bd}.status{display:inline-flex;align-items:center;gap:7px;flex:0 0 auto;padding:7px 11px;border:1px solid rgba(74,222,128,.28);border-radius:999px;background:rgba(74,222,128,.08);color:var(--green);font-size:11px;font-weight:800}.status-dot{width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 12px currentColor}
.stats{position:relative;z-index:1;display:grid;grid-template-columns:repeat(4,1fr);gap:9px;margin-top:22px}.stat{min-width:0;padding:12px 13px;border:1px solid var(--line-soft);border-radius:11px;background:rgba(0,0,0,.14)}.stat-label{display:block;color:var(--muted-2);font-size:10px;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.stat-value{display:block;margin-top:2px;font-size:14px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:16px;margin-top:16px}.card{min-width:0;padding:20px;border:1px solid var(--line);border-radius:15px;background:linear-gradient(180deg,rgba(23,25,30,.98),rgba(17,18,22,.98));box-shadow:0 10px 34px rgba(0,0,0,.12)}.card+.card{margin-top:16px}.card-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}.card-heading h2{margin:3px 0 2px;font-size:18px;letter-spacing:-.02em}.card-heading p{margin:0;color:var(--muted);font-size:12px}.count{padding:4px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:10px;font-weight:800}
.details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.detail{padding:11px 12px;border:1px solid var(--line-soft);border-radius:10px;background:rgba(0,0,0,.12)}.detail-label{display:block;color:var(--muted-2);font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.detail-value{display:block;margin-top:4px;word-break:break-word}.mono{font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#c8cdd5}.copy-id{display:inline-flex;align-items:center;gap:5px;margin-left:5px;padding:2px 6px;border:1px solid var(--line);border-radius:5px;background:var(--surface-3);color:var(--muted);font-size:9px;cursor:pointer}.copy-id:hover{color:var(--text)}
.people{display:grid;gap:8px}.person{display:flex;align-items:center;gap:10px;padding:10px;border:1px solid var(--line-soft);border-radius:10px;background:rgba(0,0,0,.10)}.person-avatar{display:grid;place-items:center;flex:0 0 auto;width:34px;height:34px;border-radius:50%;border:1px solid var(--line);background:var(--surface-4);color:var(--accent-strong);font-weight:850}.person-main{min-width:0}.person-label{display:block;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.person-sub{display:block;margin-top:1px;color:var(--muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.person-role{margin-left:auto;padding:3px 6px;border-radius:6px;background:rgba(240,180,41,.09);color:var(--accent-strong);font-size:9px;font-weight:800}
.answers{display:grid;gap:9px}.answer{display:grid;grid-template-columns:28px 1fr;gap:10px;padding:12px;border:1px solid var(--line-soft);border-radius:11px;background:rgba(0,0,0,.11)}.answer-index{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:rgba(240,180,41,.11);color:var(--accent-strong);font-size:11px;font-weight:900}.answer-label{color:var(--muted);font-size:11px;font-weight:800}.answer-value{margin-top:3px;white-space:pre-wrap;word-break:break-word}.empty{padding:18px;border:1px dashed var(--line);border-radius:10px;color:var(--muted);text-align:center}
.timeline{position:relative}.date-separator{display:flex;align-items:center;gap:10px;margin:20px 0 11px;color:var(--muted-2);font-size:10px;font-weight:850;letter-spacing:.08em;text-transform:uppercase}.date-separator:before,.date-separator:after{content:"";height:1px;flex:1;background:var(--line-soft)}.msg{position:relative;padding:12px 13px;border:1px solid var(--line-soft);border-radius:12px;background:linear-gradient(135deg,rgba(255,255,255,.025),rgba(0,0,0,.12));margin:0 0 8px;transition:border-color .15s,background .15s}.msg:hover{border-color:rgba(240,180,41,.18);background:linear-gradient(135deg,rgba(255,255,255,.035),rgba(0,0,0,.13))}.msg.bot{border-left:2px solid rgba(114,137,218,.7)}.msg.highlight{border-color:rgba(240,180,41,.55);box-shadow:0 0 0 3px rgba(240,180,41,.06)}.message-head{display:flex;align-items:flex-start;gap:9px}.avatar{width:34px;height:34px;flex:0 0 auto;border:1px solid var(--line);border-radius:50%;background:var(--surface-4);object-fit:cover}.identity-wrap{min-width:0;flex:1}.identity{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}.author{font-weight:850;max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.uid{color:var(--muted-2);font:9px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.badge{padding:2px 5px;border-radius:4px;background:#5865f2;color:#fff;font-size:8px;font-weight:900;letter-spacing:.06em}.roles{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}.role-badge,.mention{display:inline-block;padding:2px 6px;border:1px solid rgba(240,180,41,.24);border-radius:5px;background:rgba(240,180,41,.08);color:#d9b75f;font-size:9px;font-weight:750}.message-meta{display:flex;align-items:center;gap:8px;flex:0 0 auto;color:var(--muted-2);font-size:10px}.ts{white-space:nowrap}.body{margin:8px 0 0 43px;color:#d9dde3;white-space:normal;word-break:break-word}.body code{padding:2px 4px;border-radius:4px;background:#0b0c0f;color:#f0f2f5;font:12px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.body .codeblock{display:block;margin:7px 0;padding:10px 11px;overflow:auto;border:1px solid var(--line);border-radius:8px;background:#0b0c0f;color:#d9dde3;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre}.reply{margin:8px 0 0 43px;padding:6px 9px;border-left:2px solid var(--blue);border-radius:0 6px 6px 0;background:rgba(114,137,218,.06);color:var(--muted);font-size:10px}.attachments,.embed-list{display:grid;gap:8px;margin:9px 0 0 43px}.attachment{display:flex;align-items:center;gap:9px;padding:9px 10px;border:1px solid var(--line);border-radius:9px;background:rgba(0,0,0,.14);word-break:break-word}.attachment-icon{display:grid;place-items:center;width:28px;height:28px;flex:0 0 auto;border-radius:7px;background:var(--surface-3);font-size:14px}.attachment-info{min-width:0;flex:1}.attachment-name{display:block;font-weight:750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.attachment-size{display:block;color:var(--muted-2);font-size:10px}.attachment-open{padding:5px 7px;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:9px;font-weight:800}.attachment-open:hover{color:var(--text)}.attachment-media-link{display:block}.attachment-image,.sticker-image{display:block;width:auto;max-width:min(680px,100%);max-height:420px;border:1px solid var(--line);border-radius:10px;object-fit:contain;background:#08090b}.sticker-image{max-width:250px;max-height:250px}.attachment-video{display:block;width:min(720px,100%);max-height:440px;border:1px solid var(--line);border-radius:10px;background:#08090b}.attachment-audio{display:block;width:min(680px,100%)}.attachment-media{display:grid;gap:6px}.attachment-fallback{color:var(--muted);font-size:10px}.embed-card{overflow:hidden;padding:12px 13px;border:1px solid rgba(88,101,242,.28);border-left:3px solid #7289da;border-radius:9px;background:linear-gradient(135deg,rgba(88,101,242,.10),rgba(88,101,242,.025))}.embed-author{color:#aeb8ff;font-size:9px;font-weight:850;letter-spacing:.08em;text-transform:uppercase}.embed-title{display:block;margin-top:2px;font-size:14px;font-weight:850}.embed-description{margin-top:5px;color:#d9dce3;white-space:pre-wrap;word-break:break-word}.embed-field-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;margin-top:9px}.embed-field{padding:8px;border-radius:7px;background:rgba(0,0,0,.14)}.embed-field strong{display:block;color:#c7cbff;font-size:9px}.embed-field span{display:block;margin-top:2px;white-space:pre-wrap;word-break:break-word;font-size:11px}.embed-image{display:block;width:100%;max-height:380px;margin-top:10px;border-radius:7px;object-fit:contain;background:#08090b}.reactions{display:flex;flex-wrap:wrap;gap:5px;margin:9px 0 0 43px}.reaction{padding:3px 7px;border:1px solid var(--line);border-radius:7px;background:var(--surface-3);color:var(--muted);font-size:10px}.reaction strong{color:var(--text)}
.footer{padding:22px 0 0;color:var(--muted-2);text-align:center;font-size:10px}.footer strong{color:var(--accent-strong)}.hidden{display:none!important}.no-results{display:none;padding:20px;color:var(--muted);text-align:center}.no-results.show{display:block}
@media(max-width:860px){.grid{grid-template-columns:1fr}.search{width:min(260px,42vw)}}@media(max-width:650px){.shell{padding:12px 10px 38px}.topbar{margin:-12px -10px 14px;padding:10px}.brand span:not(.brand-mark){display:none}.toolbar{width:100%}.search{width:100%;max-width:none}.tool-btn{display:none}.hero{padding:20px 17px}.hero-row{display:block}.status{margin-top:14px}.stats{grid-template-columns:repeat(2,1fr)}.card{padding:15px}.details{grid-template-columns:1fr}.card-heading{display:block}.count{display:inline-block;margin-top:8px}.message-meta{width:100%;margin-left:43px}.body,.reply,.attachments,.embed-list,.reactions{margin-left:43px}.embed-field-grid{grid-template-columns:1fr}.author{max-width:160px}.uid{display:none}}
</style>`;

const TRANSCRIPT_SCRIPT = `<script>
(function(){
  const q=document.getElementById('message-search');
  const msgs=[...document.querySelectorAll('.msg')];
  const no=document.getElementById('no-results');
  if(q){q.addEventListener('input',function(){const term=this.value.trim().toLowerCase();let visible=0;msgs.forEach(function(m){const hit=!term||m.textContent.toLowerCase().includes(term);m.classList.toggle('hidden',!hit);if(hit)visible++;});if(no)no.classList.toggle('show',visible===0);});}
  document.querySelectorAll('[data-copy]').forEach(function(btn){btn.addEventListener('click',async function(){const value=this.getAttribute('data-copy')||'';try{await navigator.clipboard.writeText(value);this.textContent='Copied';setTimeout(()=>this.textContent='Copy',1200);}catch{this.textContent='Select manually';}});});
  let previousDate='';msgs.forEach(function(m){const date=m.getAttribute('data-date')||'';if(date&&date!==previousDate){const sep=document.createElement('div');sep.className='date-separator';const d=new Date(date+'T12:00:00');sep.textContent=Number.isNaN(d.getTime())?date:d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric',year:'numeric'});m.parentNode.insertBefore(sep,m);previousDate=date;}});
  const top=document.getElementById('top');const latest=document.getElementById('latest');
  if(latest)latest.addEventListener('click',()=>{const last=msgs[msgs.length-1];if(last){last.scrollIntoView({behavior:'smooth',block:'center'});last.classList.add('highlight');setTimeout(()=>last.classList.remove('highlight'),1400);}});
  if(top)top.addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'}));
  document.querySelectorAll('img[data-fallback]').forEach(function(img){img.addEventListener('error',function(){this.style.display='none';const f=this.nextElementSibling;if(f)f.classList.remove('hidden');},{once:true});});
})();
</script>`;

function formatTranscriptDate(value: string | number | undefined): string {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "Unknown time" : TRANSCRIPT_DATE_FORMATTER.format(date);
}

function formatTranscriptTime(value: string | number | undefined): string {
  const date = new Date(value || "");
  return Number.isNaN(date.getTime()) ? "Unknown" : TRANSCRIPT_TIME_FORMATTER.format(date);
}

function formatBytes(value: unknown): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function transcriptUrl(value: unknown): string {
  const url = String(value || "");
  return url.startsWith("https://") || url.startsWith("http://") ? url : "#";
}

function transcriptStat(label: string, value: string): string {
  return `<div class="stat"><span class="stat-label">${escapeHtml(label)}</span><span class="stat-value">${escapeHtml(value)}</span></div>`;
}

function transcriptDetail(label: string, value: string, mono = false): string {
  return `<div class="detail"><span class="detail-label">${escapeHtml(label)}</span><span class="detail-value${mono ? " mono" : ""}">${escapeHtml(value)}</span></div>`;
}

function transcriptInitial(label: string): string {
  const clean = String(label || "?").trim();
  return escapeHtml((clean[0] || "?").toUpperCase());
}

function transcriptPerson(role: string, label: string, id: string): string {
  return `<div class="person"><div class="person-avatar">${transcriptInitial(label)}</div><div class="person-main"><span class="person-label">${escapeHtml(label)}</span><span class="person-sub">${escapeHtml(id || "—")}</span></div><span class="person-role">${escapeHtml(role)}</span></div>`;
}

function renderTranscriptEmbed(embedData: Json): string {
  const title = String(embedData.title || "").trim();
  const description = String(embedData.description || "").trim();
  const author = String(embedData.author?.name || "").trim();
  const embedUrl = transcriptUrl(embedData.url);
  const imageUrl = transcriptUrl(embedData.image?.url || embedData.thumbnail?.url);
  const fields = Array.isArray(embedData.fields) ? embedData.fields : [];
  const footer = String(embedData.footer?.text || "").trim();
  if (!title && !description && !author && !fields.length && imageUrl === "#" && !footer) return "";
  let html = "<div class=\"embed-card\">";
  if (author) html += `<div class="embed-author">${escapeHtml(author)}</div>`;
  if (title) html += embedUrl !== "#" ? `<a class="embed-title" href="${escapeHtml(embedUrl)}" target="_blank" rel="noreferrer">${escapeHtml(title)}</a>` : `<div class="embed-title">${escapeHtml(title)}</div>`;
  if (description) html += `<div class="embed-description">${escapeHtml(description)}</div>`;
  if (fields.length) {
    html += `<div class="embed-field-grid">`;
    for (const field of fields) html += `<div class="embed-field"><strong>${escapeHtml(String(field.name || "Field"))}</strong><span>${escapeHtml(String(field.value || ""))}</span></div>`;
    html += `</div>`;
  }
  if (imageUrl !== "#") html += `<a href="${escapeHtml(imageUrl)}" target="_blank" rel="noreferrer"><img class="embed-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(title || "Embed image")}" loading="lazy" referrerpolicy="no-referrer"></a>`;
  if (footer) html += `<div class="attachment-fallback">${escapeHtml(footer)}</div>`;
  return html + "</div>";
}

function renderTranscriptBody(content: string): string {
  let body = escapeHtml(content);
  body = body.replace(/```([\s\S]*?)```/g, (_match, code) => `<code class="codeblock">${code.trim()}</code>`);
  body = body.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  body = body.replace(/&lt;(a?):([a-zA-Z0-9_~]+):(\d{15,25})&gt;/g, (_match, animated, name, id) => {
    const ext = animated ? "gif" : "png";
    return `<img src="https://cdn.discordapp.com/emojis/${id}.${ext}?size=32" alt=":${escapeHtml(name)}:" title=":${escapeHtml(name)}:" style="width:20px;height:20px;vertical-align:-5px;object-fit:contain">`;
  });
  body = body.replace(/&lt;@&amp;(\d+)&gt;/g, (_match, roleId) => {
    const roleName = state.guildRoleNames.get(roleId);
    return roleName ? `<span class="mention">@${escapeHtml(roleName)}</span>` : `<span class="mention">@Role</span>`;
  });
  body = body.replace(/&lt;@!?(\d+)&gt;/g, (_match, userId) => `<span class="mention">@${escapeHtml(state.memberNames.get(userId) || "user")}</span>`);
  body = body.replace(/&lt;#(\d+)&gt;/g, `<span class="mention">#channel</span>`);
  body = body.replace(/&lt;t:(\d+)(?::([tTdDfFR]))?&gt;/g, (_match, seconds, style) => `<span class="mention">${escapeHtml(formatTranscriptDate(Number(seconds) * 1000))}</span>`);
  body = body.replace(/(https?:\/\/[^\s<&]+)/g, `<a href="$1" target="_blank" rel="noreferrer" style="color:var(--accent-strong)">$1</a>`);
  body = body.replaceAll(String.fromCharCode(10), "<br>");
  return body;
}

function renderAttachment(attachment: Json): string {
  const url = transcriptUrl(attachment.url || attachment.proxy_url);
  const filename = String(attachment.filename || "Attachment");
  const size = formatBytes(attachment.size);
  const contentType = String(attachment.content_type || "").toLowerCase();
  const safeUrl = escapeHtml(url);
  const safeFilename = escapeHtml(filename);
  const sizeHtml = size ? `<span class="attachment-size">${escapeHtml(size)}</span>` : `<span class="attachment-size">Attachment</span>`;
  const open = url !== "#" ? `<a class="attachment-open" href="${safeUrl}" target="_blank" rel="noreferrer">Open</a>` : "";
  if (url === "#") return `<div class="attachment"><span class="attachment-icon">📎</span><div class="attachment-info"><span class="attachment-name">${safeFilename}</span>${sizeHtml}</div></div>`;
  const isImage = contentType.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(filename);
  if (isImage) return `<div class="attachment-media"><a class="attachment-media-link" href="${safeUrl}" target="_blank" rel="noreferrer"><img data-fallback="1" class="attachment-image" src="${safeUrl}" alt="${safeFilename}" loading="lazy" referrerpolicy="no-referrer"><div class="attachment hidden">🖼️ ${safeFilename}</div></a><div class="attachment"><span class="attachment-icon">🖼️</span><div class="attachment-info"><span class="attachment-name">${safeFilename}</span>${sizeHtml}</div>${open}</div></div>`;
  const isVideo = contentType.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogv)$/i.test(filename);
  if (isVideo) return `<div class="attachment-media"><video class="attachment-video" controls preload="metadata" playsinline src="${safeUrl}"></video><div class="attachment"><span class="attachment-icon">🎬</span><div class="attachment-info"><span class="attachment-name">${safeFilename}</span>${sizeHtml}</div>${open}</div></div>`;
  const isAudio = contentType.startsWith("audio/") || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(filename);
  if (isAudio) return `<div class="attachment-media"><audio class="attachment-audio" controls preload="metadata" src="${safeUrl}"></audio><div class="attachment"><span class="attachment-icon">🎵</span><div class="attachment-info"><span class="attachment-name">${safeFilename}</span>${sizeHtml}</div>${open}</div></div>`;
  return `<div class="attachment"><span class="attachment-icon">📎</span><div class="attachment-info"><span class="attachment-name">${safeFilename}</span>${sizeHtml}</div>${open}</div>`;
}

function stickerUrl(sticker: Json): string {
  const id = String(sticker.id || "").trim();
  const formatType = Number(sticker.format_type);
  if (!/^\d{15,25}$/.test(id)) return "#";
  if (formatType === 1 || formatType === 2) return `https://cdn.discordapp.com/stickers/${id}.png`;
  if (formatType === 4) return `https://cdn.discordapp.com/stickers/${id}.gif`;
  return "#";
}

function renderSticker(sticker: Json): string {
  const url = stickerUrl(sticker);
  const name = String(sticker.name || "Discord sticker");
  if (url === "#") return `<div class="attachment"><span class="attachment-icon">🖼️</span><div class="attachment-info"><span class="attachment-name">${escapeHtml(name)}</span><span class="attachment-size">Sticker</span></div></div>`;
  return `<div class="attachment-media"><a class="attachment-media-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer"><img class="sticker-image" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy" referrerpolicy="no-referrer"></a></div>`;
}

function renderReactions(reactions: unknown): string {
  if (!Array.isArray(reactions) || !reactions.length) return "";
  const items = reactions.map((reaction: Json) => {
    const emoji = reaction.emoji?.name || "👍";
    const count = Number(reaction.count || 0);
    return `<span class="reaction">${escapeHtml(String(emoji))} <strong>${count}</strong></span>`;
  }).join("");
  return items ? `<div class="reactions">${items}</div>` : "";
}

function renderMessage(message: Json): string {
  const author = message.author || {};
  const avatar = author.avatar ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=64` : "https://cdn.discordapp.com/embed/avatars/0.png";
  const name = author.global_name || author.username || "user";
  const timestamp = String(message.timestamp || "");
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const attachmentHtml = attachments.map((attachment: Json) => renderAttachment(attachment)).join("");
  const stickers = Array.isArray(message.sticker_items) ? message.sticker_items : [];
  const stickerHtml = stickers.map((sticker: Json) => renderSticker(sticker)).join("");
  const embedHtml = (Array.isArray(message.embeds) ? message.embeds : []).map(renderTranscriptEmbed).filter(Boolean).join("");
  const body = message.content?.trim()
    ? renderTranscriptBody(String(message.content))
    : attachmentHtml || stickerHtml || embedHtml
      ? "<span class=\"muted\">Media-only message</span>"
      : "<span class=\"muted\">No text content</span>";
  const botBadge = author.bot ? "<span class=\"badge\">BOT</span>" : "";
  const roles = renderRoleBadges(state.memberRoles.get(String(author.id || "")) || []);
  const reply = message.referenced_message?.author ? `<div class="reply">Replying to <strong>${escapeHtml(message.referenced_message.author.global_name || message.referenced_message.author.username || "user")}</strong></div>` : "";
  const reactions = renderReactions(message.reactions);
  return `<article class="msg${author.bot ? " bot" : ""}" data-message-id="${escapeHtml(String(message.id || ""))}" data-date="${escapeHtml(timestamp.slice(0, 10))}"><div class="message-head"><img class="avatar" src="${escapeHtml(avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer"><div class="identity-wrap"><div class="identity"><span class="author">${escapeHtml(name)}</span>${botBadge}<span class="uid">${escapeHtml(author.id || "")}</span></div>${roles}</div><div class="message-meta"><time class="ts" datetime="${escapeHtml(timestamp)}">${escapeHtml(formatTranscriptTime(timestamp))}</time></div></div>${reply}<div class="body">${body}</div>${attachmentHtml || stickerHtml ? `<div class="attachments">${attachmentHtml}${stickerHtml}</div>` : ""}${embedHtml ? `<div class="embed-list">${embedHtml}</div>` : ""}${reactions}</article>`;
}

function transcriptByteLength(html: string): number {
  return new TextEncoder().encode(html).byteLength;
}

function fitTranscriptToUploadBudget(
  ticket: Ticket,
  messages: string[],
  reason: string,
  closedBy?: Snowflake
): { html: string; omitted: number } {
  const full = buildTranscript(ticket, messages, reason, closedBy, false);
  if (transcriptByteLength(full) <= cfg().maxTranscriptBytes) return { html: full, omitted: 0 };

  let low = 0;
  let high = messages.length;
  let best = "";
  let bestKeep = 0;
  while (low <= high) {
    const keep = Math.floor((low + high) / 2);
    const candidate = buildTranscript(ticket, messages.slice(Math.max(0, messages.length - keep)), reason, closedBy, true, messages.length - keep);
    if (transcriptByteLength(candidate) <= cfg().maxTranscriptBytes) {
      best = candidate;
      bestKeep = keep;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  if (!best) {
    best = buildTranscript(ticket, [], reason, closedBy, true, messages.length);
  }
  return { html: best, omitted: Math.max(0, messages.length - bestKeep) };
}

function buildTranscript(ticket: Ticket, messages: string[], reason: string, closedBy?: Snowflake, truncated = false, omittedMessages = 0): string {
  const type = findType(ticket.typeId);
  const closedAt = Date.now();
  const claimed = ticket.claimedBy ? memberDisplayLabel(ticket.claimedBy) : "Unclaimed";
  const closeUser = closedBy ? memberDisplayLabel(closedBy) : "System";
  const ownerLabel = memberDisplayLabel(ticket.ownerId);
  const typeLabel = type?.buttonLabel || ticket.typeId;
  const statusLabel = reason.startsWith("automatic") ? "Closed automatically" : "Closed manually";
  const answerCount = ticket.answers.filter(([, value]) => Boolean(value.trim())).length;
  const omissionNotice = truncated && omittedMessages > 0 ? `<div class="empty" style="margin-bottom:12px">⚠️ ${omittedMessages} older message(s) were omitted from this HTML copy to keep the transcript within the upload limit. The newest messages were preserved.</div>` : "";
  const duration = formatDuration(closedAt - ticket.createdAt);
  const statusClass = reason.startsWith("automatic") ? "Closed automatically" : "Closed";
  let html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="description" content="${escapeHtml(BRAND)} support ticket transcript ${escapeHtml(ticket.id)}"><title>${escapeHtml(BRAND)} · Ticket ${escapeHtml(ticket.id)}</title>${TRANSCRIPT_CSS}</head><body><main class="shell"><nav class="topbar"><div class="brand"><span class="brand-mark">🍯</span><span>${escapeHtml(BRAND)}<small>Support transcript</small></span></div><div class="toolbar"><input id="message-search" class="search" type="search" placeholder="Search messages…" aria-label="Search messages"><button id="latest" class="tool-btn" type="button">Latest</button><button id="top" class="tool-btn" type="button">Top</button></div></nav><header class="hero"><div class="hero-row"><div><div class="hero-title"><span class="ticket-icon">🎫</span><div><div class="eyebrow">${escapeHtml(typeLabel)}</div><h1>Ticket ${escapeHtml(ticket.id)}</h1></div></div><p>Complete support record with intake answers, ownership and the full conversation history.</p></div><span class="status"><span class="status-dot"></span>${escapeHtml(statusClass)}</span></div><div class="stats">${transcriptStat("Messages",String(messages.length))}${transcriptStat("Duration",duration)}${transcriptStat("Answers",String(answerCount))}${transcriptStat("Closed",formatTranscriptDate(closedAt))}</div></header>`;
  html += `<div class="grid"><div><section class="card"><div class="card-heading"><div><div class="eyebrow">Conversation</div><h2>Message timeline</h2><p>Chronological messages, media, embeds, reactions and role context.</p></div><span class="count">${messages.length} messages</span></div><div id="timeline" class="timeline">${omissionNotice}${messages.length ? messages.join("") : "<div class=\"empty\">No messages were captured before the ticket was closed.</div>"}<div id="no-results" class="no-results">No messages match your search.</div></div></section></div><aside><section class="card"><div class="card-heading"><div><div class="eyebrow">Ticket details</div><h2>Context & ownership</h2></div></div><div class="details">${transcriptDetail("Type",typeLabel)}${transcriptDetail("Reason",reason)}${transcriptDetail("Created",formatTranscriptDate(ticket.createdAt))}${transcriptDetail("Closed",formatTranscriptDate(closedAt))}${transcriptDetail("Ticket ID",ticket.id,true)}<div class="detail"><span class="detail-label">Ticket ID actions</span><button class="copy-id" type="button" data-copy="${escapeHtml(ticket.id)}">Copy</button></div></div></section><section class="card"><div class="card-heading"><div><div class="eyebrow">People</div><h2>Ownership</h2></div></div><div class="people">${transcriptPerson("Owner",ownerLabel,ticket.ownerId)}${transcriptPerson("Claimed by",claimed,ticket.claimedBy || "—")}${transcriptPerson("Closed by",closeUser,closedBy || "system")}</div></section><section class="card"><div class="card-heading"><div><div class="eyebrow">Intake</div><h2>Submitted answers</h2></div><span class="count">${answerCount}</span></div>`;
  if (!ticket.answers.length) html += `<div class="empty">No answers were recorded for this ticket.</div>`;
  else {
    html += `<div class="answers">`;
    let index = 1;
    for (const [label, value] of ticket.answers) html += `<div class="answer"><div class="answer-index">${index++}</div><div><div class="answer-label">${escapeHtml(label)}</div><div class="answer-value">${escapeHtml(value || "—")}</div></div></div>`;
    html += `</div>`;
  }
  html += `</section></aside></div><footer class="footer">Generated by <strong>${escapeHtml(BRAND)} Support</strong> · Ticket <span class="mono">${escapeHtml(ticket.id)}</span> · Transcript format v2</footer></main>${TRANSCRIPT_SCRIPT}</body></html>`;
  return html;
}

function ratingButtons(ticketId: Snowflake, disabled = false): Json {
  return row([1, 2, 3, 4, 5].map((stars) => button(`rate_${ticketId}_${stars}`, "⭐".repeat(stars), 2, disabled)));
}

async function disableRatingMessage(interaction: Interaction, ticketId: Snowflake): Promise<void> {
  if (!interaction.channel_id || !interaction.message?.id) return;
  await discordRequest(`/channels/${interaction.channel_id}/messages/${interaction.message.id}`, { method: "PATCH" }, {
    components: [ratingButtons(ticketId, true)]
  }).catch((error) => log(`rating button update failed for ${ticketId}`, error));
}

async function sendRating(ticket: Ticket, html: string): Promise<void> {
  if (state.ratings.has(ticket.id) || state.ratingInProgress.has(ticket.id) || state.completedRatings.has(ticket.id)) return;
  const channel = await discordRequest(`/users/@me/channels`, { method: "POST" }, { recipient_id: ticket.ownerId });
  await sendMessage(channel.id, {
    embeds: [{
      ...embed(`🍯 ${BRAND} • Rate Support`, 0xf0b429, "How did we do? Tap a star to rate the support you received. You can add optional feedback after choosing a rating."),
      fields: [
        { name: "Ticket", value: ticket.id, inline: true },
        { name: "Type", value: ticket.typeId, inline: true }
      ]
    }],
    components: [ratingButtons(ticket.id)]
  }, { name: `honeylua-transcript-${ticket.id}.html`, content: html });
  state.ratings.set(ticket.id, {
    ticketId: ticket.id,
    ownerId: ticket.ownerId,
    channelId: ticket.channelId,
    claimedBy: ticket.claimedBy,
    createdAt: Date.now()
  });
}

async function closeTicket(ticket: Ticket, reason: string, closedBy?: Snowflake): Promise<void> {
  if (state.closing.has(ticket.channelId)) return;
  state.closing.add(ticket.channelId);
  if (state.tickets.get(ticket.channelId) !== undefined) state.tickets.delete(ticket.channelId);
  try {
    const messages = await fetchMessages(ticket.channelId, [ticket.ownerId, ticket.claimedBy || "", closedBy || ""]).catch((error) => {
      log(`message pagination failed in ${ticket.channelId}`, error);
      return [];
    });
    const { html, omitted } = fitTranscriptToUploadBudget(ticket, messages, reason, closedBy);
    if (omitted > 0) log(`transcript ${ticket.channelId} omitted ${omitted} older message(s) to fit the upload budget`);
    await sendMessage(cfg().transcriptChannelId, {
      embeds: [{
        ...embed(`📄 ${BRAND} • Ticket Transcript`, 0x5865f2),
        fields: [
          { name: "Ticket", value: ticket.id, inline: true },
          { name: "Type", value: ticket.typeId, inline: true },
          { name: "Owner", value: `${ticket.ownerName} (${ticket.ownerId})`, inline: true },
          { name: "Claimed by", value: ticket.claimedBy || "—", inline: true },
          { name: "Closed by", value: closedBy || "system", inline: true },
          { name: "Reason", value: reason, inline: true },
          { name: "Messages", value: String(messages.length), inline: true },
          { name: "Duration", value: formatDuration(Date.now() - ticket.createdAt), inline: true }
        ]
      }]
    }, { name: `transcript-${ticket.id}.html`, content: html }).catch((error) => log(`transcript send failed for ${ticket.id}`, error));
    await sendRating(ticket, html).catch((error) => log(`rating DM failed for ${ticket.id}`, error));
    await sendMessage(cfg().logChannelId, {
      embeds: [{
        ...embed(reason === "manual" ? `🔴 ${BRAND} • Closed Manually` : `🔴 ${BRAND} • Closed Automatically`, 0xed4245),
        fields: [
          { name: "Ticket", value: ticket.id, inline: true },
          { name: "Type", value: ticket.typeId, inline: true },
          { name: "Owner", value: `${ticket.ownerName} (<@${ticket.ownerId}>)`, inline: true },
          { name: "Closed by", value: closedBy ? `<@${closedBy}>` : "system (timeout)", inline: true },
          { name: "Messages", value: String(messages.length), inline: true },
          { name: "Closed at", value: discordTimestamp(Date.now()), inline: true }
        ]
      }]
    }).catch((error) => log(`close log failed for ${ticket.id}`, error));
    await sendMessage(ticket.channelId, {
      embeds: [embed(`🗑️ ${BRAND} • Closing`, 0x95a5a6, "This channel will be deleted in 10 seconds. The transcript has already been saved.")]
    }).catch((error) => log(`countdown failed in ${ticket.channelId}`, error));
    await Bun.sleep(10000);
    await discordRequest(`/channels/${ticket.channelId}`, { method: "DELETE" }, undefined)
      .catch((error) => log(`delete channel failed for ${ticket.channelId}`, error));
  } finally {
    state.closing.delete(ticket.channelId);
  }
}

async function handleClose(interaction: Interaction): Promise<void> {
  const ticket = state.tickets.get(interaction.channel_id || "");
  if (!ticket) {
    await ephemeral(interaction, `❌ ${BRAND} ticket not found or already closed.`);
    return;
  }
  if (!canInteractWithTicket(interaction, ticket)) {
    await ephemeral(interaction, "❌ You no longer have permission to interact with this ticket.");
    return;
  }
  await defer(interaction);
  void closeTicket(ticket, "manual", interactionUserId(interaction)).catch((error) => log("manual close failed", error));
}

function feedbackModal(ticketId: Snowflake): Json {
  return {
    custom_id: `rating_feedback_${ticketId}`,
    title: `${BRAND} • Optional Feedback`.slice(0, 45),
    components: [{
      type: 1,
      components: [{
        type: 4,
        custom_id: "rating_feedback_text",
        style: 2,
        label: "Tell us more (optional)",
        required: false,
        max_length: 1000
      }]
    }]
  };
}

function ratingLog(userId: Snowflake, stars: number, pending: RatingPending): Json {
  return {
    ...embed(`⭐ ${BRAND} • Rating Received`, 0x9b59b6),
    fields: [
      { name: "User", value: `<@${userId}>`, inline: true },
      { name: "Rating", value: `${stars}/5`, inline: true },
      { name: "Ticket", value: pending.ticketId, inline: true },
      { name: "Channel", value: `<#${pending.channelId}>`, inline: true },
      { name: "Handled by", value: pending.claimedBy ? `<@${pending.claimedBy}>` : "no claim", inline: true }
    ],
    footer: { text: `${BRAND} • Guild ${cfg().guildId}` }
  };
}

function feedbackLog(userId: Snowflake, pending: RatingPending, feedback: string): Json {
  return {
    ...embed(`💬 ${BRAND} • Feedback Received`, 0x9b59b6),
    fields: [
      { name: "User", value: `<@${userId}>`, inline: true },
      { name: "Ticket", value: pending.ticketId, inline: true },
      { name: "Channel", value: `<#${pending.channelId}>`, inline: true },
      { name: "Handled by", value: pending.claimedBy ? `<@${pending.claimedBy}>` : "no claim", inline: true },
      { name: "Feedback", value: truncate(feedback, 1024), inline: false }
    ],
    footer: { text: `${BRAND} • Guild ${cfg().guildId}` }
  };
}

async function handleRatingClick(interaction: Interaction, stars: number, ticketId: Snowflake): Promise<void> {
  const userId = interactionUserId(interaction);
  if (state.completedRatings.has(ticketId) || state.ratingInProgress.has(ticketId)) {
    await ephemeral(interaction, "⚠️ This ticket has already been rated.");
    return;
  }
  const pending = state.ratings.get(ticketId);
  if (!pending || pending.ownerId !== userId) {
    await ephemeral(interaction, "⚠️ This ticket rating is expired or does not belong to you.");
    return;
  }
  state.ratings.delete(ticketId);
  state.completedRatings.set(ticketId, Date.now());
  state.ratingInProgress.set(ticketId, { ...pending, stars, createdAt: Date.now() });
  void sendMessage(cfg().logChannelId, { embeds: [ratingLog(userId, stars, pending)] }).catch((error) => log("rating log failed", error));
  void disableRatingMessage(interaction, ticketId);
  await interactionCallback(interaction, 9, feedbackModal(ticketId));
}

async function handleFeedback(interaction: Interaction, ticketId: Snowflake): Promise<void> {
  const userId = interactionUserId(interaction);
  const progress = state.ratingInProgress.get(ticketId);
  if (!progress || progress.ownerId !== userId) {
    await ephemeral(interaction, "⚠️ This feedback form is expired or does not belong to you.");
    return;
  }
  state.ratingInProgress.delete(ticketId);
  const feedback = modalInputs(interaction).get("rating_feedback_text")?.trim() || "";
  if (feedback) {
    void sendMessage(cfg().logChannelId, {
      embeds: [feedbackLog(userId, progress, feedback)]
    }).catch((error) => log("feedback log failed", error));
  }
  await ephemeral(interaction, feedback
    ? `⭐ Thank you! Your ${BRAND} rating and feedback were recorded.`
    : `⭐ Thank you! Your ${BRAND} rating was recorded.`);
}

async function handleModalSubmit(interaction: Interaction): Promise<void> {
  const customId = interaction.data?.custom_id || "";
  if (customId.startsWith("rating_feedback_")) {
    const ticketId = customId.slice("rating_feedback_".length);
    await handleFeedback(interaction, ticketId);
    return;
  }
  const type = findType(customId.replace("ticket_form_", ""));
  if (!type) return;
  try {
    const answers = parseAnswers(type, modalInputs(interaction));
    await defer(interaction);
    await createTicket(interaction, type, answers);
  } catch (error: any) {
    log("ticket creation failed", error);
    await followup(interaction, `❌ ${error.message || "Could not create the ticket."}`).catch(() => {});
  }
}

async function handleInteraction(interaction: Interaction): Promise<void> {
  if (state.applicationId && interaction.application_id !== state.applicationId) return;
  const customId = interaction.data?.custom_id || "";
  const isDmRating = interaction.guild_id === undefined &&
    (customId.startsWith("rate_") || customId.startsWith("rating_feedback_"));
  if (interaction.guild_id !== cfg().guildId && !isDmRating) {
    await ephemeral(interaction, `❌ ${BRAND} Support is only available in the configured server.`).catch(() => {});
    return;
  }
  const key = actionKey(interaction);
  if (key) {
    const remaining = checkActionCooldown(interactionUserId(interaction), key);
    if (remaining) {
      await ephemeral(interaction, `⏳ Please wait ${remaining}s before repeating this action.`).catch(() => {});
      return;
    }
  }
  try {
    if (interaction.type === 2 && interaction.data?.name === "setup_panel") await setupPanel(interaction);
    else if (interaction.type === 3 && customId.startsWith("ticket_open_")) {
      const type = findType(customId.replace("ticket_open_", ""));
      if (type) await interactionCallback(interaction, 9, modal(type));
    } else if (interaction.type === 3 && customId === "ticket_claim") await handleClaim(interaction);
    else if (interaction.type === 3 && customId === "ticket_unclaim") await handleUnclaim(interaction);
    else if (interaction.type === 3 && customId === "ticket_close") await handleClose(interaction);
    else if (interaction.type === 3 && customId.startsWith("rate_")) {
      const match = customId.match(/^rate_(\d+)_([1-5])$/);
      if (!match) {
        await ephemeral(interaction, "⚠️ This ticket rating is invalid or expired.");
      } else {
        await handleRatingClick(interaction, Number(match[2]), match[1]);
      }
    } else if (interaction.type === 5) await handleModalSubmit(interaction);
  } catch (error) {
    log(`interaction ${interaction.id} failed`, error);
  }
}

async function maintenance(): Promise<void> {
  const now = Date.now();
  for (const ticket of [...state.tickets.values()]) {
    const idle = now - ticket.lastActivity;
    if (idle >= 24 * 60 * 60 * 1000) {
      void closeTicket(ticket, "automatic (24h timeout)").catch((error) => log("automatic close failed", error));
      continue;
    }
    if (ticket.claimedBy && idle >= 6 * 60 * 60 * 1000) {
      void releaseTicket(ticket).then(() => {
        return sendClaimNotice(
          ticket,
          `⚠️ ${BRAND} • Claim Removed`,
          0xed4245,
          "The claim was removed after 6 hours of inactivity."
        );
      }).catch((error) => log(`unclaim failed in ${ticket.channelId}`, error));
      continue;
    }
    if (idle >= 10 * 60 * 60 * 1000 && !ticket.reminderSent) {
      ticket.reminderSent = true;
      const dm = await discordRequest(`/users/@me/channels`, { method: "POST" }, { recipient_id: ticket.ownerId }).catch(() => null);
      if (dm) await sendMessage(dm.id, {
        embeds: [embed(`⏰ ${BRAND} • Ticket Reminder`, 0xf0b429, `Hi <@${ticket.ownerId}>! Your ticket in <#${ticket.channelId}> has been open without activity for a while. If you still need help, reply in the ticket or contact the team. If it is resolved, you can close it with the button.`)]
      }).catch((error) => log(`reminder failed in ${ticket.channelId}`, error));
    }
  }
  for (const [id, created] of state.ratings) if (now - created.createdAt >= 48 * 60 * 60 * 1000) state.ratings.delete(id);
  for (const [id, created] of state.ratingInProgress) if (now - created.createdAt >= 30 * 60 * 1000) state.ratingInProgress.delete(id);
  for (const [id, created] of state.completedRatings) if (now - created >= 48 * 60 * 60 * 1000) state.completedRatings.delete(id);
  const cooldownTtl = Math.max(cfg().actionCooldownMs, 60000);
  for (const [key, created] of state.actionCooldowns) if (now - created >= cooldownTtl) state.actionCooldowns.delete(key);
  for (const [id, created] of state.createCooldowns) if (now - created >= Math.max(cfg().cooldownCreateMs, 60000)) state.createCooldowns.delete(id);
}

function snowflakeCreatedAt(id: Snowflake): number {
  try {
    return Number((BigInt(id) >> 22n) + 1420070400000n);
  } catch {
    return Date.now();
  }
}

function parseTicketTopic(topic: string | undefined): { typeId?: string; ownerId?: Snowflake; createdAt?: number; claimedBy?: Snowflake } {
  const prefix = topic?.startsWith("honeylua:v1;")
    ? "honeylua:v1;"
    : topic?.startsWith("osvaldo-systems:v1;")
      ? "osvaldo-systems:v1;"
      : "";
  if (!prefix) return {};
  const values = new Map<string, string>();
  for (const part of topic.slice(prefix.length).split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (value) values.set(key, value);
  }
  const typeId = values.get("type");
  const ownerId = values.get("owner");
  const claimed = values.get("claimed");
  return {
    typeId,
    ownerId,
    createdAt: Number(values.get("created")) || undefined,
    claimedBy: claimed && /^\d+$/.test(claimed) ? claimed : undefined
  };
}

function firstMemberOverwrite(
  overwrites: Json[] | undefined,
  predicate: (overwrite: Json) => boolean
): Snowflake | undefined {
  return (overwrites || []).find((overwrite) => overwrite.type === 1 && predicate(overwrite))?.id;
}

async function getGuildMember(memberId: Snowflake): Promise<Json | null | undefined> {
  try {
    return await discordRequest(`/guilds/${cfg().guildId}/members/${memberId}`);
  } catch (error) {
    if (String(error).includes("Discord 404")) return null;
    log(`guild member lookup failed for ${memberId}; preserving the existing claim`, error);
    return undefined;
  }
}

function isAdministratorMember(member: Json | undefined): boolean {
  return Array.isArray(member?.roles) && member.roles.some((roleId: Snowflake) => ((state.guildRolePermissions.get(roleId) || 0n) & 8n) === 8n);
}

async function hydrateOpenTickets(): Promise<void> {
  try {
    const channels = await discordRequest(`/guilds/${cfg().guildId}/channels`);
    if (!Array.isArray(channels)) return;
    for (const channel of channels) {
      const type = ticketTypeFromChannelName(channel.name || "");
      if (!type || channel.parent_id !== cfg().ticketCategoryId || state.tickets.has(channel.id)) continue;

      const topic = parseTicketTopic(channel.topic);
      const ownerId = topic.ownerId || firstMemberOverwrite(
        channel.permission_overwrites,
        (overwrite) => overwrite.id !== state.botId &&
          (Number(overwrite.allow || 0) & PERMISSIONS.VIEW_CHANNEL) !== 0
      );
      if (!ownerId) {
        log(`skipping ticket channel ${channel.id}; owner could not be recovered`);
        continue;
      }
      let claimedBy = topic.claimedBy || firstMemberOverwrite(
        channel.permission_overwrites,
        (overwrite) =>
          overwrite.id !== state.botId &&
          overwrite.id !== ownerId &&
          (Number(overwrite.allow || 0) & PERMISSIONS.SEND_MESSAGES) !== 0
      );
      let staleClaimedBy: Snowflake | undefined;
      if (claimedBy) {
        const member = await getGuildMember(claimedBy);
        if (member === null || (member && state.guildRolesLoaded && !isAdministratorMember(member) && !hasAnyRole(member.roles, ticketAccessRoleIds(type)))) {
          staleClaimedBy = claimedBy;
          log(`removing stale claim from ${channel.id}; claimer is no longer an eligible member`);
          claimedBy = undefined;
        }
      }
      const lastActivity = channel.last_message_id
        ? snowflakeCreatedAt(channel.last_message_id)
        : topic.createdAt || snowflakeCreatedAt(channel.id);
      const ticket: Ticket = {
        id: channel.id,
        typeId: topic.typeId && findType(topic.typeId) ? topic.typeId : type.typeId,
        channelId: channel.id,
        ownerId,
        ownerName: "user",
        answers: [],
        createdAt: topic.createdAt || snowflakeCreatedAt(channel.id),
        claimedBy,
        claimedAt: claimedBy ? lastActivity : undefined,
        lastActivity,
        reminderSent: false
      };
      state.tickets.set(channel.id, ticket);
      await synchronizeTicketPermissions(ticket, channel.permission_overwrites, staleClaimedBy)
        .catch((error) => log(`permission reconciliation failed in ${channel.id}`, error));
    }
    log(`hydrated ${state.tickets.size} open ticket(s) from Discord channels`);
  } catch (error) {
    log("open ticket hydration failed", error);
  }
}

async function registerCommand(): Promise<void> {
  await discordRequest(`/applications/${state.applicationId}/guilds/${cfg().guildId}/commands`, { method: "PUT" }, [{
    name: "setup_panel",
    description: `Open the ${BRAND} support panel (administrators only)`
  }]);
}

function gatewaySend(op: number, d: any): void {
  if (!state.gateway || state.gateway.readyState !== 1) return;
  state.gateway.send(JSON.stringify({ op, d }));
}

function stopHeartbeat(): void {
  if (state.heartbeat) clearInterval(state.heartbeat);
  state.heartbeat = null;
}

function startHeartbeat(intervalMs: number): void {
  stopHeartbeat();
  const safeInterval = Number.isFinite(intervalMs) ? Math.min(120_000, Math.max(5_000, intervalMs)) : 45_000;
  state.heartbeatAck = true;
  state.heartbeat = setInterval(() => {
    if (!state.heartbeatAck) {
      state.gateway?.close();
      return;
    }
    state.heartbeatAck = false;
    gatewaySend(1, state.sequence);
  }, safeInterval);
}

async function gatewayDispatch(payload: GatewayPayload): Promise<void> {
  if (payload.s !== undefined) state.sequence = payload.s;
  if (payload.t === "READY") {
    state.sessionId = payload.d.session_id;
    state.resumeUrl = payload.d.resume_gateway_url || "";
    state.botId = payload.d.user.id;
    state.applicationId = payload.d.application?.id || payload.d.user.id;
    state.reconnectDelay = 3000;
    log(`connected as ${payload.d.user.username}`);
    if (!state.ticketsHydrated && !state.hydratingTickets) {
      state.hydratingTickets = true;
      await loadGuildRoles();
      await hydrateOpenTickets();
      state.hydratingTickets = false;
      state.ticketsHydrated = true;
    }
    await registerCommand().catch((error) => log("command registration failed", error));
  } else if (payload.t === "MESSAGE_CREATE") {
    const message = payload.d;
    if (!message.author?.bot && message.guild_id === cfg().guildId) {
      const ticket = state.tickets.get(message.channel_id);
      if (ticket) {
        ticket.lastActivity = Date.now();
        ticket.reminderSent = false;
        const type = findType(ticket.typeId);
        if (
          message.author.id !== ticket.ownerId &&
          type &&
          hasAnyRole(message.member?.roles, ticketAccessRoleIds(type)) &&
          !ticket.claimedBy
        ) {
          void claimTicket(ticket, message.author.id).then(() => sendAutoClaimNotice(ticket, message.author.id)).catch((error) => log("auto-claim failed", error));
        }
      }
    }
  } else if (payload.t === "INTERACTION_CREATE") {
    void handleInteraction(payload.d);
  }
}

function scheduleReconnect(): void {
  if (state.reconnecting) return;
  const delay = state.reconnectDelay;
  state.reconnecting = true;
  state.reconnectDelay = Math.min(60_000, Math.max(3_000, state.reconnectDelay * 2));
  setTimeout(() => {
    state.reconnecting = false;
    connectGateway();
  }, delay);
}

function connectGateway(): void {
  if (state.gateway && (state.gateway.readyState === 0 || state.gateway.readyState === 1)) return;
  const url = state.sessionId && state.resumeUrl
    ? `${state.resumeUrl}?v=10&encoding=json`
    : GATEWAY;
  const socket = new WebSocket(url);
  state.gateway = socket;
  socket.onopen = () => {
    log("gateway socket opened");
  };
  socket.onmessage = (event) => {
    try { void handleGateway(JSON.parse(String(event.data))).catch((error) => log("gateway payload handling failed", error)); }
    catch (error) { log("invalid gateway payload", error); }
  };
  socket.onerror = (event) => log("gateway socket error", event);
  socket.onclose = (event) => {
    stopHeartbeat();
    if (state.gateway === socket) state.gateway = null;
    const fatalCodes = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
    if (fatalCodes.has(event.code)) {
      log(`gateway closed with fatal code ${event.code}; automatic reconnect disabled`);
      return;
    }
    scheduleReconnect();
  };
}

async function handleGateway(payload: GatewayPayload): Promise<void> {
  if (payload.op === 10) {
    startHeartbeat(payload.d.heartbeat_interval);
    if (state.sessionId && state.resumeUrl) {
      gatewaySend(6, { token: cfg().token, session_id: state.sessionId, seq: state.sequence });
    } else {
      gatewaySend(2, {
        token: cfg().token,
        intents: 1 | 512 | 4096 | 32768,
        properties: { os: "linux", browser: "honeylua", device: "honeylua" }
      });
    }
    return;
  }
  if (payload.op === 11) {
    state.heartbeatAck = true;
    return;
  }
  if (payload.op === 7) {
    state.gateway?.close();
    return;
  }
  if (payload.op === 9) {
    state.sessionId = "";
    state.resumeUrl = "";
    state.sequence = null;
    state.gateway?.close();
    return;
  }
  if (payload.op === 1) {
    gatewaySend(1, state.sequence);
    return;
  }
  if (payload.op === 0) await gatewayDispatch(payload);
}

async function main(): Promise<void> {
  try {
    state.config = loadConfig();
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
  setInterval(() => void maintenance().catch((error) => log("maintenance failed", error)), 60000);
  connectGateway();
}

void main();