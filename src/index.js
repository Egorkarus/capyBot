require('dotenv').config();
const CapyClient = require('./CapyClient');
const { logInfo, logWarn, logError } = require('./utils/logger');

if (!process.env.DISCORD_TOKEN) {
    logError("DISCORD_TOKEN is not defined in environment variables");
    process.exit(1);
}

const SHUTDOWN_TIMEOUT_MS = 10000;
const client = new CapyClient();
let isShuttingDown = false;

process.on('unhandledRejection', reason => {
    logError('Unhandled promise rejection', reason);
});

process.on('uncaughtException', error => {
    logError('Uncaught exception', error);
    process.exit(1);
});

async function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    logInfo(`Received ${signal}, shutting down...`);

    const forceExitTimer = setTimeout(() => {
        logWarn(`Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
        process.exit(0);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExitTimer.unref();

    try {
        await client.shutdown();
    } catch (error) {
        logError('Failed to shutdown cleanly', error);
    }

    clearTimeout(forceExitTimer);
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

client.init().then(() => {
    client.login(process.env.DISCORD_TOKEN).catch(err => {
        logError("Failed to log in to Discord", err);
        process.exitCode = 1;
    });
}).catch(err => {
    logError("Failed to initialize bot client", err);
    process.exitCode = 1;
});
