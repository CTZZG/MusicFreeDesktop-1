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

    // [新增] 预加载方法，加载但不播放
    public load(url: string) {
        this.currentUrl = url;
        if (!this.mpvProcess) {
            this.startMpvProcess();
        }
        // [修复] 分解为两个正确的命令：先加载，再暂停
        this.sendCommand(['loadfile', url, 'replace']).catch(e => console.error("loadfile failed:", e));
        this.sendCommand(['set_property', 'pause', true]).catch(e => console.error("set pause after load failed:", e));
        this.applyLoopProperty(); // 确保预加载后也应用循环属性
    }

    public play(url: string) {
        this.currentUrl = url;
        if (!this.mpvProcess) {
            this.startMpvProcess();
        }
        // Use `loadfile` which is more robust for changing tracks and looping.
        this.sendCommand(['loadfile', url, 'replace']).catch(e => console.error("loadfile failed:", e));
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
        ];

        try {
            this.mpvProcess = spawn('mpv', args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
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
        if (msg.event === 'property-change') {
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
        } else if (msg.event === 'end-file' && msg.reason === 'eof') {
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
                // If we are trying to send a command but the socket is dead, queue it.
                // This can happen during reconnection attempts.
                if (!isInternal) this.commandQueue.push(command);
                return reject(new Error('MPV socket is not connected.'));
            }
            const requestId = this.requestIdCounter++;
            const payload = { command, request_id: requestId };
            this.commandCallbacks.set(requestId, (err, data) => err ? reject(new Error(err)) : resolve(data));
            this.socket.write(JSON.stringify(payload) + '\n');
        });
    }

    public togglePause = () => this.sendCommand(['cycle', 'pause']).catch(e => console.error("togglePause failed:", e));
    public seek = (seconds: number) => this.sendCommand(['set_property', 'time-pos', seconds]).catch(e => console.error("seek failed:", e));
    public setVolume = (level: number) => this.sendCommand(['set_property', 'volume', level]).catch(e => console.error("setVolume failed:", e));
    public setSpeed = (speed: number) => this.sendCommand(['set_property', 'speed', speed]).catch(e => console.error("setSpeed failed:", e));
    // [修改] setLoop 只更新内部状态，由 play/load 方法去应用
    public setLoop = (enable: boolean) => {
        this.loop = enable;
        // 如果已经有音乐在播放，则立即应用循环属性
        if (this.currentUrl) {
            this.applyLoopProperty();
        }
    };

    private applyLoopProperty() {
        const loopValue = this.loop ? 'inf' : 'no';
        this.sendCommand(['set_property', 'loop-file', loopValue]).catch(e => console.error("setLoopProperty failed:", e));
    }


    public stop() {
        if (this.isStopping) {
            return;
        }
        this.isStopping = true;
        console.log('MpvController stop called.');

        this.isReady = false;
        this.currentUrl = null;
        if (this.socket && !this.socket.destroyed) {
            this.socket.end();
        }

        try {
            if (process.platform === "win32") {
                console.log('Force killing all mpv processes on Windows...');
                // 使用 stdio: 'ignore' 来抑制所有输出，避免编码问题和因“进程未找到”引发的 execSync 错误
                execSync('taskkill /F /IM mpv.exe /T', { stdio: 'ignore' });
                execSync('taskkill /F /IM mpv.com /T', { stdio: 'ignore' });
            } else { // macOS and Linux
                console.log(`Force killing all mpv processes on ${process.platform}.`);
                execSync('pkill -9 mpv', { stdio: 'ignore' });
            }
            console.log('Kill commands executed.');
        } catch (e) {
            // 现在，只有在命令本身（如 taskkill）不存在时才会捕获到错误
            console.error(`Execution of kill command failed: ${e.message}`);
        }

        this.commandQueue = [];
        this.socket = null;
        this.mpvProcess = null;
        this.emit('state-change', PlayerState.None);
        this.isStopping = false;
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