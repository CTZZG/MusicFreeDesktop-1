import { spawn, ChildProcessWithoutNullStreams, execSync } from 'child_process';
import { EventEmitter } from 'eventemitter3';
import { app } from 'electron';
import * as net from 'net';
import { PlayerState } from '../../common/constant';
import { nanoid } from 'nanoid/non-secure';

interface MpvEvents {
    'state-change': (state: PlayerState) => void;
    'progress-update': (progress: { currentTime: number; duration: number }) => void;
    'finished': void;
    'error': (err: Error) => void;
}

interface MpvMessage {
    event?: string;
    data?: any;
    request_id?: number;
    error?: string;
    name?: string;
    reason?: string;
}

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
    private isRecovering = false;
    private readonly MAX_SOCKET_RETRIES = 8;
    private lastKnownState: PlayerState = PlayerState.None;

    public async load(url: string) {
        this.lastKnownState = PlayerState.Buffering;
        this.emit('state-change', PlayerState.Buffering);
        if (this.isRecovering) {
            console.warn('Blocked load during recovery');
            return;
        }
        this.lastWatchdogProgress = -1;
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        if (!this.mpvProcess) {
            this.startMpvProcess();
        }

        this.currentUrl = url;
        this.sendCommand(['loadfile', url, 'replace']).catch(e => console.error("loadfile failed:", e));
        this.sendCommand(['set_property', 'pause', true]).catch(e => console.error("set pause after load failed:", e));
        this.applyLoopProperty();
    }

    public async play(url: string) {
        this.lastKnownState = PlayerState.Buffering;
        this.emit('state-change', PlayerState.Buffering);
        if (this.isRecovering) {
            console.warn('Blocked play during recovery');
            return;
        }
        this.lastWatchdogProgress = -1;
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        if (!this.mpvProcess) {
            this.startMpvProcess();
        }

        this.currentUrl = url;
        this.sendCommand(['loadfile', url, 'replace'])
            .then(() => {
                this.startWatchdog();
            })
            .catch(e => {
                console.error("loadfile failed, skipping to next:", e);
                this.emit('finished');
            });
        this.applyLoopProperty();
    }

    private startMpvProcess() {
        if (this.mpvProcess) {
            this.stop();
        }

        const args = [
            '--reset-on-next-file=vf,af,metadata,chapters',
            '--pause=no',
            '--demuxer-max-bytes=1000M',
            '--demuxer-max-back-bytes=3m',
            '--keep-open=no',
            `--input-ipc-server=${socketPath}`,
            '--idle=yes',
            '--no-video',
            '--cache=yes',
            '--really-quiet',
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
            this.stop();
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
        }, 500);
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
        // 处理暂停状态变化
        if (msg.event === 'property-change' && msg.name === 'pause') {
            this.lastKnownState = msg.data ? PlayerState.Paused : PlayerState.Playing;
            this.emit('state-change', this.lastKnownState);
        }
        
        // 开始加载新文件
        if (msg.event === 'start-file') {
            // 更新为缓冲状态
            this.lastKnownState = PlayerState.Buffering;
            this.emit('state-change', PlayerState.Buffering);
            
            if (this.fileLoadTimeout) clearTimeout(this.fileLoadTimeout);
            this.fileLoadTimeout = setTimeout(() => {
                console.log('Watchdog: file-loaded timeout. Skipping to next...');
                this.emit('finished');
            }, 60000);
        } 
        // 文件加载完成
        else if (msg.event === 'file-loaded') {
            if (this.fileLoadTimeout) clearTimeout(this.fileLoadTimeout);
            
            // 更新为播放状态（除非显式暂停）
            if (this.lastKnownState !== PlayerState.Paused) {
                this.lastKnownState = PlayerState.Playing;
                this.emit('state-change', PlayerState.Playing);
            }
        } 
        // 属性变化
        else if (msg.event === 'property-change') {
            if (msg.name === 'duration' && typeof msg.data === 'number') {
                this.lastProgress.duration = msg.data;
            } else if (msg.name === 'time-pos' && typeof msg.data === 'number') {
                this.lastProgress.currentTime = msg.data;
                if (this.lastProgress.duration > 0) {
                    this.emit('progress-update', { ...this.lastProgress });
                }
            }
        } 
        // 播放结束
        else if (msg.event === 'end-file' && (msg.reason === 'eof' || msg.reason === 'error')) {
            if (this.fileLoadTimeout) clearTimeout(this.fileLoadTimeout);
            this.stopWatchdog();
            this.lastProgress = { currentTime: 0, duration: 0 };
            
            // 更新为停止状态
            this.lastKnownState = PlayerState.None;
            this.emit('state-change', PlayerState.None);
            this.emit('finished');
        } 
        // 命令响应
        else if (msg.request_id && this.commandCallbacks.has(msg.request_id)) {
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
            }, 15000);

            this.commandCallbacks.set(requestId, (err, data) => {
                clearTimeout(timeout);
                err ? reject(new Error(err)) : resolve(data);
            });

            this.socket.write(JSON.stringify(payload) + '\n');
        });
    }

    public async togglePause() {
        if (this.isRecovering) {
            console.warn('Blocked togglePause during recovery');
            return;
        }
        
        try {
            const isPaused = await this.sendCommand(['get_property', 'pause'], true);
            // 立即更新本地状态
            this.lastKnownState = isPaused ? PlayerState.Playing : PlayerState.Paused;
            this.emit('state-change', this.lastKnownState);
            
            if (isPaused) {
                this.startWatchdog();
            } else {
                this.stopWatchdog();
            }
            
            await this.sendCommand(['cycle', 'pause']);
        } catch (e) {
            console.error("togglePause failed:", e);
        }
    }

    public async seek(seconds: number) {
        if (this.isRecovering) {
            console.warn('Blocked load during recovery');
            return;
        }
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        this.sendCommand(['set_property', 'time-pos', seconds]).catch(e => console.error("seek failed:", e));
    }

    public async setVolume(level: number) {
        if (this.isRecovering) {
            console.warn('Blocked load during recovery');
            return;
        }
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        this.sendCommand(['set_property', 'volume', level]).catch(e => console.error("setVolume failed:", e));
    }

    public async setSpeed(speed: number) {
        if (this.isRecovering) {
            console.warn('Blocked load during recovery');
            return;
        }
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        this.sendCommand(['set_property', 'speed', speed]).catch(e => console.error("setSpeed failed:", e));
    }

    public async setLoop(enable: boolean) {
        if (this.isRecovering) {
            console.warn('Blocked load during recovery');
            return;
        }
        if (this.mpvProcess && !(await this.healthCheck())) {
            await this.recover();
        }
        this.loop = enable;
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
            await Promise.race([
                this.sendCommand(['get_property', 'volume'], true),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Health check timeout')), 5000)
                )
            ]);
            return true;
        } catch (error) {
            console.warn('Primary health check failed:', error.message);
        }
        
        try {
            await new Promise(resolve => setTimeout(resolve, 1000));
            await this.sendCommand(['get_property', 'volume'], true);
            return true;
        } catch (retryError) {
            console.error('Secondary health check failed:', retryError.message);
            return false;
        }
    }

    private async recover() {
        if (this.isRecovering) {
            console.log('Recovery already in progress');
            return;
        }
        
        try {
            this.isRecovering = true;
            console.log('Initiating MPV recovery...');
            
            const currentUrl = this.currentUrl;
            const wasPlaying = this.lastKnownState === PlayerState.Playing;
            
            await this.stop();
            
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            if (currentUrl) {
                console.log('Replaying after recovery:', currentUrl);
                this.startMpvProcess();
                
                await new Promise<void>((resolve, reject) => {
                    const timeout = setTimeout(() => 
                        reject(new Error('MPV startup timed out after 15 seconds')), 
                        15000
                    );
                    
                    const checkReady = () => {
                        if (this.isReady) {
                            clearTimeout(timeout);
                            resolve();
                        } else if (!this.mpvProcess || this.mpvProcess.killed) {
                            clearTimeout(timeout);
                            reject(new Error('MPV process died during startup'));
                        } else {
                            setTimeout(checkReady, 100);
                        }
                    };
                    
                    checkReady();
                });
                
                this.currentUrl = currentUrl;
                this.sendCommand(['loadfile', currentUrl, 'replace'])
                    .catch(e => console.error('Recovery load failed:', e));
                
                if (wasPlaying) {
                    setTimeout(() => {
                        this.sendCommand(['set_property', 'pause', false])
                            .catch(e => console.error('Resume play failed:', e));
                    }, 1000);
                }
            }
        } catch (e) {
            console.error('Recovery failed:', e);
            this.emit('error', new Error('Recovery failed: ' + e.message));
            
            console.log('Retrying recovery in 3 seconds...');
            await new Promise(resolve => setTimeout(resolve, 3000));
            await this.recover();
        } finally {
            this.isRecovering = false;
        }
    }


    public async stop() {
        if (this.isStopping) return;
        this.isStopping = true;
        this.stopWatchdog();
        console.log('Stopping MPV controller...');
        
        this.isReady = false;
        this.currentUrl = null;
        this.buffer = '';
        this.commandCallbacks.clear();
    
        if (this.socket && !this.socket.destroyed) {
            try {
                this.socket.destroy();
                this.socket = null;
            } catch (e) {
                console.warn('Socket destroy error:', e);
            }
        }
    
        if (this.mpvProcess && !this.mpvProcess.killed) {
            console.log(`Terminating MPV process (PID: ${this.mpvProcess.pid})`);
            
            const pid = this.mpvProcess.pid;
            this.mpvProcess.removeAllListeners();
            
            try {
                if (process.platform === 'win32') {
                    try {
                        execSync(`tasklist /fi "PID eq ${pid}"`);
                    } catch {
                        console.log('Process already exited');
                        return;
                    }
                    
                    execSync(`taskkill /pid ${pid} /f /t`);
                } else {
                    try {
                        process.kill(-pid, 'SIGKILL');
                    } catch (e) {
                        if (e.code !== 'ESRCH') throw e;
                    }
                }
                console.log('MPV process terminated');
            } catch (e) {
                console.warn('Process termination warning:', e.message);
            } finally {
                this.mpvProcess = null;
            }
        } else {
            this.mpvProcess = null;
        }
    
        this.commandQueue = [];
        this.emit('state-change', PlayerState.None);
        console.log('MPV controller stopped');
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
        this.stopWatchdog();
    
        this.watchdogTimer = setInterval(async () => {
            if (this.isRecovering || !this.mpvProcess || !this.isReady) return;
    
            try {
                const currentProgress = await this.sendCommand(
                    ['get_property', 'time-pos'], 
                    true
                ).catch(() => -1);
                
                if (currentProgress >= 0) {
                    this.lastWatchdogProgress = currentProgress;
                    return;
                }
                
                console.warn('Watchdog command failed, triggering health check');
                if (!(await this.safeHealthCheck())) {
                    console.log('Watchdog: Unhealthy process detected. Recovering...');
                    const urlToRecover = this.currentUrl;
                    await this.recover();
                    if (urlToRecover) this.play(urlToRecover);
                }
            } catch (error) {
                console.error('Watchdog error:', error);
                console.log('Watchdog error detected, triggering recovery');
                const urlToRecover = this.currentUrl;
                await this.recover();
                if (urlToRecover) this.play(urlToRecover);
            }
        }, 30000);
    }
    
    private async safeHealthCheck(): Promise<boolean> {
        try {
            await Promise.race([
                this.sendCommand(['get_property', 'volume'], true),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error('Health check timeout')), 3000)
                )
            ]);
            return true;
        } catch (error) {
            console.warn('Health check failed:', error.message);
            return false;
        }
    }

    private handleSocketConnect = async () => {
        console.log('MPV socket connected.');
        this.isReady = true;

        await this.sendCommand(['observe_property', 1, 'time-pos'], true);
        await this.sendCommand(['observe_property', 2, 'duration'], true);
        await this.sendCommand(['observe_property', 3, 'pause'], true);

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
        console.log('MPV process closed.');
    };
    private handleSocketError = (err: Error, retryCount: number) => {
        console.error(`Socket error (retry ${retryCount}/${this.MAX_SOCKET_RETRIES}):`, err.message);
        
        if (retryCount > this.MAX_SOCKET_RETRIES) {
            console.error('Max socket retries exceeded');
            this.emit('error', new Error('MPV connection failed after retries'));
            return;
        }
        
        const delay = Math.min(1000 * Math.pow(2, retryCount), 8000);
        setTimeout(() => {
            if (this.mpvProcess && !this.mpvProcess.killed) {
                this.connect(retryCount + 1);
            }
        }, delay);
    };
    private handleSocketClose = () => {
        console.log('MPV socket closed.');
        this.isReady = false;
        this.socket = null;
    };
}

export default new MpvController();