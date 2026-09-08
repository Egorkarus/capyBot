const config = require('../config');

class PlayRateLimiter {
    constructor() {
        this.userRequests = new Map();
        this.guildRequests = new Map();
    }

    checkUserLimit(userId) {
        const now = Date.now();
        const windowMs = config.limits.playRateLimitWindowMs;
        const maxRequests = config.limits.maxPlayRequestsPerWindow;

        if (!this.userRequests.has(userId)) {
            this.userRequests.set(userId, []);
        }

        const requests = this.userRequests.get(userId);
        const validRequests = requests.filter(timestamp => now - timestamp < windowMs);
        
        if (validRequests.length >= maxRequests) {
            const oldestRequest = validRequests[0];
            const waitTime = Math.ceil((windowMs - (now - oldestRequest)) / 1000);
            return {
                allowed: false,
                reason: `Превышен лимит запросов. Подожди ${waitTime} сек. 🍊`
            };
        }

        validRequests.push(now);
        this.userRequests.set(userId, validRequests);

        return { allowed: true };
    }

    checkQueueLimit(guildId, userId, session) {
        if (!session) {
            return { allowed: true };
        }

        const totalTracks = session.tracks.length;
        if (totalTracks >= config.limits.maxTracksPerGuild) {
            return {
                allowed: false,
                reason: `Очередь переполнена (макс. ${config.limits.maxTracksPerGuild} треков на сервер). 🍊`
            };
        }

        const userTracks = session.tracks.filter(track => track.userId === userId).length;
        if (userTracks >= config.limits.maxTracksPerUser) {
            return {
                allowed: false,
                reason: `У тебя уже ${userTracks} треков в очереди (макс. ${config.limits.maxTracksPerUser}). 🍊`
            };
        }

        return { allowed: true };
    }

    cleanup() {
        const now = Date.now();
        const windowMs = config.limits.playRateLimitWindowMs;

        for (const [userId, requests] of this.userRequests.entries()) {
            const validRequests = requests.filter(timestamp => now - timestamp < windowMs);
            if (validRequests.length === 0) {
                this.userRequests.delete(userId);
            } else {
                this.userRequests.set(userId, validRequests);
            }
        }
    }
}

module.exports = PlayRateLimiter;
