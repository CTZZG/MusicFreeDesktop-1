import { IAppState, ICommand } from "@shared/message-bus/type";
import { IWindowManager } from "@/types/main/window-manager";
import { BrowserWindow, ipcMain, MessageChannelMain } from "electron";
import { PlayerState, RepeatMode } from "@/common/constant";
import EventEmitter from "eventemitter3";

/**
 * 消息总线
 * 包括应用状态、指令的同步
 */
class MessageBus {

    private windowManager: IWindowManager;
    private extensionWindowIds = new Set<number>();
    private appState: IAppState = {
        musicItem: null,
        playerState: PlayerState.None,
        repeatMode: RepeatMode.Loop,
        lyricText: null,
    };
    private ee = new EventEmitter<{
        stateChanged: [IAppState, IAppState]
    }>();
    private commandEE = new EventEmitter();

    public setup(windowManager: IWindowManager) {
        this.windowManager = windowManager;

        // 配置现有窗口
        const extensionWindows = this.windowManager.getExtensionWindows();
        for (const bWindow of extensionWindows) {
            this.createPortForExtensionWindow(bWindow);
        }
        windowManager.on("WindowCreated", (data) => {
            if (data.windowName !== "main") {
                this.createPortForExtensionWindow(data.browserWindow);
            }
        });

        ipcMain.on("@shared/message-bus/sync-app-state", (_, data: IAppState) => {
            this.appState = {
                ...this.appState,
                ...data,
            };
            this.ee.emit("stateChanged", this.appState, data);
        })

        ipcMain.on("@shared/message-bus/command", (_, { command, data }) => {
            this.commandEE.emit(command, data);
        })
    }

    public onAppStateChange(cb: (state: IAppState, changedAppState: IAppState) => void) {
        this.ee.on("stateChanged", cb);
    }

    public onCommand<T extends keyof ICommand>(command: T, cb: (data: ICommand[T]) => void) {
        this.commandEE.on(command, cb);
    }

    public syncAppState(patch: Partial<IAppState>) {
        this.appState = {
            ...this.appState,
            ...patch,
        };
        this.ee.emit("stateChanged", this.appState, patch);

        const allWindows = this.windowManager.getAllWindows();
        for(const bWindow of allWindows) {
            bWindow.webContents.send("@shared/message-bus/message", {
                type: "app-state-changed",
                payload: {
                    patch,
                },
                timestamp: Date.now()
            });
        }
    }

    /**
     * 发送指令
     * @param command 指令
     * @param data 数据
     */
    public sendCommand<T extends keyof ICommand>(command: T, data?: ICommand[T]) {
        const mainWindow = this.windowManager.mainWindow;
        if (mainWindow) {
            mainWindow.webContents.send("@shared/message-bus/message", {
                type: "command",
                payload: {
                    command,
                    data,
                },
                timestamp: Date.now(),
            });
        }
    }

    public getAppState() {
        return this.appState;
    }

    // 创建通信端口
    private createPortForExtensionWindow(bWindow: BrowserWindow) {
        const mainWindow = this.windowManager.mainWindow;
        if (!mainWindow || bWindow === mainWindow) {
            return;
        }
        const { port1, port2 } = new MessageChannelMain();
        const extWindowId = bWindow.id;
        this.extensionWindowIds.add(extWindowId);

        // 通知主窗口更新
        mainWindow.webContents.postMessage("port", {
            payload: extWindowId,
            type: "mount",
            timestamp: Date.now(),
        }, [port1]);

        bWindow.webContents.postMessage("port", null, [port2]);
        bWindow.on("close", () => {
            mainWindow.webContents.postMessage("port", {
                payload: extWindowId,
                type: "unmount",
                timestamp: Date.now(),
            });
            this.extensionWindowIds.delete(extWindowId);
        });

    }
}


const messageBus = new MessageBus();
export default messageBus;
