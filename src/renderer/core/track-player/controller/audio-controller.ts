/**
 * 播放音乐
 */
import { encodeUrlHeaders } from "@/common/normalize-util";
import albumImg from "@/assets/imgs/album-cover.jpg";
import getUrlExt from "@/renderer/utils/get-url-ext";
import Hls, { Events as HlsEvents, HlsConfig } from "hls.js";
import { isSameMedia } from "@/common/media-util";
import { PlayerState } from "@/common/constant";
import ServiceManager from "@shared/service-manager/renderer";
import ControllerBase from "@renderer/core/track-player/controller/controller-base";
import { ErrorReason } from "@renderer/core/track-player/enum";
import Dexie from "dexie";
import voidCallback from "@/common/void-callback";
import { IAudioController } from "@/types/audio-controller";
import Promise = Dexie.Promise;

declare var AV: any;

interface IInternalSetTrackOptions {
    seekTo?: number;
    autoPlay?: boolean; // 新增 autoPlay 选项
}

class AudioController extends ControllerBase implements IAudioController {
    private audio: HTMLAudioElement;
    private hls: Hls;
    private alacPlayer: any | null = null;
    private activePlayerType: 'native' | 'hls' | 'alac' | null = null;

    private _playerState: PlayerState = PlayerState.None;
    get playerState() {
        return this._playerState;
    }
    set playerState(value: PlayerState) {
        if (this._playerState !== value) {
            this.onPlayerStateChanged?.(value);
        }
        this._playerState = value;
    }

    public musicItem: IMusic.IMusicItem | null = null;

    get hasSource() {
        return !!this.audio.src;
    }

    constructor() {
        super();
        this.audio = new Audio();
        this.audio.preload = "auto";
        this.audio.controls = false;

        ////// events
        this.audio.onplaying = () => {
            this.playerState = PlayerState.Playing;
            navigator.mediaSession.playbackState = "playing";
        }

        this.audio.onpause = () => {
            this.playerState = PlayerState.Paused;
            navigator.mediaSession.playbackState = "paused";
        }

        this.audio.onerror = (event) => { // Default error handler, will be overridden in tryNativePlayback
            this.playerState = PlayerState.Paused;
            navigator.mediaSession.playbackState = "paused";
            this.onError?.(ErrorReason.EmptyResource, event as any);
        }

        this.audio.ontimeupdate = () => {
            this.onProgressUpdate?.({
                currentTime: this.audio.currentTime,
                duration: this.audio.duration, // 缓冲中是Infinity
            });
        }

        this.audio.onended = () => {
            this.playerState = PlayerState.Paused;
            this.onEnded?.();
        }

        this.audio.onvolumechange = () => {
            this.onVolumeChange?.(this.audio.volume);
        }

        this.audio.onratechange = () => {
            this.onSpeedChange?.(this.audio.playbackRate);
        }

        // @ts-ignore  isDev
        window.ad = this.audio;
    }

    private destroyAlacPlayer(): void {
        if (this.alacPlayer) {
            this.alacPlayer.stop();
            this.alacPlayer = null;
        }
    }

    private initHls(config?: Partial<HlsConfig>) {
        if (!this.hls) {
            this.hls = new Hls(config);
            this.hls.attachMedia(this.audio);
            this.hls.on(HlsEvents.ERROR, (evt, error) => {
                this.onError(ErrorReason.EmptyResource, error);
            })
        }
    }

    private destroyHls() {
        if (this.hls) {
            this.hls.detachMedia();
            this.hls.off(HlsEvents.ERROR);
            this.hls.destroy();
            this.hls = null;
        }
    }

    destroy(): void {
        this.destroyHls();
        this.reset();
        this.destroyAlacPlayer();
    }

    pause(): void {
        if (this.alacPlayer && this.activePlayerType === 'alac') {
            this.alacPlayer.pause();
            this.playerState = PlayerState.Paused;
            navigator.mediaSession.playbackState = "paused";
        } else if (this.activePlayerType === 'native' || this.activePlayerType === 'hls') {
            this.audio.pause();
        }
    }

    play(): void {
        if (this.alacPlayer && this.activePlayerType === 'alac') {
            this.alacPlayer.play();
            this.playerState = PlayerState.Playing;
            navigator.mediaSession.playbackState = "playing";
        } else if (this.activePlayerType === 'native' || this.activePlayerType === 'hls') {
            this.audio.play().catch(voidCallback);
        }
    }

    reset(): void {
        this.playerState = PlayerState.None;
        this.audio.src = "";
        this.audio.removeAttribute("src");
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
        this.destroyHls();
        this.destroyAlacPlayer();
        this.activePlayerType = null;
    }

    seekTo(seconds: number): void {
        if (this.alacPlayer && this.activePlayerType === 'alac') {
            if (isFinite(seconds)) {
                const wasPlaying = this.playerState === PlayerState.Playing;
                if (wasPlaying) {
                    this.alacPlayer.pause(); // 先暂停，避免seek时音频混乱
                }
                this.playerState = PlayerState.Buffering; // 进入缓冲状态
                navigator.mediaSession.playbackState = "paused"; // 或者 "buffering" 如果支持

                this.alacPlayer.seek(seconds * 1000); // Aurora.js Player 的 seek 方法通常接受毫秒
                
                if (wasPlaying) {
                    this.alacPlayer.play(); // 指示播放器在缓冲好后播放
                    // playerState 会在 progress 事件中转为 Playing
                }
            }
        } else if (this.hasSource && isFinite(seconds)) { // 原生 audio 或 HLS
            const duration = this.audio.duration;
            this.audio.currentTime = Math.min(
                seconds, isNaN(duration) ? Infinity : duration
            );
        }
    }

    setLoop(isLoop: boolean): void {
        this.audio.loop = isLoop;
    }

    setSinkId(deviceId: string): Promise<void> {
        return (this.audio as any).setSinkId(deviceId);
    }

    setSpeed(speed: number): void {
        this.audio.defaultPlaybackRate = speed;
        this.audio.playbackRate = speed;
    }

    prepareTrack(musicItem: IMusic.IMusicItem) {
        this.musicItem = { ...musicItem };

        navigator.mediaSession.metadata = new MediaMetadata({
            title: musicItem.title,
            artist: musicItem.artist,
            album: musicItem.album,
            artwork: [
                {
                    src: musicItem.artwork ?? albumImg,
                },
            ],
        });

        this.playerState = PlayerState.None;
        this.audio.src = "";
        this.audio.removeAttribute("src");
        this.destroyHls();
        this.destroyAlacPlayer();
        this.activePlayerType = null;
        navigator.mediaSession.playbackState = "none";
    }

    setTrackSource(trackSource: IMusic.IMusicSource, musicItem: IMusic.IMusicItem, options?: IInternalSetTrackOptions): void {
        this.musicItem = { ...musicItem };

        navigator.mediaSession.metadata = new MediaMetadata({
            title: musicItem.title,
            artist: musicItem.artist,
            album: musicItem.album,
            artwork: [{ src: musicItem.artwork ?? albumImg }],
        });
        
        if (!trackSource || !trackSource.url) {
            this.onError(ErrorReason.EmptyResource, new Error("trackSource or trackSource.url is empty"));
            this.reset();
            return;
        }

        let url = trackSource.url;
        let urlObj: URL;
        try {
            urlObj = new URL(trackSource.url);
        } catch (e) {
            this.onError(ErrorReason.EmptyResource, new Error(`Invalid trackSource.url: ${trackSource.url}. Error: ${(e as Error).message}`));
            this.reset();
            return;
        }


        let headers: Record<string, any> | null = null;

        if (trackSource.headers || trackSource.userAgent) {
            headers = { ...(trackSource.headers ?? {}) };
            if (trackSource.userAgent) {
                headers["user-agent"] = trackSource.userAgent;
            }
        }

        if (urlObj.username && urlObj.password) {
            const authHeader = `Basic ${btoa(`${decodeURIComponent(urlObj.username)}:${decodeURIComponent(urlObj.password)}`)}`;
            urlObj.username = "";
            urlObj.password = "";
            headers = { ...(headers || {}), Authorization: authHeader };
            url = urlObj.toString();
        }
        
        let processedUrl: string;
        try {
            processedUrl = headers ? ServiceManager.RequestForwarderService.forwardRequest(url, "GET", headers) || encodeUrlHeaders(url, headers) : url;
        } catch (e) {
            this.onError(ErrorReason.EmptyResource, new Error(`Error processing URL headers: ${(e as Error).message}`));
            this.reset();
            return;
        }
        
        if (!processedUrl) {
            this.onError(ErrorReason.EmptyResource, new Error("processedUrl is empty after header processing"));
            this.reset();
            return;
        }

        this.destroyHls();
        this.destroyAlacPlayer();
        this.audio.removeAttribute("src");
        this.audio.onerror = null; 
        
        const sourceUrlExt = getUrlExt(trackSource.url);

        if (sourceUrlExt === ".m3u8") {
            this.tryHlsPlayback(processedUrl, options);
        } else {
            this.tryNativePlayback(processedUrl, musicItem, trackSource, options);
        }
    }

    setVolume(volume: number): void {
        this.audio.volume = volume;
        if (this.alacPlayer && this.activePlayerType === 'alac') {
            this.alacPlayer.volume = Math.round(volume * 100);
        }
    }

    private tryNativePlayback(url: string, musicItem: IMusic.IMusicItem, originalTrackSource: IMusic.IMusicSource, options?: IInternalSetTrackOptions) {
        this.activePlayerType = 'native';
        this.audio.onerror = (event) => {
            console.warn("Native playback failed, trying ALAC.js for:", musicItem.title, event);
            if (this.activePlayerType === 'native') { 
                this.playerState = PlayerState.Paused;
                navigator.mediaSession.playbackState = "paused";
                this.tryAlacPlayback(url, musicItem, originalTrackSource, options); 
            }
        };
        this.audio.src = url;
        if (options && options.autoPlay) { // 修改了这里
           this.audio.play().catch(e => { 
               console.warn("Native audio.play() rejected immediately:", e);
               if (this.activePlayerType === 'native') { 
                   this.tryAlacPlayback(url, musicItem, originalTrackSource, options);
               }
           });
        }
    }

    private tryHlsPlayback(url: string, options?: IInternalSetTrackOptions) {
        if (Hls.isSupported()) {
            this.activePlayerType = 'hls';
            this.initHls();
            this.hls.loadSource(url);
            if (options?.autoPlay) {
                this.audio.play().catch(voidCallback); 
            }
        } else {
            this.onError(ErrorReason.UnsupportedResource, new Error("HLS not supported"));
        }
    }

    private tryAlacPlayback(url: string, musicItem: IMusic.IMusicItem, originalTrackSource: IMusic.IMusicSource, options?: IInternalSetTrackOptions) {
        if (typeof AV === 'undefined' || !AV.Decoder.find('alac')) {
            this.onError(ErrorReason.UnsupportedResource, new Error("ALAC.js or AV not available."));
            this.activePlayerType = null;
            return;
        }

        try {
            this.activePlayerType = 'alac';
            const asset = AV.Asset.fromURL(url); 
            this.alacPlayer = new AV.Player(asset);

            this.alacPlayer.on('progress', (durationPlayedMs: number) => {
                try {
                    if (this.alacPlayer && this.activePlayerType === 'alac') {
                        const totalDurationMs = this.alacPlayer.asset && typeof this.alacPlayer.asset.duration === 'number' ? this.alacPlayer.asset.duration : Infinity;
                        this.onProgressUpdate?.({
                            currentTime: durationPlayedMs / 1000,
                            duration: totalDurationMs / 1000,
                        });
                        // 如果之前是缓冲状态，现在收到progress，说明开始播放了
                        if (this.playerState === PlayerState.Buffering) {
                            this.playerState = PlayerState.Playing;
                            navigator.mediaSession.playbackState = "playing";
                        }
                    }
                } catch (e) {
                    console.error("Error in ALAC progress callback:", e);
                }
            });

            this.alacPlayer.on('error', (err: any) => {
                try {
                    if (this.activePlayerType === 'alac') {
                        this.onError?.(ErrorReason.UnsupportedResource, err);
                        this.playerState = PlayerState.Paused;
                        navigator.mediaSession.playbackState = "paused";
                        this.activePlayerType = null; 
                    }
                } catch (e) {
                    console.error("Error in ALAC error callback:", e);
                }
            });

            this.alacPlayer.on('end', () => {
                try {
                    if (this.activePlayerType === 'alac') {
                        this.playerState = PlayerState.Paused;
                        this.onEnded?.();
                    }
                } catch (e) {
                    console.error("Error in ALAC end callback:", e);
                }
            });
            
            if (options?.autoPlay) {
                this.alacPlayer.play(); 
                // 初始播放时，也先设置为Buffering，由progress事件转为Playing
                this.playerState = PlayerState.Buffering;
                navigator.mediaSession.playbackState = "paused"; // 或者 "buffering"
            }

        } catch (e) {
            this.onError?.(ErrorReason.UnsupportedResource, e as Error);
            this.activePlayerType = null;
        }
    }
}

export default AudioController;