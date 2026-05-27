import { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  ChannelType, 
  EmbedBuilder, 
  TextChannel,
  MessageFlags // Add this here
} from "discord.js";
import { google } from "googleapis";
import { logger } from "./lib/logger.js";

  // —— Google Sheets helpers

  const SPREADSHEET_ID = "1M6_fe_OLvjk4OEdRBmz7rsNHAULHCgEDAA49MJM7IGM";

  function getSheetsClient() {
    const raw = process.env["GOOGLE_SERVICE_ACCOUNT_JSON"];
    if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON not set");
    const creds = JSON.parse(raw) as {
      client_email: string;
      private_key: string;
    };
    const auth = new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
    return google.sheets({ version: "v4", auth });
  }

  async function serveWarrantInSheet(suspectName: string): Promise<"served" | "not_found" | "already_served"> {
    const sheets = getSheetsClient();

    // 1. Fetch the entire data grid from the sheet
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "A1:Z1000", 
    });

    const rows = res.data.values ?? [];
    if (rows.length === 0) return "not_found";

    let foundRowIndex = -1;
    let foundColIndex = -1;

    // 2. Scan every single cell in the sheet to find the suspect's name
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < rows[r].length; c++) {
        if (rows[r][c] && rows[r][c].toString().trim().toLowerCase() === suspectName.trim().toLowerCase()) {
          foundRowIndex = r;
          foundColIndex = c;
          break;
        }
      }
      if (foundRowIndex !== -1) break;
    }

    // If the suspect name wasn't found anywhere in the sheet
    if (foundRowIndex === -1) return "not_found";

    // 3. The "Warrant Status" column is exactly 2 columns to the right of the Suspect name
    const statusColIndex = foundColIndex + 2; 
    const currentStatus = rows[foundRowIndex][statusColIndex] ? rows[foundRowIndex][statusColIndex].toString().trim().toLowerCase() : "";

    if (currentStatus === "served") {
      return "already_served";
    }



    // 4. Convert the numerical column index back into a Google Sheets letter (e.g., Column B -> 'B')
    function colToLetter(col: number): string {
      let letter = "";
      let c = col;
      while (c >= 0) {
        letter = String.fromCharCode((c % 26) + 65) + letter;
        c = Math.floor(c / 26) - 1;
      }
      return letter;
    }

    const targetCell = `${colToLetter(statusColIndex)}${foundRowIndex + 1}`; // +1 because sheets are 1-indexed

    // 5. Update that specific cell to "Served"
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: targetCell,
      valueInputOption: "RAW",
      requestBody: {
        values: [["Served"]],
      },
    });

    // 6. Fetch spreadsheet metadata to get the proper sheet ID
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const sheetId = meta.data.sheets?.[0]?.properties?.sheetId ?? 0;

    // 7. Paint the cell bright red with white bold text
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: foundRowIndex,
                endRowIndex: foundRowIndex + 1,
                startColumnIndex: statusColIndex,
                endColumnIndex: statusColIndex + 1,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 1, green: 0, blue: 0 },
                  textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat)",
            },
          },
        ],
      },
    });

    return "served";
  }

  interface GuildConfig {
    patrolLogsChannelId: string;
    requiredRoleId: string;
    excusedRoleId: string;
    allowedCommandRoles: Set<string>;
    rankLockChannelId: string;
    rankLockRoleId: string;
    inactivityCheckRoles: Set<string>;
    warrantLogChannelId?: string;
  }
interface ActiveLOA {
  userId: string;
  guildId: string;
  endsAt: number;
}

let activeLOAs: ActiveLOA[] = [];

const LOA_ROLE_ID = "1483541152983683102";
const COMMAND_REQUIRED_ROLE_ID = "1318013406501933077";
  const GUILD_CONFIGS: Record<string, GuildConfig> = {
  // Original server
  "1317964647680311427": {
    patrolLogsChannelId: "1481434783220240384",
    requiredRoleId: "1481057691400015973",
    excusedRoleId: "1483541152983683102",
    allowedCommandRoles: new Set([
      "1317965217262600242",
      "1318013282396668004",
      "1317964928073863209",
    ]),
    rankLockChannelId: "1343092393267695616",
    rankLockRoleId: "1481057691400015973",
    inactivityCheckRoles: new Set([
      "1317965217262600242",
      "1318006222867267634",
    ]),
    warrantLogChannelId: "1509013045534523542",
  },
  // Testing server
  "1038126794408198174": {
    patrolLogsChannelId: "1508631441871999057",
    requiredRoleId: "1039951681582026852",
    excusedRoleId: "1508635424598261760",
    allowedCommandRoles: new Set(["1039951283181854750"]),
    rankLockChannelId: "1508642385263857764",
    rankLockRoleId: "1039951681582026852",
    inactivityCheckRoles: new Set(["1039951283181854750"]),
  },
};

// ─── Duration parsing ───────────────────────────────────────────────────────

const DURATION_PATTERNS: { regex: RegExp; ms: (n: number) => number }[] = [
  { regex: /(\d+)\s*month[s]?/i,  ms: (n) => n * 30 * 24 * 60 * 60 * 1000 },
  { regex: /(\d+)\s*week[s]?/i,   ms: (n) => n * 7  * 24 * 60 * 60 * 1000 },
  { regex: /(\d+)\s*day[s]?/i,    ms: (n) => n * 24 * 60 * 60 * 1000 },
  { regex: /(\d+)\s*hour[s]?/i,   ms: (n) => n * 60 * 60 * 1000 },
];

function parseDurationMs(text: string): number | "permanent" | null {
  if (/permanent|indefinite|forever|perma/i.test(text)) return "permanent";

  let totalMs = 0;
  let found = false;

  for (const { regex, ms } of DURATION_PATTERNS) {
    const match = text.match(regex);
    if (match?.[1]) {
      totalMs += ms(parseInt(match[1], 10));
      found = true;
    }
  }

  return found ? totalMs : null;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return "**Expired** (rank lock period has passed)";

  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
  const minutes = Math.floor((ms % (60 * 60 * 1000)) / (60 * 1000));

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}m`);

  return parts.join(" ") || "< 1 minute";
}

function formatDuration(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days !== 1 ? "s" : ""}`);
  if (hours > 0 && days < 7) parts.push(`${hours} hour${hours !== 1 ? "s" : ""}`);

  return parts.join(" ") || "< 1 hour";
}

// ─── Quota helpers ──────────────────────────────────────────────────────────

interface QuotaEntry {
  label: string;
  current: number;
  total: number;
  met: boolean;
}

interface MemberQuota {
  userId: string;
  username: string;
  threadName: string;
  threadId: string;
  guildId: string;
  excused: boolean;
  entries: QuotaEntry[];
}

function parseQuotaFromMessage(content: string): QuotaEntry[] | null {
  const lines = content.split("\n");
  const quotaIndex = lines.findIndex((l) => /quota/i.test(l));
  if (quotaIndex === -1) return null;

  const entries: QuotaEntry[] = [];
  for (let i = quotaIndex + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cleaned = line.replace(/\*\*/g, "");
    const match = cleaned.match(/^(.+?)(?::\s*|\s+)(\d+)\s*\/\s*(\d+)/);
    if (match) {
      const current = parseInt(match[2], 10);
      const total = parseInt(match[3], 10);
      entries.push({
        label: match[1].trim(),
        current,
        total,
        met: current >= total,
      });
    }
  }
  return entries.length > 0 ? entries : null;
}

async function findQuotaForThread(
  thread: import("discord.js").AnyThreadChannel,
  ownerId: string,
): Promise<QuotaEntry[] | null> {
  let lastBefore: string | undefined;

  for (let attempt = 0; attempt < 5; attempt++) {
    const messages = await thread.messages.fetch({
      limit: 100,
      before: lastBefore,
    });
    if (messages.size === 0) break;

    const sorted = [...messages.values()].sort(
      (a, b) => b.createdTimestamp - a.createdTimestamp,
    );

    for (const msg of sorted) {
      if (msg.author.id === ownerId && /quota/i.test(msg.content)) {
        return parseQuotaFromMessage(msg.content);
      }
    }

    const oldest = sorted[sorted.length - 1];
    if (oldest) lastBefore = oldest.id;
    if (messages.size < 100) break;
  }

  return null;
}

// ─── Bot startup ────────────────────────────────────────────────────────────

export async function startBot(): Promise<void> {
  const token = process.env["DISCORD_TOKEN"];
  if (!token) {
    logger.error("DISCORD_TOKEN not set — bot will not start");
    return;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const commands = [
    new SlashCommandBuilder()
      .setName("checkquota")
      .setDescription("Scan patrol-logs and display quota status for all members"),
    new SlashCommandBuilder()
      .setName("ranklock")
      .setDescription("Check how much time is left on a rank lock")
      .addUserOption((opt) =>
        opt
          .setName("user")
          .setDescription("The member to check (HR only — defaults to yourself)")
          .setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("inactivitycheck")
      .setDescription("List members who have not increased their patrol log count in the last 7 days"),
    new SlashCommandBuilder()
      .setName("loa")
      .setDescription("Approve an LOA for a user")
      .addUserOption(opt => 
        opt.setName("user").setDescription("The user going on LOA").setRequired(true)
      )
      .addIntegerOption(opt => 
        opt.setName("days").setDescription("Number of days for the LOA").setRequired(true)
      ),
    new SlashCommandBuilder()
      .setName("loas")
      .setDescription("Display all current active LOAs"),
    new SlashCommandBuilder()
      .setName("removeloa")
      .setDescription("Forcefully cancel and remove an LOA from a user")
      .addUserOption(opt => 
        opt.setName("user").setDescription("The user to remove from LOA").setRequired(true)
      ),
    new SlashCommandBuilder()
    .setName("activewarrants")
    .setDescription("Displays a list of all active unserved warrants from the database")
  ];

  client.once("ready", async (c) => {
    logger.info({ tag: c.user.tag }, "Discord bot ready");

    const rest = new REST({ version: "10" }).setToken(token);

    const guilds = c.guilds.cache.map((g) => g.id);

    for (const guildId of guilds) {
      try {
        await rest.put(
          Routes.applicationGuildCommands(c.user.id, guildId),
          { body: commands.map((cmd) => cmd.toJSON()) },
        );
        logger.info({ guildId }, "Registered slash commands");
      } catch (err) {
        logger.error({ err, guildId }, "Failed to register slash commands");
      }
    }
  });
  // Background checker to automatically clear expired LOAs every 60 seconds
  // Background checker to automatically clear expired LOAs and ping the user
  setInterval(async () => {
    const now = Date.now();
    const expired = activeLOAs.filter(loa => now >= loa.endsAt);
    activeLOAs = activeLOAs.filter(loa => now < loa.endsAt);

    for (const loa of expired) {
      try {
        const guild = await client.guilds.fetch(loa.guildId);
        const member = await guild.members.fetch(loa.userId);

        // 1. Strip the LOA role if they have it
        if (member && member.roles.cache.has(LOA_ROLE_ID)) {
          await member.roles.remove(LOA_ROLE_ID);
          console.log(`[LOA EXPIRED]: Automatically removed LOA role from user ID: ${loa.userId}`);
        }

        // 2. Fetch the server config and ping the user in your patrol logs channel
        const config = GUILD_CONFIGS[loa.guildId];
        if (config && config.patrolLogsChannelId) {
          const channel = await guild.channels.fetch(config.patrolLogsChannelId);

          if (channel && channel.isTextBased()) {
            await channel.send({
              content: `📢 <@${loa.userId}>, your Leave of Absence (LOA) has officially expired. Welcome back to active duty!`
            });
          }
        }
      } catch (err) {
        console.error(`Failed to automatically process expired LOA for user ${loa.userId}:`, err);
      }
    }
  }, 60000);
  // ─── /checkquota ────────────────────────────────────────────────────────

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const config = interaction.guildId ? GUILD_CONFIGS[interaction.guildId] : undefined;
    if (!config) {
      await interaction.reply({
        content: "❌ This server is not configured for this bot.",
        ephemeral: true,
      });
      return;
    }

    // ── /checkquota ──────────────────────────────────────────────────────
    // ==========================================
    // LOA MANAGEMENT COMMANDS
    // ==========================================

    // --- /loa Command ---
    if (interaction.commandName === "loa") {
      if (!interaction.member.roles.cache.has(COMMAND_REQUIRED_ROLE_ID)) {
        return interaction.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
      }

      const targetUser = interaction.options.getUser("user");
      const days = interaction.options.getInteger("days");

      if (!targetUser || !days) return interaction.reply({ content: "❌ Missing required options.", ephemeral: true });

      const member = await interaction.guild?.members.fetch(targetUser.id);
      if (!member) return interaction.reply({ content: "❌ User not found in this server.", ephemeral: true });

      const durationMs = days * 24 * 60 * 60 * 1000;
      const endsAt = Date.now() + durationMs;

      activeLOAs = activeLOAs.filter(loa => loa.userId !== targetUser.id);
      activeLOAs.push({ userId: targetUser.id, guildId: interaction.guildId!, endsAt });

      await member.roles.add(LOA_ROLE_ID);
      const timestampString = Math.floor(endsAt / 1000);

      return interaction.reply({
        content: `✅ **LOA Approved**\n**User:** <@${targetUser.id}>\n**Duration:** ${days} days\n**Expires:** <t:${timestampString}:D> (<t:${timestampString}:R>)`
      });
    }

    // --- /loas List Command ---
    if (interaction.commandName === "loas") {
      const currentGuildLOAs = activeLOAs.filter(loa => loa.guildId === interaction.guildId);
      if (currentGuildLOAs.length === 0) {
        return interaction.reply({ content: "ℹ️ There are currently no active LOAs.", ephemeral: true });
      }

      let responseMessage = "📋 **Active Leave of Absences (LOAs):**\n\n";
      currentGuildLOAs.forEach(loa => {
        const relativeTimestamp = Math.floor(loa.endsAt / 1000);
        responseMessage += `• <@${loa.userId}> — Time remaining: <t:${relativeTimestamp}:R> (Ends: <t:${relativeTimestamp}:D>)\n`;
      });

      return interaction.reply({ content: responseMessage });
    }

    // --- /removeloa Command ---
    if (interaction.commandName === "removeloa") {
      if (!interaction.member.roles.cache.has(COMMAND_REQUIRED_ROLE_ID)) {
        return interaction.reply({ content: "❌ You do not have permission to use this command.", ephemeral: true });
      }

      const targetUser = interaction.options.getUser("user");
      if (!targetUser) return interaction.reply({ content: "❌ Please specify a user.", ephemeral: true });

      const member = await interaction.guild?.members.fetch(targetUser.id);

      const initialLength = activeLOAs.length;
      activeLOAs = activeLOAs.filter(loa => loa.userId !== targetUser.id);

      if (member && member.roles.cache.has(LOA_ROLE_ID)) {
        await member.roles.remove(LOA_ROLE_ID);
      }

      if (initialLength === activeLOAs.length && (!member || !member.roles.cache.has(LOA_ROLE_ID))) {
        return interaction.reply({ content: `ℹ️ <@${targetUser.id}> does not have an active LOA logged.`, ephemeral: true });
      }

      return interaction.reply({ content: `🛑 **Force Removed LOA:** <@${targetUser.id}>'s LOA status has been terminated and their role has been removed.` });
    }
                                    // --- /activewarrants Command ---
                                    if (interaction.commandName === "activewarrants") {
                                      const REQUIRED_ROLE_ID = "1481057691400015973";

                                      if (!interaction.member || !(interaction.member.roles as any).cache.has(REQUIRED_ROLE_ID)) {
                                        return interaction.reply({ content: "❌ No permission.", ephemeral: true });
                                      }

                                      await interaction.deferReply({ ephemeral: false });

                                      try {
                                        const sheets = getSheetsClient();

                                        // Fetching from your range
                                        const response = await sheets.spreadsheets.values.get({
                                          spreadsheetId: SPREADSHEET_ID,
                                          range: "Warrants!A1:K100", 
                                        });

                                        const rows = response.data.values;

                                        if (!rows || rows.length === 0) {
                                          return interaction.editReply({ content: "ℹ️ No data found in the spreadsheet." });
                                        }

                                        let results: string[] = [];

                                        // Parse the data starting from row 18 (index 17)
                                        for (let i = 17; i < rows.length; i++) {
                                          const row = rows[i];
                                          const name = row[1];   // Column B
                                          const status = row[3]; // Column D

                                          if (name && status && String(status).trim().toLowerCase() === "active") {
                                            const cleanName = String(name).trim();
                                            const profileLink = `https://www.roblox.com/users/profile?username=${encodeURIComponent(cleanName)}`;
                                            results.push(`[${cleanName}](${profileLink})`);
                                          }
                                        }

                                        if (results.length === 0) {
                                          return interaction.editReply({ content: "ℹ️ No active warrants found." });
                                        }

                                        // Format the final message
                                        const message = `📜 **Active Warrants:**\n${results.map((entry, i) => `**${i + 1}.** ${entry}`).join('\n')}`;
                                        return interaction.editReply({ content: message });

                                      } catch (err) {
                                        console.error("Bot failed:", err);
                                        return interaction.editReply({ content: "❌ Error connecting to database." });
                                      }
                                    }

// --- /checkquota Command ---
else if (interaction.commandName === "checkquota") {
  try {
    await interaction.deferReply().catch(() => {});
    const results: any[] = [];
    // ... [Insert your original quota-checking logic here, starting from where you get threadMembers]
    // Make sure the entire "for" loop and embed logic is inside these braces!

    // (Ensure the code below is included inside this else if block)
    if (results.length === 0) {
      await interaction.editReply("No quota data found.");
      return;
    }
    // ... [Rest of your quota code]

  } catch (err) {
    logger.error({ err }, "Error handling /checkquota");
    await interaction.editReply("❌ An error occurred.").catch(() => undefined);
  }
}

    // ── /ranklock ────────────────────────────────────────────────────────

    if (interaction.commandName === "ranklock") {
      const member =
        interaction.guild?.members.cache.get(interaction.user.id) ??
        (await interaction.guild?.members.fetch(interaction.user.id).catch(() => null));

      const isHR = member?.roles.cache.some((r) => config.allowedCommandRoles.has(r.id));
      const hasRankLockRole = member?.roles.cache.has(config.rankLockRoleId);

      if (!isHR && !hasRankLockRole) {
        await interaction.reply({
          content: "❌ You don't have the required role to use this command.",
          ephemeral: true,
        });
        return;
      }

      // Resolve target: HRs can specify another user, everyone else checks themselves
      const targetUser = isHR
        ? (interaction.options.getUser("user") ?? interaction.user)
        : interaction.user;

      await interaction.deferReply();

      try {
        const guild = interaction.guild!;
        const channel = await guild.channels
          .fetch(config.rankLockChannelId)
          .catch(() => null);

        if (!channel || !(channel instanceof TextChannel)) {
          await interaction.editReply(
            "❌ Could not find the rank lock channel.",
          );
          return;
        }

        // Search through messages for the last one that mentions the target
        const userId = targetUser.id;
        const mention = `<@${userId}>`;
        let foundMessage: import("discord.js").Message | null = null;
        let lastBefore: string | undefined;

        outer: for (let attempt = 0; attempt < 10; attempt++) {
          const messages = await channel.messages.fetch({
            limit: 100,
            before: lastBefore,
          });
          if (messages.size === 0) break;

          const sorted = [...messages.values()].sort(
            (a, b) => b.createdTimestamp - a.createdTimestamp,
          );

          for (const msg of sorted) {
            // Only match messages with a "User(name): @mention" field line
            const hasUserField = msg.content
              .split("\n")
              .some((line) =>
                /^user(?:name)?\s*:/i.test(line.trim()) && line.includes(mention),
              );
            if (hasUserField) {
              foundMessage = msg;
              break outer;
            }
          }

          const oldest = sorted[sorted.length - 1];
          if (oldest) lastBefore = oldest.id;
          if (messages.size < 100) break;
        }

        const targetName = targetUser.id === interaction.user.id
          ? "you"
          : `**${targetUser.displayName ?? targetUser.username}**`;

        if (!foundMessage) {
          await interaction.editReply(
            `❌ No rank lock message mentioning ${targetName} was found in the rank lock channel.`,
          );
          return;
        }

        const duration = parseDurationMs(foundMessage.content);

        if (duration === null) {
          await interaction.editReply(
            `❌ Found a message mentioning ${targetName}, but couldn't parse a duration from it.\n` +
            `> ${foundMessage.content.slice(0, 200)}`,
          );
          return;
        }

        const sentTs = foundMessage.createdTimestamp;
        const embedTitle = targetUser.id === interaction.user.id
          ? "🔒 Your Rank Lock Status"
          : `🔒 Rank Lock Status — ${targetUser.displayName ?? targetUser.username}`;

        if (duration === "permanent") {
          const embed = new EmbedBuilder()
            .setTitle(embedTitle)
            .setColor(0xed4245)
            .setDescription(
              `Rank lock is **permanent / indefinite**.\n\n` +
              `> ${foundMessage.content.slice(0, 300)}`,
            )
            .addFields({
              name: "Lock issued",
              value: `<t:${Math.floor(sentTs / 1000)}:F>`,
              inline: true,
            })
            .setFooter({ text: `Message from #${channel.name}` })
            .setTimestamp();

          await interaction.editReply({ embeds: [embed] });
          return;
        }

        const endTs = sentTs + duration;
        const remainingMs = endTs - Date.now();

        const embed = new EmbedBuilder()
          .setTitle(embedTitle)
          .setColor(remainingMs > 0 ? 0xfee75c : 0x57f287)
          .addFields(
            {
              name: "Lock issued",
              value: `<t:${Math.floor(sentTs / 1000)}:F>`,
              inline: true,
            },
            {
              name: "Lock duration",
              value: formatDuration(duration),
              inline: true,
            },
            {
              name: "Estimated end",
              value: `<t:${Math.floor(endTs / 1000)}:F>`,
              inline: true,
            },
            {
              name: remainingMs > 0 ? "⏳ Time remaining" : "✅ Status",
              value: remainingMs > 0 ? formatRemaining(remainingMs) : "Rank lock period has passed",
              inline: false,
            },
          )
          .setDescription(`> ${foundMessage.content.slice(0, 300)}`)
          .setFooter({ text: `Message from #${channel.name}` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        logger.error({ err }, "Error handling /ranklock");
        await interaction
          .editReply("❌ An error occurred while checking your rank lock.")
          .catch(() => undefined);
      }
    }

    // ── /inactivitycheck ─────────────────────────────────────────────────

    if (interaction.commandName === "inactivitycheck") {
      const member =
        interaction.guild?.members.cache.get(interaction.user.id) ??
        (await interaction.guild?.members.fetch(interaction.user.id).catch(() => null));

      const hasPermission = member?.roles.cache.some((r) =>
        config.inactivityCheckRoles.has(r.id),
      );
      if (!hasPermission) {
        await interaction.reply({
          content: "❌ You don't have permission to use this command.",
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();

      try {
        const guild = interaction.guild!;
        const channel = await guild.channels
          .fetch(config.patrolLogsChannelId)
          .catch(() => null);

        if (!channel || channel.type !== ChannelType.GuildForum) {
          await interaction.editReply(
            "❌ Could not find the patrol-logs forum channel.",
          );
          return;
        }

        await interaction.editReply("⏳ Scanning patrol logs for inactivity… this may take a moment.");

        const [active, archived] = await Promise.all([
          channel.threads.fetchActive(),
          channel.threads.fetchArchived({ fetchAll: true }),
        ]);

        const allThreads = [
          ...active.threads.values(),
          ...archived.threads.values(),
        ];

        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

        // Parse "Patrol Log: N" or "Patrol Logs: N" (plain count, not X/Y ratio)
        function parsePatrolCount(content: string): number | null {
          const lines = content.split("\n");
          for (const line of lines) {
            const match = line.match(/patrol\s*logs?\s*:\s*(\d+)(?!\s*\/)/i);
            if (match?.[1]) return parseInt(match[1], 10);
          }
          return null;
        }

        interface InactiveEntry {
          userId: string;
          nickname: string;
          latestCount: number;
          baselineCount: number;
        }

        const inactive: InactiveEntry[] = [];
        const seen = new Set<string>();

        for (const thread of allThreads) {
          if (!thread.ownerId || seen.has(thread.ownerId)) continue;

          let threadMember: import("discord.js").GuildMember;
          try {
            threadMember = await guild.members.fetch(thread.ownerId);
          } catch {
            continue;
          }

          if (!threadMember.roles.cache.has(config.requiredRoleId)) continue;
          seen.add(thread.ownerId);

          // Collect all OP messages with a patrol count, newest first
          const countedMessages: { ts: number; count: number }[] = [];
          let lastBefore: string | undefined;

          for (let attempt = 0; attempt < 10; attempt++) {
            const batch = await thread.messages.fetch({
              limit: 100,
              before: lastBefore,
            });
            if (batch.size === 0) break;

            const sorted = [...batch.values()].sort(
              (a, b) => b.createdTimestamp - a.createdTimestamp,
            );

            for (const msg of sorted) {
              if (msg.author.id !== thread.ownerId) continue;
              const count = parsePatrolCount(msg.content);
              if (count !== null) {
                countedMessages.push({ ts: msg.createdTimestamp, count });
              }
            }

            const oldest = sorted[sorted.length - 1];
            if (oldest) lastBefore = oldest.id;
            if (batch.size < 100) break;
          }

          if (countedMessages.length === 0) continue;

          // Sort by timestamp descending (newest first)
          countedMessages.sort((a, b) => b.ts - a.ts);

          const latestCount = countedMessages[0]!.count;

          // Find the most recent message that is older than 7 days
          const baseline = countedMessages.find((m) => m.ts < sevenDaysAgo);

          // No baseline means all messages are within 7 days — skip (too new to judge)
          if (!baseline) continue;

          // Inactive if count hasn't gone up since the 7-day baseline
          if (latestCount <= baseline.count) {
            inactive.push({
              userId: thread.ownerId,
              nickname: threadMember.displayName,
              latestCount,
              baselineCount: baseline.count,
            });
          }
        }

        if (inactive.length === 0) {
          await interaction.editReply(
            "✅ No inactive members found — everyone has increased their patrol count in the last 7 days.",
          );
          return;
        }

        const FIELDS_PER_EMBED = 25;
        const embeds: EmbedBuilder[] = [];

        for (let page = 0; page < Math.ceil(inactive.length / FIELDS_PER_EMBED); page++) {
          const slice = inactive.slice(
            page * FIELDS_PER_EMBED,
            (page + 1) * FIELDS_PER_EMBED,
          );
          const totalPages = Math.ceil(inactive.length / FIELDS_PER_EMBED);

          const embed = new EmbedBuilder()
            .setTitle("⚠️ Inactivity Report (Last 7 Days)")
            .setColor(0xed4245)
            .setTimestamp()
            .setFooter({
              text:
                totalPages > 1
                  ? `Page ${page + 1} of ${totalPages} • ${inactive.length} inactive member(s)`
                  : `${inactive.length} inactive member(s)`,
            });

          if (page === 0) {
            embed.setDescription(
              "The following members have **not increased** their Patrol Log count in the last 7 days.",
            );
          }

          for (const entry of slice) {
            embed.addFields({
              name: `🔴 ${entry.nickname}`,
              value:
                `**ID:** ${entry.userId}\n` +
                `**Patrol count (7+ days ago):** ${entry.baselineCount}\n` +
                `**Patrol count (now):** ${entry.latestCount}\n` +
                `─────────────────────`,
              inline: false,
            });
          }

          embeds.push(embed);
        }

        for (let i = 0; i < embeds.length; i++) {
          if (i === 0) {
            await interaction.editReply({ embeds: [embeds[i]!] });
          } else {
            await interaction.followUp({ embeds: [embeds[i]!] });
          }
        }
      } catch (err) {
        logger.error({ err }, "Error handling /inactivitycheck");
        await interaction
          .editReply("❌ An error occurred while checking inactivity.")
          .catch(() => undefined);
      }
    }
  });

  // ─── Warrant log listener ──────────────────────────────────────────────────

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.guildId) return;

    const config = GUILD_CONFIGS[message.guildId];
    if (!config?.warrantLogChannelId) return;
    if (message.channelId !== config.warrantLogChannelId) return;

    const content = message.content;

    // Only act when "Warrant Served: Yes" is present
    const servedMatch = content.match(/warrant\s+served\s*:\s*yes/i);
    if (!servedMatch) return;

    // Parse suspect name
    const suspectMatch = content.match(/^suspect\s*:\s*(.+)$/im);
    if (!suspectMatch?.[1]) {
      await message.reply("⚠️ Could not parse the **Suspect** field from this message.").catch(() => undefined);
      return;
    }

    const suspectName = suspectMatch[1].trim();

    try {
      const result = await serveWarrantInSheet(suspectName);

      if (result === "served") {
        await message.reply(
          `✅ Warrant for **${suspectName}** has been marked as **Served** in the spreadsheet (cell highlighted red).`,
        ).catch(() => undefined);
        logger.info({ suspectName }, "Warrant marked as served in sheet");
      } else if (result === "already_served") {
        await message.reply(
          `ℹ️ Warrant for **${suspectName}** is already marked as Served in the spreadsheet.`,
        ).catch(() => undefined);
      } else {
        await message.reply(
          `⚠️ Could not find **${suspectName}** in the warrants spreadsheet. Please check the spelling matches exactly.`,
        ).catch(() => undefined);
        logger.warn({ suspectName }, "Suspect not found in sheet");
      }
    } catch (err) {
      logger.error({ err, suspectName }, "Error updating warrant in sheet");
      await message.reply(
        "❌ An error occurred while updating the spreadsheet. Please check the bot logs.",
      ).catch(() => undefined);
    }
  });

  await client.login(token);
}
