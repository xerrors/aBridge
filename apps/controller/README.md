# AI 家 / AI Home

独立 Android 控制端，包名 `com.aihome.app`。它连接 aBridge Server 的 `/controller/` 页面，提供聊天草稿、任务确认和任务状态；接收任务的 aBridge Android 客户端需要单独安装和授权。启用 AI 家 Web 后，Server 首页进入 `/admin`。管理员可在「设备 → 添加 Android 设备」为指定账户生成接收端 Device Key。

## 构建与安装

原生壳需要 JDK 17、Android SDK 36；前端需要 Node.js 与 npm。分别安装控制端 UI 的依赖并构建，再构建 APK：

```sh
npm --prefix apps/controller/ui ci
npm run controller:web:build
cd apps/controller
./gradlew assembleDebug
adb install -r build/outputs/apk/debug/AIHome-debug.apk
```

APK 不包含前端资源。前端由 Server 同源托管，更新后需重新构建并部署 `ui/dist`。安装控制端不会安装或替换接收任务的 aBridge 客户端。

## Server 与工作进程

先按仓库部署说明配置并启动 Server。将 `ABRIDGE_CONTROLLER_WEB_ROOT` 设置为 `apps/controller/ui/dist` 的绝对路径，重启 Server 后访问 `/controller/`；管理台资源继续使用已有配置。嵌入式调用 `createServer` 时使用 `controllerStaticRoot`。控制端不保存 Worker Key 或模型 Key。

任务执行还需要独立 Go 工作进程，设置 `ABRIDGE_TASK_SERVER_URL` 为 Server 基址，并在 Server 和工作进程配置相同的 `ABRIDGE_TASK_KEY`（至少 24 字符）；模型端点与凭据见 [Agent 说明](../agent/README.md)。目标 Android 客户端必须在线、允许屏幕及输入，并支持任务会话清理确认。工作进程未运行时，已确认任务留在 Server 队列中。

首次打开 AI 家时输入 Server Origin，例如 `https://bridge.example.com`，然后使用 Server 账户登录。本机调试可显式打开 HTTP 开关，模拟器连接宿主机使用 `http://10.0.2.2:端口`。公网部署使用 HTTPS。语音输入依赖 Android 可用的系统语音服务，识别结果先填入输入框，任务仍需确认后执行。

## 开发检查

```sh
npm run controller:web:build
(cd apps/controller && ./gradlew testDebugUnitTest lintDebug)
node --import tsx --test apps/server/tests/controller-chat.test.ts
npm run agent:check
npm run check
```

构建及单元测试不能替代真实设备上的登录、语音识别和任务执行验收。
