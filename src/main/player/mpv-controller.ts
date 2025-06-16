// src/main/player/mpv-controller.ts
import { spawn, ChildProcessWithoutNullStreams, execSync } from 'child_process';
import { EventEmitter } from 'eventemitter3';
import { app } from 'electron';
import * as net from 'net';
import { PlayerState } from '../../common/constant';
import { nanoid } from 'nanoid/non-secure';

// 定义 MPV 事件和我们自己的内部事件
interface MpvEvents {
    'state-change': (state: PlayerState) => void;
    'progress-update': (progress: { currentTime: number; duration: number }) => void;
    'finished': void;
    'error': (err: Error) => void;
}

// MPV JSON IPC 消息接口
interface MpvMessage {
    event?: string;
    data?: any;
    request_id?: number;
    error?: string;
    name?: string;
    reason?: string;
}

// 为 Windows 命名管道生成唯一路径
const socketPath = `\\\\.\\pipe\\mpvsocket-${nanoid(8)}`;

class MpvController extends EventEmitter<MpvEvents> {
    private mpvProcess: ChildProcessWithoutNullStreams | null = null;
    private socket: net.Socket | null = null;
    private buffer = '';
    private requestIdCounter = 1;
    private commandCallbacks = new Map<number, (err: string | null, data: any) => void>();
    private lastProgress = { currentTime: 0, duration: 0 };
    private isReady = false;
    private commandQueue: any[] = [];
    private currentUrl: string | null = null;
    private loop = false;
    private isStopping = false;
    private watchdogTimer: NodeJS.Timeout | null = null;
    private lastWatchdogProgress = -1;
    private fileLoadTimeout: NodeJS.Timeout | null = null;

    // [新增] 预加载方法，加载但不播放
    public async load(url: string) {
        this.lastWatchdogProgress = -1;
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        if (!this.mpvProcess) {
            this.startMpvProcess();
        }

        this.currentUrl = url;
        // [修复] 分解为两个正确的命令：先加载，再暂停
        this.sendCommand(['loadfile', url, 'replace']).catch(e => console.error("loadfile failed:", e));
        this.sendCommand(['set_property', 'pause', true]).catch(e => console.error("set pause after load failed:", e));
        this.applyLoopProperty(); // 确保预加载后也应用循环属性
    }

    public async play(url: string) {
        this.lastWatchdogProgress = -1;
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        if (!this.mpvProcess) {
            this.startMpvProcess();
        }

        this.currentUrl = url;
        // Use `loadfile` which is more robust for changing tracks and looping.
        this.sendCommand(['loadfile', url, 'replace'])
            .then(() => {
                this.startWatchdog();
            })
            .catch(e => {
                console.error("loadfile failed, skipping to next:", e);
                // If loading fails directly, we must emit 'finished' to allow the player
                // to proceed to the next track in the playlist.
                this.emit('finished');
            });
        this.applyLoopProperty(); // 每次播放新歌曲时，都重新应用循环属性
    }

    private startMpvProcess() {
        if (this.mpvProcess) {
            // It should have been stopped before starting a new one.
            // But as a safeguard:
            this.stop();
        }

        const args = [
            `--input-ipc-server=${socketPath}`,
            '--idle=yes',
            '--no-video',
            '--cache=yes',
            '--demuxer-max-bytes=300M', // 增加到 200MB 缓存
        ];

        try {
            const command = process.platform === 'win32' ? 'mpv.exe' : 'mpv';
            this.mpvProcess = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
            this.emit('state-change', PlayerState.Buffering);

            this.mpvProcess.on('error', this.handleProcessError);
            this.mpvProcess.on('close', this.handleProcessClose);

            this.connect();
        } catch (error) {
            this.emit('error', error);
            this.stop(); // Clean up on spawn error
        }
    }

    private connect(retryCount = 0) {
        if (retryCount > 15) {
            this.emit('error', new Error('MPV socket connection timed out.'));
            return;
        }

        setTimeout(() => {
            if (!this.mpvProcess) return;
            this.socket = net.createConnection({ path: socketPath });
            this.socket.on('connect', this.handleSocketConnect);
            this.socket.on('data', this.handleSocketData);
            this.socket.on('error', (err: Error) => this.handleSocketError(err, retryCount));
            this.socket.on('close', this.handleSocketClose);
        }, 200); // Increased delay slightly for stability
    }

    private handleSocketData = (data: Buffer) => {
        this.buffer += data.toString('utf-8');
        let newlineIndex;
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIndex);
            this.buffer = this.buffer.slice(newlineIndex + 1);
            if (line) {
                try {
                    const msg: MpvMessage = JSON.parse(line);
                    this.handleMpvMessage(msg);
                } catch (e) {
                    console.error('Failed to parse MPV message:', line, e);
                }
            }
        }
    }

    private handleMpvMessage(msg: MpvMessage) {
        if (msg.event === 'start-file') {
            if (this.fileLoadTimeout) clearTimeout(this.fileLoadTimeout);
            this.fileLoadTimeout = setTimeout(() => {
                console.log('Watchdog: file-loaded timeout. Skipping to next...');
                this.emit('finished');
            }, 15000); // 15秒加载超时
        } else if (msg.event === 'file-loaded') {
            if (this.fileLoadTimeout) clearTimeout(this.fileLoadTimeout);
        } else if (msg.event === 'property-change') {
            if (msg.name === 'pause') {
                this.emit('state-change', msg.data ? PlayerState.Paused : PlayerState.Playing);
            } else if (msg.name === 'duration' && typeof msg.data === 'number') {
                this.lastProgress.duration = msg.data;
                // Don't emit yet, wait for time-pos to have a complete picture
            } else if (msg.name === 'time-pos' && typeof msg.data === 'number') {
                this.lastProgress.currentTime = msg.data;
                if (this.lastProgress.duration > 0) { // Only emit when we have a valid duration
                    this.emit('progress-update', { ...this.lastProgress });
                }
            }
        } else if (msg.event === 'end-file' && (msg.reason === 'eof' || msg.reason === 'error')) {
            if (this.fileLoadTimeout) clearTimeout(this.fileLoadTimeout);
            this.stopWatchdog();
            this.lastProgress = { currentTime: 0, duration: 0 };
            // Loop is now handled by mpv's native loop-file property, so we only emit 'finished'.
            this.emit('finished');
        } else if (msg.request_id && this.commandCallbacks.has(msg.request_id)) {
            const callback = this.commandCallbacks.get(msg.request_id);
            callback(msg.error === 'success' ? null : msg.error, msg.data);
            this.commandCallbacks.delete(msg.request_id);
        }
    }

    private sendCommand(command: any[], isInternal = false): Promise<any> {
        if (!this.isReady && !isInternal) {
            this.commandQueue.push(command);
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            if (!this.socket || this.socket.destroyed) {
                if (!isInternal) this.commandQueue.push(command);
                return reject(new Error('MPV socket is not connected.'));
            }

            const requestId = this.requestIdCounter++;
            const payload = { command, request_id: requestId };

            const timeout = setTimeout(() => {
                if (this.commandCallbacks.has(requestId)) {
                    this.commandCallbacks.delete(requestId);
                    reject(new Error(`Command timed out: ${command[0]}`));
                }
            }, 3000); // 3-second timeout

            this.commandCallbacks.set(requestId, (err, data) => {
                clearTimeout(timeout);
                err ? reject(new Error(err)) : resolve(data);
            });

            this.socket.write(JSON.stringify(payload) + '\n');
        });
    }

    public async togglePause() {
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        // If process was recovered, a new one will be started by the next command that needs it.
        // If no process, queueing will handle it.
        this.sendCommand(['get_property', 'pause'], true).then(isPaused => {
            if (isPaused) { // it's about to play
                this.startWatchdog();
            } else { // it's about to pause
                this.stopWatchdog();
            }
        }).catch(() => { /* do nothing on failure */ });
        this.sendCommand(['cycle', 'pause']).catch(e => console.error("togglePause failed:", e));
    }
    public async seek(seconds: number) {
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        this.sendCommand(['set_property', 'time-pos', seconds]).catch(e => console.error("seek failed:", e));
    }
    public async setVolume(level: number) {
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        this.sendCommand(['set_property', 'volume', level]).catch(e => console.error("setVolume failed:", e));
    }
    public async setSpeed(speed: number) {
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        this.sendCommand(['set_property', 'speed', speed]).catch(e => console.error("setSpeed failed:", e));
    }
    // [修改] setLoop 只更新内部状态，由 play/load 方法去应用
    public async setLoop(enable: boolean) {
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        this.loop = enable;
        // 如果已经有音乐在播放，则立即应用循环属性
        if (this.currentUrl) {
            this.applyLoopProperty();
        }
    }

    private applyLoopProperty() {
        const loopValue = this.loop ? 'inf' : 'no';
        this.sendCommand(['set_property', 'loop-file', loopValue]).catch(e => console.error("setLoopProperty failed:", e));
    }


    private async healthCheck(): Promise<boolean> {
        try {
            await this.sendCommand(['get_property', 'pid'], true);
            return true;
        } catch (error) {
            console.error('Health check failed:', error.message);
            return false;
        }
    }

    private async recover() {
        console.log('MPV process is unresponsive. Recovering...');
        // Only job is to clean up the dead process.
        // The calling method will handle starting a new one.
        await this.stop();
    }


    public async stop() {
        if (this.isStopping) return;
        this.isStopping = true;
        this.stopWatchdog();
        console.log('MpvController stop called.');

        this.isReady = false;
        this.currentUrl = null;

        if (this.socket && !this.socket.destroyed) {
            this.socket.end();
        }

        if (this.mpvProcess && !this.mpvProcess.killed) {
            console.log(`Killing mpv.exe process with PID: ${this.mpvProcess.pid}`);
            this.mpvProcess.kill();
        }

        this.commandQueue = [];
        this.socket = null;
        this.mpvProcess = null;
        this.emit('state-change', PlayerState.None);
        this.isStopping = false;
    }

    private stopWatchdog() {
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        if (this.fileLoadTimeout) {
            clearTimeout(this.fileLoadTimeout);
            this.fileLoadTimeout = null;
        }
    }

    private startWatchdog() {
        this.stopWatchdog(); // Clear any existing timer

        this.watchdogTimer = setInterval(async () => {
            if (this.mpvProcess && this.isReady) {
                const isPlaying = !(await this.sendCommand(['get_property', 'pause'], true).catch(() => true));
                const currentProgress = await this.sendCommand(['get_property', 'time-pos'], true).catch(() => -1);
                const duration = this.lastProgress.duration;

                // 检查1: 健康检查失败 (最高优先级)
                if (!await this.healthCheck()) {
                    console.log('Watchdog: Unhealthy process detected. Recovering...');
                    const urlToRecover = this.currentUrl;
                    await this.recover();
                    if (urlToRecover) {
                        this.play(urlToRecover);
                    }
                    return; // 恢复后，本次检查结束
                }

                // 检查2: 播放是否停滞
                const isStalled = currentProgress > 0 && currentProgress === this.lastWatchdogProgress;
                if (!isStalled) {
                    this.lastWatchdogProgress = currentProgress;
                    return; // 如果没有停滞，直接更新进度并结束本次检查
                }

                // 如果播放停滞了，判断是否需要跳过
                // 条件1: 播放器仍在播放状态，但进度没动 (通用卡死)
                // 条件2: 播放器可能已暂停，但进度卡在离结尾不到3秒的地方 (VBR文件结尾卡死)
                const isStuckAtEnd = duration > 0 && (duration - currentProgress < 3);

                if (isPlaying || isStuckAtEnd) {
                    if (isStuckAtEnd) {
                        console.log('Watchdog: Playback stalled near end. Assuming finished. Skipping to next...');
                    } else {
                        console.log('Watchdog: Playback stalled mid-track. Skipping to next...');
                    }
                    this.stopWatchdog();
                    this.emit('finished');
                }
                // 如果只是普通暂停（且不在结尾），则什么也不做
            }
        }, 5000); // Check every 5 seconds
    }

    private handleSocketConnect = async () => {
        console.log('MPV socket connected.');
        this.isReady = true;

        // Observe properties needed for playback control
        await this.sendCommand(['observe_property', 1, 'time-pos'], true);
        await this.sendCommand(['observe_property', 2, 'duration'], true);
        await this.sendCommand(['observe_property', 3, 'pause'], true);

        // Execute any queued commands
        console.log(`Executing ${this.commandQueue.length} queued commands.`);
        while (this.commandQueue.length > 0) {
            const command = this.commandQueue.shift();
            if (command) {
                await this.sendCommand(command).catch(e => console.error("Queued command failed:", e));
            }
        }
    };
    private handleProcessError = (err: Error) => { this.emit('error', err); this.stop(); };
    private handleProcessClose = () => {
        // [修复] 只记录日志，不调用 stop()，防止重入
        console.log('MPV process closed.');
    };
    private handleSocketError = (err: Error, retryCount: number) => {
        console.error(`MPV socket error (retry ${retryCount}):`, err.message);
        this.isReady = false;
        if (this.mpvProcess && !this.mpvProcess.killed) {
            // Don't retry indefinitely if the process is gone.
            this.connect(retryCount + 1);
        }
    };
    private handleSocketClose = () => {
        console.log('MPV socket closed.');
        this.isReady = false;
        this.socket = null;
    };
}

export default new MpvController();