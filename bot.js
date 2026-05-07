// RROP Discord Recording Bot
// Records voice channels, mixes per-user PCM into a single OGG/Opus file,
// then POSTs it to the RROP webhook for transcription + action plan.
//
// Required env vars:
//   DISCORD_TOKEN      — bot token
//   RROP_WEBHOOK_URL   — https://<project>.supabase.co/functions/v1/discord-bot-webhook
//   RROP_BOT_TOKEN     — token issued in RROP Tools → Discord Recording Bot

import {
  Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import {
  joinVoiceChannel, EndBehaviorType, getVoiceConnection,
} from '@discordjs/voice';
import prism from 'prism-media';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import FormData from 'form-data';
import fetch from 'node-fetch';

const { DISCORD_TOKEN, RROP_WEBHOOK_URL, RROP_BOT_TOKEN } = process.env;
if (!DISCORD_TOKEN || !RROP_WEBHOOK_URL || !RROP_BOT_TOKEN) {
  console.error('Missing env vars. Need DISCORD_TOKEN, RROP_WEBHOOK_URL, RROP_BOT_TOKEN.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ],
});

// guildId -> { connection, sessionDir, startedAt, channelName, userStreams: Map }
const sessions = new Map();

const commands = [
  new SlashCommandBuilder().setName('record').setDescription('Join your voice channel and start recording'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop recording and upload to RROP'),
].map(c => c.toJSON());

client.once(Events.ClientReady, async (c) => {
  console.log(`Bot ready as ${c.user.tag}`);
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationCommands(c.user.id), { body: commands });
  console.log('Slash commands registered.');
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName, guild, member } = interaction;

  if (commandName === 'record') {
    const channel = member?.voice?.channel;
    if (!channel) return interaction.reply({ content: 'Join a voice channel first.', ephemeral: true });
    if (sessions.has(guild.id)) return interaction.reply({ content: 'Already recording in this server.', ephemeral: true });

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrop-rec-'));
    const session = {
      connection, sessionDir, startedAt: Date.now(),
      channelName: channel.name, userStreams: new Map(),
    };
    sessions.set(guild.id, session);

    const receiver = connection.receiver;
    receiver.speaking.on('start', (userId) => {
      if (session.userStreams.has(userId)) return;
      const opusStream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.Manual },
      });
      const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
      const filePath = path.join(sessionDir, `${userId}.pcm`);
      const file = fs.createWriteStream(filePath);
      opusStream.pipe(decoder).pipe(file);
      session.userStreams.set(userId, { opusStream, decoder, file, filePath });
    });

    await interaction.reply({ content: `🔴 Recording **${channel.name}**. Use \`/stop\` to finish.` });
  }

  if (commandName === 'stop') {
    const session = sessions.get(guild.id);
    if (!session) return interaction.reply({ content: 'Not recording.', ephemeral: true });
    sessions.delete(guild.id);

    await interaction.reply({ content: '⏹ Stopping & processing… this may take a moment.' });

    // Close streams
    for (const { opusStream, file } of session.userStreams.values()) {
      try { opusStream.destroy(); } catch {}
      file.end();
    }
    getVoiceConnection(guild.id)?.destroy();

    // Wait for files to flush
    await new Promise(r => setTimeout(r, 500));

    // Mix all per-user PCM files into one OGG/Opus via ffmpeg
    const outPath = path.join(session.sessionDir, 'mixed.ogg');
    const inputs = [...session.userStreams.values()].map(s => s.filePath).filter(p => {
      try { return fs.statSync(p).size > 0; } catch { return false; }
    });

    if (inputs.length === 0) {
      cleanup(session.sessionDir);
      return interaction.followUp({ content: 'No audio captured.' });
    }

    const args = [];
    for (const f of inputs) {
      args.push('-f', 's16le', '-ar', '48000', '-ac', '2', '-i', f);
    }
    args.push('-filter_complex', `amix=inputs=${inputs.length}:duration=longest:dropout_transition=0`);
    args.push('-c:a', 'libopus', '-b:a', '64k', outPath, '-y');

    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args);
      ff.stderr.on('data', d => process.stderr.write(d));
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
    }).catch(async (e) => {
      await interaction.followUp({ content: `Mix failed: ${e.message}` });
      cleanup(session.sessionDir);
      throw e;
    });

    // Upload to RROP
    const duration = Math.round((Date.now() - session.startedAt) / 1000);
    const form = new FormData();
    form.append('audio', fs.createReadStream(outPath), { filename: 'discord-call.ogg', contentType: 'audio/ogg' });
    form.append('title', `${session.channelName} · ${new Date(session.startedAt).toLocaleString()}`);
    form.append('duration_seconds', String(duration));

    try {
      const resp = await fetch(RROP_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'X-Bot-Token': RROP_BOT_TOKEN, ...form.getHeaders() },
        body: form,
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
      await interaction.followUp({ content: `✅ Uploaded to RROP. Recording ID: \`${json.recordingId}\`` });
    } catch (e) {
      await interaction.followUp({ content: `Upload failed: ${e.message}` });
    } finally {
      cleanup(session.sessionDir);
    }
  }
});

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

client.login(DISCORD_TOKEN);
