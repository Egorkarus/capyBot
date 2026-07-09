function getFormattedTimestamp() {
    return new Date().toISOString();
}

function logInfo(message) {
    console.log(`[${getFormattedTimestamp()}] [INFO] ${message}`);
}

function logWarn(message) {
    console.warn(`[${getFormattedTimestamp()}] [WARN] ${message}`);
}

function logError(message, error = null) {
    if (error) {
        console.error(`[${getFormattedTimestamp()}] [ERROR] ${message}:`, error);
        return;
    }
    console.error(`[${getFormattedTimestamp()}] [ERROR] ${message}`);
}

module.exports = {
    logInfo,
    logWarn,
    logError
};
