import { CurrentTime, ICurrentLyric, PlayerEvents, } from "./enum";
import shuffle from "lodash.shuffle";
import {
    addSortProperty,
    getInternalData,
    getQualityOrder,
    isSameMedia,
    sortByTimestampAndIndex,
} from "@/common/media-util";
import { PlayerState, RepeatMode, sortIndexSymbol, timeStampSymbol } from "@/common/constant";
import LyricParser, { IParsedLrcItem } from "@/renderer/utils/lyric-parser";
import {
    getUserPreference,
    getUserPreferenceIDB,
    removeUserPreference,
    setUserPreference,
    setUserPreferenceIDB,
} from "@/renderer/utils/user-perference";
import AppConfig from "@shared/app-config/renderer";
import { createIndexMap, IIndexMap } from "@/common/index-map";
import _trackPlayerStore from "./store";
import EventEmitter from "eventemitter3";
import logger from "@shared/logger/renderer";
import messageBus from "@shared/message-bus/renderer/main";
import { IAppState } from "@shared/message-bus/type";
import voidCallback from "@/common/void-callback";
import { delay } from "@/common/time-util";
import { createUniqueMap } from "@/common/unique-map";
import { getLinkedLyric } from "@renderer/core/link-lyric";
import { fsUtil } from "@shared/utils/renderer";
import PluginManager from "@shared/plugin-manager/renderer";

const {
    musicQueueStore,
    currentMusicStore,
    currentLyricStore,
    repeatModeStore,
    progressStore,
    playerStateStore,
    currentVolumeStore,
    currentSpeedStore,
    currentQualityStore,
    resetProgress
} = _trackPlayerStore;


interface InternalPlayerEvents {
    [PlayerEvents.RepeatModeChanged]: (repeatMode: RepeatMode) => void;
    [PlayerEvents.MusicChanged]: (musicItem: IMusic.IMusicItem | null) => void;
    [PlayerEvents.LyricChanged]: (parser: LyricParser | null) => void;
    [PlayerEvents.CurrentLyricChanged]: (lyric: IParsedLrcItem | null) => void;
    [PlayerEvents.Error]: (errorMusicItem: IMusic.IMusicItem | null, reason: any) => void;
    [PlayerEvents.ProgressChanged]: (progress: CurrentTime) => void;
    [PlayerEvents.StateChanged]: (state: PlayerState) => void;
}

interface IPlayOptions {
    refreshSource?: boolean;
    restartOnSameMedia?: boolean;
    seekTo?: number;
    quality?: IMusic.IQualityKey;
}

interface ITrackOptions {
    seekTo?: number;
    // 自动播放
    autoPlay?: boolean;
}

class TrackPlayer {
    get currentMusic() {
        return currentMusicStore.getValue();
    }

    // 只有基础信息
    get currentMusicBasicInfo() {
        const currentMusic = this.currentMusic;
        if (!currentMusic) {
            return null;
        }

        return {
            platform: currentMusic.platform,
            title: currentMusic.title,
            artist: currentMusic.artist,
            id: currentMusic.id,
            album: currentMusic.album,
            artwork: currentMusic.artwork,
        } as IMusic.IMusicItem
    }

    get progress() {
        return progressStore.getValue();
    }

    get playerState() {
        return playerStateStore.getValue();
    }

    get repeatMode() {
        return repeatModeStore.getValue();
    }

    get currentQuality() {
        return currentQualityStore.getValue();
    }

    get speed() {
        return currentSpeedStore.getValue();
    }

    get volume() {
        return currentVolumeStore.getValue();
    }

    get lyric() {
        return currentLyricStore.getValue();
    }

    get musicQueue() {
        return musicQueueStore.getValue();
    }

    get isEmpty() {
        return this.musicQueue.length <= 0;
    }

    private indexMap: IIndexMap;

    private currentIndex = -1;


    private ee: EventEmitter<InternalPlayerEvents>;

    constructor() {
        this.indexMap = createIndexMap();
        this.ee = new EventEmitter();
    }

    on<T extends keyof InternalPlayerEvents>(event: T, callback: InternalPlayerEvents[T]) {
        this.ee.on(event, callback as any);
    }

    private setupEvents() {
        this.ee.on(PlayerEvents.Error, async (errorMusicItem) => {
            // config
            const needSkip = AppConfig.getConfig("playMusic.playError") === "skip";

            this.resetProgress();
            if (this.musicQueue.length > 1 && needSkip) {
                await delay(500);
                if (this.isCurrentMusic(errorMusicItem)) {
                    this.skipToNext();
                }
            }
        });

        navigator.mediaSession.setActionHandler("nexttrack", () => {
            this.skipToNext();
        })

        navigator.mediaSession.setActionHandler("previoustrack", () => {
            this.skipToPrev();
        })
    }


    // [新增] 播放完成后的处理逻辑
    private handlePlaybackFinished() {
        this.resetProgress();
        switch (this.repeatMode) {
            case RepeatMode.Queue:
            case RepeatMode.Shuffle:
                this.skipToNext();
                break;
            case RepeatMode.Loop:
                // [修复] 在 mpv 重启后，需要显式地重新播放当前歌曲以维持循环
                if (this.currentMusic) {
                    this.playIndex(this.currentIndex, { restartOnSameMedia: true });
                }
                break;
        }
    }

    public async setup() {
        // 1. Config
        const [repeatMode, currentMusic, currentProgress, volume, speed, defaultQuality] = [
            getUserPreference("repeatMode"),
            getUserPreference("currentMusic"),
            getUserPreference("currentProgress"),
            getUserPreference("volume"),
            getUserPreference("speed"),
            getUserPreference("currentQuality") || AppConfig.getConfig("playMusic.defaultQuality")
        ];
        const playList = ((await getUserPreferenceIDB("playList")) ?? []).filter(it => !!it);
        addSortProperty(playList);
        const deviceId = AppConfig.getConfig("playMusic.audioOutputDevice")?.deviceId;

        // 2. init audio controller
        this.setupEvents();

        // [新增] 监听主进程发来的播放完成事件
        messageBus.onCommand('mpvFinished', () => {
            this.handlePlaybackFinished();
        });

        // [修复] 监听主进程通过 appStatePatch 命令同步过来的状态
        messageBus.onCommand('appStatePatch', (patch) => {
            if ('playerState' in patch && patch.playerState) {
                this.setPlayerState(patch.playerState);
            }
            if ('progress' in patch && 'duration' in patch && typeof patch.progress === 'number' && typeof patch.duration === 'number') {
                const currentTime = patch.progress;
                const duration = patch.duration;

                this.setProgress({ currentTime, duration });

                if (this.lyric?.parser) {
                    const lyricItem = this.lyric.parser.getPosition(currentTime);
                    if (this.lyric.currentLrc?.lrc !== lyricItem?.lrc) {
                        this.setCurrentLyric({
                            parser: this.lyric.parser,
                            currentLrc: lyricItem,
                        });
                    }
                }
            }
        });

        // 3. resume state
        musicQueueStore.setValue(playList);
        this.indexMap.update(playList);

        if (repeatMode) {
            this.setRepeatMode(repeatMode as RepeatMode);
        }

        // [修改] 启动时只恢复UI状态，不主动播放
        // 播放状态和进度将由主进程通过 syncAppState 推送
        this.setCurrentMusic(currentMusic);
        this.currentIndex = this.findMusicIndex(currentMusic);

        if (volume !== null && volume !== undefined) {
            this.setVolume(volume, false); // 启动时不向主进程发送命令
        }
        
        if (speed) {
            this.setSpeed(speed, false); // 启动时不向主进程发送命令
        }

        if (currentProgress && this.progress.currentTime !== currentProgress) {
             this.setProgress({ ...this.progress, currentTime: currentProgress });
        }


        // 4. reload lyric
        this.fetchCurrentLyric();

        // 5. [修改] 如果有上次播放的歌曲，则预加载它，但不播放
        if (currentMusic) {
            this.fetchMediaSource(currentMusic, defaultQuality).then(({ mediaSource, quality }) => {
                // 确保在获取音源期间，用户没有切换歌曲
                if (this.isCurrentMusic(currentMusic) && mediaSource?.url) {
                    console.log('[Renderer] Preloading track on setup:', currentMusic.title);
                    messageBus.sendCommand('mpvLoad', { url: mediaSource.url });
                    this.setCurrentQuality(quality);
                }
            }).catch(e => {
                console.error("Failed to preload track on setup:", e);
            });
        }
    }


    // 切换播放模式
    public toggleRepeatMode() {
        let nextRepeatMode = this.repeatMode;
        switch (nextRepeatMode) {
            case RepeatMode.Shuffle:
                nextRepeatMode = RepeatMode.Loop;
                break;
            case RepeatMode.Loop:
                nextRepeatMode = RepeatMode.Queue;
                break;
            case RepeatMode.Queue:
                nextRepeatMode = RepeatMode.Shuffle;
                break;
        }

        this.setRepeatMode(nextRepeatMode);
    }

    public async playIndex(index: number, options: IPlayOptions = {}) {
        const { refreshSource, restartOnSameMedia = true, seekTo, quality: intendedQuality } = options;
        if (index === -1 && this.musicQueue.length === 0) {
            // 播放列表为空
            return;
        }
        // 1. normalize index
        index = (index + this.musicQueue.length) % this.musicQueue.length;

        // 2. same media
        if (this.currentIndex === index && this.isCurrentMusic(this.musicQueue[index]) && !refreshSource) {
            if (restartOnSameMedia) {
                this.seekTo(0);
            }
            // [修复] 直接执行恢复播放的逻辑，而不是调用 resume()，以避免无限递归
            if (this.playerState !== PlayerState.Playing) {
                messageBus.sendCommand('mpvTogglePause');
                this.setPlayerState(PlayerState.Playing);
            }

            return;
        }

        // update music
        const nextMusicItem = this.musicQueue[index];
        this.setCurrentMusic(nextMusicItem);
        this.currentIndex = index;

        this.setPlayerState(PlayerState.Buffering);

        try {
            const { mediaSource, quality } = await this.fetchMediaSource(nextMusicItem, intendedQuality);

            if (!mediaSource.url) {
                throw new Error("mediaSource.url is empty");
            }

            if (!this.isCurrentMusic(nextMusicItem)) {
                // should be aborted
                return;
            }

            this.setCurrentQuality(quality);
            this.setTrack(mediaSource, nextMusicItem, {
                seekTo,
                autoPlay: true
            });

            // extra information
            const musicInfo = await PluginManager.callPluginDelegateMethod(
                {
                    platform: nextMusicItem.platform,
                },
                "getMusicInfo",
                nextMusicItem
            ).catch(voidCallback);

            if (!(musicInfo && this.isCurrentMusic(nextMusicItem) && typeof musicInfo === "object")) {
                return;
            }

            this.setCurrentMusic({
                ...nextMusicItem,
                ...musicInfo,
                platform: nextMusicItem.platform,
                id: nextMusicItem.id,
            });

        } catch (e) {
            // 播放失败
            this.setCurrentQuality(AppConfig.getConfig("playMusic.defaultQuality"));
            messageBus.sendCommand('mpvStop');
            this.ee.emit(PlayerEvents.Error, nextMusicItem, e)
        }


    }

    public async playMusic(musicItem: IMusic.IMusicItem, options: IPlayOptions = {}) {
        if (!musicItem) {
            return;
        }
        const queueIndex = this.findMusicIndex(musicItem);
        if (queueIndex === -1) {
            // TODO: 用add代替
            const newQueue = [
                ...this.musicQueue,
                {
                    ...musicItem,
                    [timeStampSymbol]: Date.now(),
                    [sortIndexSymbol]: 0
                }
            ]
            this.setMusicQueue(newQueue);
            await this.playIndex(newQueue.length - 1, options);
        } else {
            await this.playIndex(queueIndex, options);
        }
    }

    public async playMusicWithReplaceQueue(musicList: IMusic.IMusicItem[], musicItem?: IMusic.IMusicItem) {
        if (!musicList.length && !musicItem) {
            return;
        }
        addSortProperty(musicList);
        if (this.repeatMode === RepeatMode.Shuffle) {
            musicList = shuffle(musicList);
        }
        musicItem = musicItem ?? musicList[0];
        this.setMusicQueue(musicList);
        await this.playMusic(musicItem);
    }

    public skipToPrev() {
        if (this.isEmpty) {
            this.setCurrentMusic(null);
            this.currentIndex = -1;
            return;
        }
        this.playIndex(this.currentIndex - 1);
    }

    public skipToNext() {
        if (this.isEmpty) {
            this.setCurrentMusic(null);
            this.currentIndex = -1;
            return;
        }
        this.playIndex(this.currentIndex + 1);
    }


    // 重置播放状态
    public reset() {
        messageBus.sendCommand('mpvStop');
        this.setMusicQueue([]);
        this.setCurrentMusic(null);
        this.resetProgress();
        this.currentIndex = -1;
        this.setPlayerState(PlayerState.None);

        // [新增] 发送一个完整的重置状态给主进程，确保插件安全
        messageBus.sendCommand('appStatePatch', {
            musicItem: null,
            playerState: PlayerState.None,
            progress: 0,
            duration: 0,
            lyricText: null,
            parsedLrc: null,
            fullLyric: null,
        })
    }

    public seekTo(seconds: number) {
        messageBus.sendCommand('mpvSeek', seconds);
    }

    public pause() {
        if (this.playerState === PlayerState.Playing) {
            messageBus.sendCommand('mpvTogglePause');
            this.setPlayerState(PlayerState.Paused);
        }
    }

    public async resume() {
        if (!this.currentMusic) {
            return;
        }

        if (this.playerState === PlayerState.Paused) {
            messageBus.sendCommand('mpvTogglePause');
            this.setPlayerState(PlayerState.Playing);
        } else if (this.playerState !== PlayerState.Playing) {
            console.log(`Resume: Player state is ${this.playerState}, re-issuing play command.`);
            await this.playIndex(this.currentIndex, {
                restartOnSameMedia: false,
                seekTo: this.progress.currentTime
            });
        }
    }

    public setVolume(volume: number, sendCommand = true) {
        currentVolumeStore.setValue(volume);
        setUserPreference("volume", volume);
        if (sendCommand) {
            messageBus.sendCommand('mpvSetVolume', volume);
        }
    }

    public setSpeed(speed: number, sendCommand = true) {
        currentSpeedStore.setValue(speed);
        setUserPreference("speed", speed);
        if (sendCommand) {
            messageBus.sendCommand('mpvSetSpeed', speed);
        }
    }

    public addNext(musicItems: IMusic.IMusicItem | IMusic.IMusicItem[]) {
        let _musicItems: IMusic.IMusicItem[];
        if (Array.isArray(musicItems)) {
            _musicItems = musicItems;
        } else {
            _musicItems = [musicItems];
        }

        const now = Date.now();

        let duplicateIndex = -1;
        _musicItems.forEach((item, index) => {
            _musicItems[index] = {
                ...item,
                [timeStampSymbol]: now,
                [sortIndexSymbol]: index,
            };
            if (duplicateIndex === -1 && this.isCurrentMusic(item)) {
                duplicateIndex = index;
            }
        });

        if (duplicateIndex !== -1) {
            _musicItems = [
                _musicItems[duplicateIndex],
                ..._musicItems.slice(0, duplicateIndex),
                ..._musicItems.slice(duplicateIndex + 1),
            ];
        }


        const startPart = [];
        const tailPart = [];

        const oldQueue = this.musicQueue;
        const uniqueMap = createUniqueMap(_musicItems);

        for (let i = 0; i < oldQueue.length; ++i) {
            if (i <= this.currentIndex) {
                if (!uniqueMap.has(oldQueue[i])) {
                    startPart.push(oldQueue[i]);
                }
            } else {
                if (!uniqueMap.has(oldQueue[i])) {
                    tailPart.push(oldQueue[i]);
                }
            }
        }


        const newQueue = [
            ...startPart,
            ..._musicItems,
            ...tailPart
        ];

        this.setMusicQueue(newQueue);
    }


    public removeMusic(musicItems: IMusic.IMusicItem | IMusic.IMusicItem[] | number) {
        if (Array.isArray(musicItems)) {
            const uniqueMap = createUniqueMap(musicItems);

            const newQueue = [];
            const oldQueue = this.musicQueue;

            for (let i = 0; i < oldQueue.length; i++) {
                const musicItem = oldQueue[i];
                if (uniqueMap.has(musicItem)) {
                    if (this.currentIndex === i) {
                        messageBus.sendCommand('mpvStop');
                        this.currentIndex = -1;
                        this.resetProgress();
                        this.setCurrentMusic(null);
                    }
                } else {
                    newQueue.push(musicItem);
                    if (this.currentIndex === i) {
                        this.currentIndex = newQueue.length - 1;
                    }
                }
            }
            this.setMusicQueue(newQueue);
        } else {

            const musicIndex = typeof musicItems === "number" ? musicItems : this.findMusicIndex(musicItems);
            if (musicIndex === -1) {
                return;
            }
            if (musicIndex === this.currentIndex) {
                messageBus.sendCommand('mpvStop');
                this.currentIndex = -1;
                this.resetProgress();
                this.setCurrentMusic(null);
            }

            const newQueue = [...this.musicQueue];
            newQueue.splice(musicIndex, 1);
            this.setMusicQueue(newQueue);
        }
    }


    public async setQuality(quality: IMusic.IQualityKey) {
        const currentMusic = this.currentMusic;
        if (currentMusic && quality !== this.currentQuality) {
            const { mediaSource, quality: realQuality } = await this.fetchMediaSource(currentMusic, quality)
            if (this.isCurrentMusic(currentMusic)) {
                this.setTrack(mediaSource, currentMusic, {
                    seekTo: this.progress.currentTime ?? 0,
                    autoPlay: this.playerState === PlayerState.Playing
                })
                this.setCurrentQuality(realQuality);
            }
        }
    }

    public setRepeatMode(repeatMode: RepeatMode) {
        if (repeatMode === RepeatMode.Shuffle) {
            this.setMusicQueue(shuffle(this.musicQueue));
        } else if (this.repeatMode === RepeatMode.Shuffle) {
            this.setMusicQueue(sortByTimestampAndIndex(this.musicQueue, true));
        }
        
        // [修改] 将循环状态同步到主进程
        if (repeatMode === RepeatMode.Loop) {
            messageBus.sendCommand('mpvSetLoop', true);
        } else {
            messageBus.sendCommand('mpvSetLoop', false);
        }

        repeatModeStore.setValue(repeatMode);
        setUserPreference("repeatMode", repeatMode);
        this.ee.emit(PlayerEvents.RepeatModeChanged, repeatMode);
    }

    public async setAudioOutputDevice(deviceId?: string) {
        // console.warn("setAudioOutputDevice is not implemented with MPV yet.");
    }

    public setMusicQueue(musicQueue: IMusic.IMusicItem[]) {
        musicQueueStore.setValue(musicQueue);
        setUserPreferenceIDB("playList", musicQueue);
        this.indexMap.update(musicQueue);
        this.currentIndex = this.findMusicIndex(this.currentMusic);
    }


    public async fetchCurrentLyric(forceLoad = false) {
        const currentMusic = this.currentMusic;

        if (!currentMusic) {
            this.setCurrentLyric(null);
            return;
        }

        const currentLyric = this.lyric;
        if (!forceLoad && currentLyric && this.isCurrentMusic(currentLyric?.parser?.musicItem)) {
            return;
        }
        try {
            // 获取被关联的歌词
            const linkedLyricItem = await getLinkedLyric(currentMusic);
            let lyricSource: ILyric.ILyricSource;

            if (linkedLyricItem) {
                lyricSource = await PluginManager.callPluginDelegateMethod(
                    linkedLyricItem,
                    "getLyric",
                    linkedLyricItem
                )
            }
            if (!lyricSource && this.isCurrentMusic(currentMusic)) {
                lyricSource = await PluginManager.callPluginDelegateMethod(
                    currentMusic,
                    "getLyric",
                    currentMusic
                );
            }

            if (!this.isCurrentMusic(currentMusic)) {
                return;
            }

            if (!lyricSource?.rawLrc && !lyricSource?.translation) {
                this.setCurrentLyric({});
            }
            const parser = new LyricParser(lyricSource.rawLrc, {
                musicItem: currentMusic,
                translation: lyricSource.translation
            });

            this.setCurrentLyric({
                parser,
                currentLrc: parser.getPosition(this.progress.currentTime || 0)
            });
        } catch (e) {
            logger.logError("歌词解析失败", e);
            this.setCurrentLyric({});
        }


    }


    private async fetchMediaSource(musicItem: IMusic.IMusicItem, quality?: IMusic.IQualityKey) {
        const defaultQuality = AppConfig.getConfig("playMusic.defaultQuality");
        const whenQualityMissing = AppConfig.getConfig("playMusic.whenQualityMissing");

        const qualityOrder = getQualityOrder(quality ?? defaultQuality, whenQualityMissing);

        let mediaSource: IPlugin.IMediaSourceResult | null = null;
        let realQuality: IMusic.IQualityKey = qualityOrder[0];

        // 1. 判断是否已下载
        const downloadedData = getInternalData<IMusic.IMusicItemInternalData>(
            musicItem,
            "downloadData"
        );
        if (downloadedData) {
            const { quality, path: _path } = downloadedData;
            if (await fsUtil.isFile(_path)) {
                return {
                    quality,
                    mediaSource: {
                        url: fsUtil.addFileScheme(_path),
                    },
                };
            } else {
                // TODO 删除
            }
        }

        // 2. 如果没有下载
        for (const quality of qualityOrder) {
            try {
                mediaSource = await PluginManager.callPluginDelegateMethod(
                    {
                        platform: musicItem.platform,
                    },
                    "getMediaSource",
                    musicItem,
                    quality
                );
                if (!mediaSource?.url) {
                    continue;
                }
                realQuality = quality;
                break;
            } catch {
                // pass
            }
        }
        return {
            quality: realQuality,
            mediaSource: mediaSource
        }
    }


    // 只读数据的设置
    private setCurrentMusic(musicItem: IMusic.IMusicItem | null) {
        if (!this.isCurrentMusic(musicItem)) {
            currentMusicStore.setValue(musicItem);
            this.ee.emit(PlayerEvents.MusicChanged, musicItem);
            this.fetchCurrentLyric();
            this.setCurrentLyric(null);

            if (musicItem) {
                setUserPreference("currentMusic", musicItem);
            } else {
                removeUserPreference("currentMusic");
                // [新增] 当音乐停止时，也调用 resetProgress 以确保状态一致
                this.resetProgress();
                // [新增] 发送一个完整的重置状态给主进程
                messageBus.sendCommand('appStatePatch', {
                    musicItem: null,
                    playerState: this.playerState, // 保持当前播放器状态（可能是None或Paused）
                    progress: 0,
                    duration: 0,
                    lyricText: null,
                    parsedLrc: null,
                    fullLyric: null,
                });
            }
        } else {
            // 相同的歌曲，不需要额外触发事件
            currentMusicStore.setValue(musicItem);
        }
    }

    private setProgress(progress: CurrentTime) {
        progressStore.setValue(progress);
        setUserPreference("currentProgress", progress.currentTime);
        this.ee.emit(PlayerEvents.ProgressChanged, progress);
    }

    private setCurrentQuality(quality: IMusic.IQualityKey) {
        setUserPreference("currentQuality", quality);
        currentQualityStore.setValue(quality);
    }

    private setCurrentLyric(lyric?: ICurrentLyric) {
        const prev = this.lyric;
        currentLyricStore.setValue(lyric);

        if (lyric?.parser !== prev?.parser) {
            this.ee.emit(PlayerEvents.LyricChanged, lyric?.parser ?? null);
        } else if (lyric?.currentLrc !== prev?.currentLrc) {
            this.ee.emit(PlayerEvents.CurrentLyricChanged, lyric?.currentLrc ?? null);
        }
    }

    private setPlayerState(playerState: PlayerState) {
        playerStateStore.setValue(playerState);
        this.ee.emit(PlayerEvents.StateChanged, playerState);
    }

    // 获取音乐在播放列表中的下标
    private findMusicIndex(musicItem?: IMusic.IMusicItem | null) {
        if (!musicItem) {
            return -1;
        }
        return this.indexMap.indexOf(musicItem);
    }


    private resetProgress() {
        resetProgress();
        removeUserPreference("currentProgress");
    }

    private setTrack(mediaSource: IPlugin.IMediaSourceResult, musicItem: IMusic.IMusicItem, options: ITrackOptions = { autoPlay: true }) {
        this.resetProgress();

        console.log(`[Renderer] Sending 'mpvPlay' command for track: ${musicItem.title}`, { url: mediaSource.url });
        messageBus.sendCommand('mpvPlay', { url: mediaSource.url });

        if (options.seekTo >= 0) {
            setTimeout(() => messageBus.sendCommand('mpvSeek', options.seekTo), 200);
        }

        if (options.autoPlay) {
            this.setPlayerState(PlayerState.Playing);
        } else {
            setTimeout(() => {
                messageBus.sendCommand('mpvTogglePause');
            }, 100);
            this.setPlayerState(PlayerState.Paused);
        }
    }


    // 判断某首歌是否是当前播放的歌曲
    public isCurrentMusic(musicItem: IMusic.IMusicItem) {
        return isSameMedia(musicItem, this.currentMusic);
    }

}


export default new TrackPlayer();
