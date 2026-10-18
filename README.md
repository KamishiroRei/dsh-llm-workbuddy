# dsh-llm-workbuddy

使用已有 WorkBuddy 账号凭据，将其 Chat Completions 网关接入 DeepSeek Harness。支持文本、推理文本和流式工具调用投影；不包含 WorkBuddy 客户端或其源码。

## 安装

需要 Node.js 22.19+、DeepSeek Harness 0.2.1-rc.2，以及账号允许使用的 WorkBuddy bearer token。当前在 Windows 验证，网关可用性和模型权限由服务提供方决定。

```powershell
git clone https://github.com/KamishiroRei/dsh-llm-workbuddy.git
dsh plugin --profile web add ./dsh-llm-workbuddy
```

源码运行 Harness 时可用 `pnpm dsh`。启动 DSH 前设置 `WORKBUDDY_API_KEY`，或将 token 写入 `~/.dsh/workbuddy/token` 第一行；也可在该插件配置中填 `apiKey`。凭据按 config.apiKey、环境变量、token 文件的顺序解析，每次请求重新读取。不要将真实 token 提交到 Git。环境变量 `WORKBUDDY_BASE_URL` 可覆盖默认 `https://www.workbuddy.cn/v2`；备用环境变量名是 `CODEBUDDY_AUTH_TOKEN`、`CODEBUDDY_API_KEY`，备用 token 文件为 `~/.workbuddy/auth-token`。

在 profile 的补丁文件选择默认路由：

```yaml
- id: agent-default-model
  config:
    provider: workbuddy
    model: deepseek-v3-2-volc
```

然后运行 `dsh web`。若另一个适配器已经注册 `workbuddy` 路由，先移除该适配器的 WorkBuddy 配置，避免重复注册；其他供应商可保留。该插件本身只注册适配器，不提供凭据设置 UI。安装后的静态模型目录通过 DSH 的模型发现接口提供。

## 模型与限制

`deepseek-v3-2-volc` 是推荐的工具调用模型。`deepseek-v4.1-flash` 在先前网关验证中返回文本，但未产生工具调用，适合纯对话。目录还列出 GLM、Kimi 和 MiniMax 的候选 ID；账号是否开放及其能力需要另行验证，不将目录存在视为可用承诺。

适配器会把工具调用及工具结果转换成 OpenAI 消息格式。当前请求仅发送文本；图片和文件附件转换成文字占位符，目录中的模态标记不表示此适配器已实现图片传输。网络错误、鉴权错误和上游 HTTP 错误会返回 DSH，不会自动切换供应商或模型。

## 验证

`npm test` 使用本机 SSE 服务检查请求、工具调用与结果投影和错误传播，不访问账号。`npm run test:live` 使用 `WORKBUDDY_API_KEY` 或 token 文件访问真实网关，缺凭据会显式跳过；会消耗少量服务额度。

MIT License.
