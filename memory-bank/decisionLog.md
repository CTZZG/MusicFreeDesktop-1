# 决策日志

此日志记录项目期间做出的关键架构和实现决策。

## 2025-07-25: 任务 1 - 自定义 MPV 路径

**结果**: 已成功实现自定义 MPV 路径功能。

**详细变更**:
*   **应用配置**: 在 `src/types/app-config.d.ts` 中添加了 `playMusic.mpvPath` 选项，并在 `src/shared/app-config/default-app-config.ts` 中设置了默认值。
*   **设置界面**: 在 `src/renderer/pages/main-page/views/setting-view/routers/PlayMusic/index.tsx` 中添加了路径选择器。
*   **MPV 调用逻辑**: 更新了 `src/main/player/mpv-controller.ts` 以优先使用用户设置的 MPV 路径。
*   **代码质量**: 修复了实现过程中出现的多个 ESLint 警告。

## 2025-07-25: 任务 2 - MPV 代理设置

**结果**: 已成功实现 MPV 代理设置功能。

**详细变更**:
*   **MPV 调用逻辑**: 更新了 `src/main/player/mpv-controller.ts`，在启动 `mpv` 进程时，如果应用设置了代理，则将代理服务器地址作为 `--http-proxy` 参数传递给 `mpv`。
*   **Bug 修复**: 解决了当用户输入的主机地址包含 `http://` 前缀时，生成的代理 URL 会重复协议头的问题。
