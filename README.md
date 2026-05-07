# RROP Discord Recording Bot

A self-hosted Node.js bot that joins a Discord voice channel, records the call, and pushes the audio to your RROP app for transcription + AI action plan generation.

## Why self-hosted?

Discord requires a persistent WebSocket (voice gateway) connection — this can't run on serverless functions. Deploy this on **Railway**, **Fly.io**, **Render**, or any always-on Node host.

## 1. Get credentials

1. **Discord bot token** — create an app at https://discord.com/developers/applications, add a Bot, copy its token. Enable the **Server Members** and **Message Content** intents.
2. **RROP webhook URL + bot token** — open RROP Tools → Discord Recording Bot → "New Token". Copy the token (shown once) and the webhook URL.
3. **Invite the bot** to your server with these permissions: `Connect`, `Speak`, `Use Voice Activity`, `Read Message History`, `Send Messages`, `Use Slash Commands`.

## 2. Deploy

```bash
git clone <this folder>
cd discord-bot
npm install
```

Set environment variables on your host:

```
DISCORD_TOKEN=...           # bot token from step 1
RROP_WEBHOOK_URL=...        # from RROP Tools panel
RROP_BOT_TOKEN=...          # issued in RROP Tools panel
```

Then `npm start`.

## 3. Use it

In any voice channel:

- `/record` — bot joins and starts recording
- `/stop` — bot stops, mixes audio, and uploads to RROP

The recording will appear in **RROP Tools → Recordings** within a few seconds, then auto-transcribe and generate an action plan.

## Files

- `bot.js` — main bot (slash commands, voice connection, recording, upload)
- `package.json` — dependencies
- `Procfile` — for Heroku/Railway (`web: node bot.js`)
