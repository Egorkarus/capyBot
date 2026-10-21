const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const fsPromises = require('fs/promises');
const path = require('path');
const config = require('./config');
const GuildSession = require('./structures/GuildSession');
const { logInfo, logWarn, logError } = require('./utils/logger');

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
        this.eventHandlers = new Map();
        
        const PlayRateLimiter = require('./utils/PlayRateLimiter');
        this.rateLimiter = new PlayRateLimiter();
        
        this.rateLimiterCleanupInterval = setInterval(() => this.rateLimiter.cleanup(), 60000);
        this.rateLimiterCleanupInterval.unref();
    }

    async init() {
        this.loadCommands();
        this.loadEvents();
        await this.cleanTempDirectory();
    }

    loadCommands() {
        this.commands.clear();
        const commandsPath = path.join(__dirname, 'commands');
        if (!fs.existsSync(commandsPath)) return;

        const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
        for (const file of commandFiles) {
            const filePath = path.join(commandsPath, file);
            delete require.cache[require.resolve(filePath)];
            const command = require(filePath);
            if (command.name && typeof command.execute === 'function') {
                this.commands.set(command.name, command);
            }
        }
        logInfo(`Loaded ${this.commands.size} commands.`);
    }

    loadEvents() {
        for (const [eventName, handler] of this.eventHandlers.entries()) {
            this.removeListener(eventName, handler);
        }
        this.eventHandlers.clear();

        const eventsPath = path.join(__dirname, 'events');
        if (!fs.existsSync(eventsPath)) return;

        const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));
        for (const file of eventFiles) {
            const filePath = path.join(eventsPath, file);
            delete require.cache[require.resolve(filePath)];
            const event = require(filePath);

            if (event.name && typeof event.execute === 'function') {
                const handler = (...args) => event.execute(this, ...args);
                this.eventHandlers.set(event.name, handler);

                if (event.once) {
                    this.once(event.name, handler);
                } else {
                    this.on(event.name, handler);
                }
            }
        }
        logInfo(`Loaded ${this.eventHandlers.size} event listeners.`);
    }

    getSession(guildId) {
        return this.sessions.get(guildId);
    }

    createSession(guildId, voiceChannelId, textChannelId) {
        const session = new GuildSession(guildId, voiceChannelId, textChannelId);
        this.sessions.set(guildId, session);
        return session;
    }

    deleteSession(guildId) {
        const session = this.sessions.get(guildId);
        // Команды (!leave/!stop) уже уничтожают сессию сами: повторный destroy()
        // не нужен и только дублирует работу.
        if (session && !session.destroyed) {
            session.destroy().catch(error => {
                logError(`Failed to destroy session for guild ${guildId}`, error);
            });
        }
        this.sessions.delete(guildId);
    }

    async cleanTempDirectory() {
        const tempPath = path.join(__dirname, '..', 'temp');
        try {
            await fsPromises.rm(tempPath, { recursive: true, force: true });
        } catch (error) {
            logWarn("Failed to remove temp directory on start", error);
        }

        try {
            await fsPromises.mkdir(tempPath, { recursive: true });
        } catch (error) {
            logError("Failed to create temp directory on start", error);
        }
    }

    async shutdown() {
        if (this.rateLimiterCleanupInterval) {
            clearInterval(this.rateLimiterCleanupInterval);
            this.rateLimiterCleanupInterval = null;
        }

        const activeSessions = Array.from(this.sessions.values());
        this.sessions.clear();
        await Promise.allSettled(activeSessions.map(session => session.destroy()));

        await this.cleanTempDirectory();
        await this.destroy();
    }
}

module.exports = CapyClient;
