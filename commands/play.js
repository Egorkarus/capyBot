const { joinVoiceChannel, getVoiceConnection, AudioPlayerStatus, entersState, VoiceConnectionStatus } = require('@discordjs/voice');
const { getVoiceState, setVoiceState } = require('../voiceManager');
const { playAudio, getGuildAudioState, fetchTrackTitle } = require('../audioManager');
const { logError, logInfo } = require('../logger');

module.exports = {
    name: 'play',
    adminOnly: false,
    async execute(message, args) {
        const voiceChannel = message.member?.voice.channel;
        if (!voiceChannel) {
            await message.reply("Э, дорогуша, сначала сам заползи в голосовой канал, потом музыку заказывай. 🐾");
            return;
        }

        const attachment = message.attachments.first();
        const fileUrl = attachment ? attachment.url : args[0];

        const isYoutubeUrl = fileUrl && (fileUrl.includes('youtube.com') || fileUrl.includes('youtu.be'));
        const isSoundcloudUrl = fileUrl && fileUrl.includes('soundcloud.com');
        
        let isMp3Url = false;
        if (fileUrl) {
            try {
                const parsedUrl = new URL(fileUrl);
                isMp3Url = parsedUrl.pathname.toLowerCase().endsWith('.mp3');
            } catch (err) {
                isMp3Url = fileUrl.toLowerCase().split('?')[0].endsWith('.mp3');
            }
        }

        if (!fileUrl || (!isMp3Url && !isYoutubeUrl && !isSoundcloudUrl)) {
            await message.reply("Ты мне что подсовываешь? Давай ссылку на YouTube, SoundCloud или прямой MP3-файл. 🍊");
            return;
        }

        let connection = getVoiceConnection(message.guild.id);
        if (!connection) {
            try {
                connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: voiceChannel.guild.id,
                    adapterCreator: voiceChannel.guild.voiceAdapterCreator,
                    selfDeaf: true
                });
                setVoiceState(message.guild.id, voiceChannel.id, message.channel.id);
                logInfo(`Joined voice channel ${voiceChannel.id} in guild ${message.guild.id} on play command`);
            } catch (error) {
                logError("Failed to join voice channel on play command", error);
                await message.reply("Чё-то не пускает твоя калитка в канал. Попробуй позже, я пока полежу. 🛌");
                return;
            }
        }

        try {
            await entersState(connection, VoiceConnectionStatus.Ready, 5000);
        } catch (connectionError) {
            logError("Voice connection failed to reach Ready state on play command", connectionError);
            await message.reply("Не могу установить надежную связь с голосовым сервером Discord. Возможно, закрыты UDP-порты на сервере. 🍊🔌");
            return;
        }

        const statusMessage = await message.reply("Получаю информацию о треке... 🍊⏳");

        try {
            const title = await fetchTrackTitle(fileUrl);
            const audioState = getGuildAudioState(message.guild.id);
            const isIdle = !audioState || audioState.player.state.status === AudioPlayerStatus.Idle;

            playAudio(message.guild.id, fileUrl, title, connection, message.channel);

            if (isIdle) {
                await statusMessage.edit(`Врубаю: **${title}** 🍊🎶`);
            } else {
                await statusMessage.edit(`Добавил в очередь: **${title}** 🍊`);
            }
        } catch (playError) {
            logError("Error while fetching metadata or playing audio", playError);
            await statusMessage.edit("Ошибка при обработке трека. Попробуй другую ссылку. 🍊");
        }
    }
};
