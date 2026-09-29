# 提示词完善工作台

主应用是一个纯浏览器端的提示词访谈与迭代工具。它会逐个询问需求细节；只有点击“生成并评分”后才生成提示词。页面使用原生 HTML、CSS 和 JavaScript，不需要 Python 后端或依赖安装。

## 启动

可直接打开 `static/index.html`。也可以从仓库根目录启动一个静态文件服务器：

```powershell
python -m http.server 8001 --directory static
```

然后访问 <http://127.0.0.1:8001>。静态服务器只负责提供网页文件，不处理模型请求或保存会话。建议始终使用同一个浏览器和网页地址，以便继续访问该来源下的本地数据。

## 模型配置

点击页面右上角的模型名称，设置 OpenAI 兼容接口或 Ollama 的 Base URL 和模型名称。可以获取模型列表，也可以手动填写；设置窗口提供连接测试。

模型请求由浏览器直接发送到所选服务。OpenAI 兼容服务需要允许网页来源的跨域请求，并放行 `Authorization` 和 `Content-Type` 请求头。Ollama 需要在 `OLLAMA_ORIGINS` 中允许网页来源。例如，使用上面的静态服务器时，OpenAI 兼容服务应允许来源 `http://127.0.0.1:8001`，并允许 `GET`、`POST`、`OPTIONS` 以及 `Authorization`、`Content-Type` 请求头；换用其他地址时请改成实际网页来源。Ollama 通过 `OLLAMA_ORIGINS` 允许该来源。直接以 `file://` 打开时，浏览器可能发送 `null` 来源，部分服务会拒绝跨域请求，因此推荐使用静态服务器。

API Key 只保存在当前页面内存中，关闭或刷新页面后需要重新输入；模型服务、Base URL 和模型名称保存在当前浏览器。不要连接不可信的模型服务，浏览器会把请求内容和临时 API Key 发送给所配置的服务。

## 数据

会话、问答、反馈、提示词版本及模型设置保存在浏览器的 IndexedDB 中（不可用时尝试使用本地存储）。数据只属于当前浏览器配置和网页来源；清除浏览器站点数据会删除这些记录。原有的 `data/prompt_refiner.db` 若存在会保留在本机，但浏览器端不会自动导入其中的旧会话。

`demo/` 是独立的宝可梦图鉴原型，不属于主应用。需要刷新图鉴数据时，才在 `demo/` 中运行 `python sync_pokemon.py`；该脚本会重建生成数据。

## 技术结构

- `static/index.html`：主应用页面
- `static/styles.css`：页面样式
- `static/app.js`：界面交互
- `static/browser-api.js`：浏览器存储及模型服务调用
- `demo/`：独立原型和数据工具
