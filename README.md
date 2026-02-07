# Network Request Copier - Chrome 扩展

一个可以同时复制 DevTools Network 面板中 Request 和 Response 内容的 Chrome 扩展。

## 安装步骤

1. **生成图标**（可选）
   - 在浏览器中打开 `create-icons.html`
   - 下载三个图标文件到 `icons` 文件夹
   - 或者使用你自己的 16x16、48x48、128x128 PNG 图标

2. **加载扩展**
   - 打开 Chrome，访问 `chrome://extensions/`
   - 开启右上角的「开发者模式」
   - 点击「加载已解压的扩展程序」
   - 选择这个项目文件夹

3. **使用方法**
   - 打开任意网页，按 F12 打开 DevTools
   - 在 DevTools 顶部标签栏找到「Request Copier」面板
   - 刷新页面或进行操作，请求会自动显示在列表中
   - 点击选择一个请求
   - 点击按钮复制 Request + Response 或单独复制

## 功能

- 自动捕获所有网络请求
- 支持 URL 过滤
- 一键复制 Request + Response
- 单独复制 Request 或 Response
- 格式化 JSON 输出
- 深色主题界面

## 复制内容包含

**Request:**
- URL
- Method
- Headers
- Query Parameters
- Request Body (POST/PUT 等)

**Response:**
- Status Code
- Headers
- Response Body
