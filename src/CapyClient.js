const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { logInfo, logError } = require('./logger');

class CapyClient extends Client {
    constructor() {
        super({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildVoiceStates
            ]
        });

        this.commands = new Map();
        this.sessions = new Map();
        this.config = config;
    }

    async init() {
        this.loadCommands();
        await this.cleanTempDirectory();
        
        this.once('ready', () => {
            logInfo(`Logged in as ${this.user.tag}`);
        });

        this.on('voiceStateUpdate', async (oldState, newState) => {
            if (newState.id !== this.user.id) return;
            if (oldState.channelId && !newState.channelId) {
                const session = this.getSession(oldState.guild.id);
                if (session) {
                    await session.reconnect(this, oldState.guild.id);
                }
            }
        });
    }

    loadCommands() {
        const commandsPath = path.join(__dirname, 'commands');
        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            const command = require(filePath);
            if (command.name && typeof command.execute === 'function') {
                this.commands.set(command.name, command);
            }
        }
    }

    getSession(guildId) {
        return this.sessions.get(guildId);
    }

    createSession(guildId, voiceChannelId, textChannelId) {
        const GuildSession = require('./GuildSession');
        const session = new GuildSession(guildId, voiceChannelId, textChannelId);
        this.sessions.set(guildId, session);
        return session;
    }

    deleteSession(guildId) {
        this.sessions.delete(guildId);
    }

    async cleanTempDirectory() {
        const tempPath = path.join(__dirname, 'temp');
        try {
            const fsPromises = require('fs/promises');
            await fsPromises.rm(tempPath, { recursive: true, force: true });
            await fsPromises.mkdir(tempPath, { recursive: true });
        } catch (error) {
            logError("Failed to clean up temp directory on start", error);
        }
    }
}

module.exports = CapyClient;
