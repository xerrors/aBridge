# Go Agent 服务

Agent 接收 HTTP 任务，通过模型选择下一步，再调用 aBridge MCP 操作选定的 Android 设备。服务为任务打开控制会话，交替读取观察和执行结果，任务结束后关闭会话。设备恢复后，服务重新建立会话并读取当前画面。模型收到当前设备的屏幕元素、工具说明和执行回执。任务 API 与 aBridge MCP 分别使用自己的 Bearer Key。

## 本地运行

准备 Go 1.24 或更新版本、已运行的 aBridge Server、已上线并允许屏幕与触控输入的 Android 模拟器，以及已配置的 DeepSeek API Key。也支持其他兼容 OpenAI Chat Completions 工具调用的模型端点。在管理台创建 Agent 连接，选中测试设备并授予 `screen` 和 `input`。

| 环境变量                    | 用途                                                |
| --------------------------- | --------------------------------------------------- |
| `ABRIDGE_MCP_URL`           | aBridge MCP 地址，例如 `http://127.0.0.1:18820/mcp` |
| `ABRIDGE_AGENT_KEY`         | 管理台签发的、覆盖目标设备的 Agent Key              |
| `ABRIDGE_TASK_KEY`          | 任务 HTTP API 的 Bearer Key，至少 24 个字符         |
| `ABRIDGE_MODEL_URL`         | 兼容 API 基址，默认 `https://api.deepseek.com`      |
| `ABRIDGE_MODEL`             | 默认 `deepseek-flash`，使用自定义端点时填写模型名称 |
| `ABRIDGE_MODEL_KEY`         | 可选显式模型 API Key，自定义端点按实际要求配置      |
| `DEEPSEEK_API_KEY`          | 系统中的 DeepSeek 凭据，DeepSeek 官方端点可直接读取 |
| `ABRIDGE_AGENT_LISTEN`      | 监听地址，默认 `127.0.0.1:18821`                    |
| `ABRIDGE_AGENT_PARALLELISM` | 同时执行的任务上限，默认 2                          |

从仓库根目录构建，配置上述环境变量后启动。

```sh
npm run agent:build
./dist/agent/abridge-agent
```

向已授权设备发任务。将示例设备 ID 换成管理台中该 Android 设备的 ID。使用响应里的任务 ID 查询状态。

```sh
curl --fail-with-body http://127.0.0.1:18821/tasks \
  -H "Authorization: Bearer $ABRIDGE_TASK_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"device_id":"DEVICE_ID","prompt":"查看当前屏幕并描述显示的内容"}'

curl --fail-with-body http://127.0.0.1:18821/tasks/TASK_ID \
  -H "Authorization: Bearer $ABRIDGE_TASK_KEY"
```

可以取消排队、等待或执行中的任务。取消中的任务显示 `cancelling`，执行器退出并关闭会话后显示 `cancelled`。同一设备的下一任务会等待此次清理完成。取消不会撤回已经发生的输入，已完成任务的结果保持原状态。

```sh
curl --fail-with-body -X DELETE http://127.0.0.1:18821/tasks/TASK_ID \
  -H "Authorization: Bearer $ABRIDGE_TASK_KEY"
```

同一设备的任务按提交顺序执行，不同设备可并行。任务执行前与模型决策后会检查目标设备状态。设备离线、熄屏或锁屏时，任务分别显示 `waiting_for_device`、`waiting_for_screen` 或 `waiting_for_unlock`，每次等待最多 60 秒，并受原有 3 分钟任务期限约束。恢复后先关闭旧会话、打开新会话并重新观察，再让模型选择下一步；等待前已经规划的输入会丢弃。手动暂停仍需用户在设备上恢复访问。当前等待状态通过任务查询返回，服务不发送解锁推送；用户可从 Android 的后台待命常驻通知进入 aBridge 查看状态。收到结果未知或无法确认的输入回执时，任务停止。当前版本在进程内保存任务，重启后从空队列开始；屏幕输入使用元素树，截图与长期任务历史尚待实现。连接公网前应为任务入口另行配置 HTTPS。

```sh
npm run agent:check
```
