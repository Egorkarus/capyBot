const LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
};

function resolveLogLevel() {
    const configuredLevel = typeof process.env.LOG_LEVEL === 'string'
        ? process.env.LOG_LEVEL.trim().toLowerCase()
        : '';
    return Object.prototype.hasOwnProperty.call(LEVELS, configuredLevel) ? configuredLevel : 'info';
}

const activeLevel = resolveLogLevel();

function isLevelEnabled(level) {
    return LEVELS[level] <= LEVELS[activeLevel];
}

function getFormattedTimestamp() {
    return new Date().toISOString();
}

function logInfo(message) {
    if (!isLevelEnabled('info')) return;
    console.log(`[${getFormattedTimestamp()}] [INFO] ${message}`);
}

function logWarn(message) {
    if (!isLevelEnabled('warn')) return;
    console.warn(`[${getFormattedTimestamp()}] [WARN] ${message}`);
}

function logError(message, error = null) {
    if (!isLevelEnabled('error')) return;
    if (error) {
        console.error(`[${getFormattedTimestamp()}] [ERROR] ${message}:`, error);
        return;
    }
    console.error(`[${getFormattedTimestamp()}] [ERROR] ${message}`);
}

function logDebug(message) {
    if (!isLevelEnabled('debug')) return;
    console.log(`[${getFormattedTimestamp()}] [DEBUG] ${message}`);
}

module.exports = {
    logInfo,
    logWarn,
    logError,
    logDebug
};
