// 检测并修复 Chrome API 返回的乱码文本
// Chrome 的 Network.getResponseBody 对 SSE 等流式响应可能用错误编码解析 UTF-8 内容
// 表现为：UTF-8 字节被当作 Windows-1252 逐字节映射到 Unicode 码点
// Windows-1252 在 0x80-0x9F 范围有特殊映射（不同于 Latin-1），导致部分字节
// 被映射到 U+0152, U+2014, U+201C 等超过 0xFF 的码点

// Windows-1252 特殊映射表：Unicode 码点 -> 原始字节值
const WIN1252_SPECIAL = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
  0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
  0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
  0x017E: 0x9E, 0x0178: 0x9F
};

function tryFixGarbledText(str) {
  if (!str) return str;
  // 快速检查：如果字符串中没有 0x80+ 范围的字符，不需要修复
  let hasHighBytes = false;
  let canRecover = true;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0x80) hasHighBytes = true;
    // 检查是否所有字符都可以映射回单字节
    if (code > 0xff && !WIN1252_SPECIAL[code]) {
      canRecover = false;
      break;
    }
  }
  if (!hasHighBytes) return str; // 纯 ASCII，无需修复
  if (!canRecover) return str;   // 包含无法映射回字节的真正 Unicode 字符
  
  // 将 Windows-1252 解码的字符映射回原始字节，然后用 UTF-8 重新解码
  try {
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      if (code <= 0xff) {
        bytes[i] = code;
      } else {
        // Windows-1252 特殊字符，映射回原始字节
        const originalByte = WIN1252_SPECIAL[code];
        if (originalByte !== undefined) {
          bytes[i] = originalByte;
        } else {
          return str; // 无法映射，放弃修复
        }
      }
    }
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (decoded !== str) return decoded;
  } catch {
    // UTF-8 解码失败，返回原文
  }
  return str;
}

const requests = new Map();
let selectedRequestId = null;
let currentTab = 'headers';
let currentTypeFilter = 'fetch';

const requestList = document.getElementById('requestList');
const filterInput = document.getElementById('filter');
const detailContent = document.getElementById('detailContent');
const detailPanel = document.getElementById('detailPanel');
const detailCloseBtn = document.getElementById('detailCloseBtn');
const resizerEl = document.getElementById('resizer');
const toast = document.getElementById('toast');
let detailPanelVisible = true;

function showDetailPanel() {
  detailPanelVisible = true;
  detailPanel.classList.remove('collapsed');
  resizerEl.classList.remove('hidden');
  requestList.classList.remove('expanded');
}

function hideDetailPanel() {
  detailPanelVisible = false;
  detailPanel.classList.add('collapsed');
  resizerEl.classList.add('hidden');
  requestList.classList.add('expanded');
}

detailCloseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  hideDetailPanel();
});

// 根据 MIME 类型和 URL 判断请求类型
function getRequestType(data) {
  const mimeType = (data.response.mimeType || '').toLowerCase();
  const url = data.url.toLowerCase();
  
  // 优先：对明确的静态资源后缀，URL 后缀优先于 mimeType（避免 dev server 错误 MIME）
  if (url.match(/\.css(\?|$)/)) return 'css';
  if (url.match(/\.(js|mjs)(\?|$)/)) return 'js';
  if (url.match(/\.(png|jpg|jpeg|gif|svg|ico|webp|bmp)(\?|$)/)) return 'img';
  if (url.match(/\.(woff2?|ttf|otf|eot)(\?|$)/)) return 'font';
  if (url.match(/\.(mp4|webm|ogg|mp3|wav|m3u8)(\?|$)/)) return 'media';
  if (url.endsWith('.wasm')) return 'wasm';
  if (url.startsWith('ws://') || url.startsWith('wss://')) return 'ws';
  
  // Pending 请求且没有 mimeType：根据请求头和 URL 推断类型
  if (!mimeType) {
    if (url.match(/\.(html?)(\?|$)/)) return 'doc';
    if (url.match(/manifest\.json(\?|$)/)) return 'manifest';
    
    // 没有后缀匹配，根据请求头判断
    const contentType = data.request.headers?.find(h => h.name.toLowerCase() === 'content-type')?.value?.toLowerCase() || '';
    const accept = data.request.headers?.find(h => h.name.toLowerCase() === 'accept')?.value?.toLowerCase() || '';
    if (contentType.includes('json') || accept.includes('json') || data.request.postData) {
      return 'fetch';
    }
    // 无 mimeType 且无法判断的 API 路径，默认 fetch
    return 'fetch';
  }
  
  // 有 mimeType 的情况，按 mimeType 优先分类
  
  // Document（放在 fetch 前面，避免 html 被误判）
  if (mimeType.includes('html') || mimeType.includes('xhtml')) {
    return 'doc';
  }
  
  // CSS
  if (mimeType.includes('css')) {
    return 'css';
  }
  
  // JavaScript
  if (mimeType.includes('javascript') || mimeType.includes('ecmascript')) {
    return 'js';
  }
  
  // Font
  if (mimeType.includes('font') || mimeType.includes('woff') || mimeType.includes('ttf')) {
    return 'font';
  }
  
  // Image
  if (mimeType.includes('image')) {
    return 'img';
  }
  
  // Media
  if (mimeType.includes('video') || mimeType.includes('audio')) {
    return 'media';
  }
  
  // Manifest
  if (mimeType.includes('manifest')) {
    return 'manifest';
  }
  
  // WebAssembly
  if (mimeType.includes('wasm')) {
    return 'wasm';
  }
  
  // Fetch/XHR — JSON、XML、SSE、以及有 XHR 标记或请求头为 JSON 的
  if (mimeType.includes('json') || mimeType.includes('xml') || 
      mimeType.includes('event-stream') ||
      data.request.headers?.some(h => h.name.toLowerCase() === 'x-requested-with') ||
      data.request.headers?.some(h => h.name.toLowerCase() === 'content-type' && h.value.toLowerCase().includes('json'))) {
    return 'fetch';
  }
  
  // text/plain、octet-stream 等模糊类型，根据请求头再判断
  if (data.request.postData || 
      data.request.headers?.some(h => h.name.toLowerCase() === 'content-type' && h.value.toLowerCase().includes('json'))) {
    return 'fetch';
  }
  
  return 'other';
}

// 格式化文件大小
function formatSize(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' kB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// 格式化时间
function formatTime(ms) {
  if (!ms || ms < 0) return '-';
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return Math.round(ms) + ' ms';
  return (ms / 1000).toFixed(2) + ' s';
}

// ==================== Debugger API: 捕获 pending 请求 ====================
const pendingRequestMap = new Map(); // debugger requestId -> our internal id
const allNetworkRequestIds = new Map(); // url -> debugger requestId (保留所有已完成的请求ID，用于下载源码)
const tabId = chrome.devtools.inspectedWindow.tabId;
let debuggerAttached = false;

function attachDebugger() {
  chrome.debugger.attach({ tabId }, '1.3', () => {
    if (chrome.runtime.lastError) {
      console.warn('Debugger attach failed:', chrome.runtime.lastError.message);
      return;
    }
    debuggerAttached = true;
    chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
    chrome.debugger.sendCommand({ tabId }, 'Page.enable', {});
  });
}

attachDebugger();

// 页面导航时重新 attach
chrome.devtools.network.onNavigated.addListener(() => {
  if (!debuggerAttached) {
    attachDebugger();
  }
});

// 监听 debugger detach（用户关闭 DevTools 等）
chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === tabId) {
    debuggerAttached = false;
  }
});

// 监听 debugger 事件
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== tabId) return;

  if (method === 'Network.requestWillBeSent') {
    const reqId = params.requestId;
    const url = params.request.url;
    const reqMethod = params.request.method;

    // 跳过 data: URL 等
    if (url.startsWith('data:') || url.startsWith('chrome-extension:')) return;

    const id = Date.now() + Math.random();
    pendingRequestMap.set(reqId, id);
    allNetworkRequestIds.set(url, reqId);

    // 解析 postData
    let postData = null;
    if (params.request.postData) {
      postData = {
        text: params.request.postData,
        mimeType: params.request.headers?.['Content-Type'] || params.request.headers?.['content-type'] || ''
      };
    }

    // 将 headers 从 object 转为 array 格式
    const headersArray = [];
    if (params.request.headers) {
      for (const [name, value] of Object.entries(params.request.headers)) {
        headersArray.push({ name, value });
      }
    }

    // 解析 queryString
    let queryString = [];
    try {
      const urlObj = new URL(url);
      urlObj.searchParams.forEach((value, name) => {
        queryString.push({ name, value });
      });
    } catch {}

    const requestData = {
      id,
      url,
      method: reqMethod,
      status: 0, // pending
      _pending: true,
      _debuggerRequestId: reqId,
      request: {
        url,
        method: reqMethod,
        httpVersion: '',
        headers: headersArray,
        queryString,
        postData,
        cookies: []
      },
      response: {
        status: 0,
        statusText: '(pending)',
        httpVersion: '',
        headers: [],
        cookies: [],
        content: '',
        encoding: '',
        mimeType: '',
        size: 0
      },
      time: -1,
      startedDateTime: new Date().toISOString()
    };

    requests.set(id, requestData);
    renderRequestList();
  }

  if (method === 'Network.responseReceived') {
    const reqId = params.requestId;
    const id = pendingRequestMap.get(reqId);
    if (id && requests.has(id)) {
      const data = requests.get(id);
      const resp = params.response;
      data.status = resp.status;
      data.response.status = resp.status;
      data.response.statusText = resp.statusText || '';
      data.response.mimeType = resp.mimeType || '';
      data.response.httpVersion = resp.protocol || '';
      // 转换 response headers
      if (resp.headers) {
        data.response.headers = Object.entries(resp.headers).map(([name, value]) => ({ name, value }));
      }
      // 还没完成，保持 pending 标记但更新状态码
      renderRequestList();
      // 如果当前选中的就是这个请求，刷新详情
      if (selectedRequestId === id) renderDetail();
    }
  }

  if (method === 'Network.loadingFinished') {
    const reqId = params.requestId;
    const id = pendingRequestMap.get(reqId);
    if (id && requests.has(id)) {
      const data = requests.get(id);
      data._pending = false;
      // 获取 response body — 使用 Fetch.getResponseBody 或在页面上下文中重新获取
      // Chrome 的 Network.getResponseBody 对 SSE 等流式响应的编码处理有 bug
      // 策略：先用 Network.getResponseBody 获取，然后对文本结果做强制 UTF-8 修复
      chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: reqId }, (result) => {
        if (result && !chrome.runtime.lastError) {
          let body = result.body || '';
          if (result.base64Encoded && body) {
            // base64 编码：解码为 UTF-8
            try {
              const binaryStr = atob(body);
              const bytes = new Uint8Array(binaryStr.length);
              for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
              }
              body = new TextDecoder('utf-8').decode(bytes);
            } catch (e) {
              console.warn('Base64 decode failed:', e);
            }
          } else if (body) {
            // 非 base64 文本模式：Chrome 可能用错误编码解析了 UTF-8 内容
            // 检查是否所有字符都在 0x00-0xFF 范围（Latin-1 损坏的特征）
            body = tryFixGarbledText(body);
          }
          data.response.content = body;
          data.response.encoding = '';
          data.response.size = body ? body.length : 0;
        }
        renderRequestList();
        if (selectedRequestId === id) renderDetail();
      });
      pendingRequestMap.delete(reqId);
    }
  }

  if (method === 'Network.loadingFailed') {
    const reqId = params.requestId;
    const id = pendingRequestMap.get(reqId);
    if (id && requests.has(id)) {
      const data = requests.get(id);
      data._pending = false;
      data.status = 0;
      data.response.statusText = params.errorText || '(failed)';
      renderRequestList();
      if (selectedRequestId === id) renderDetail();
      pendingRequestMap.delete(reqId);
    }
  }
});

// 监听已完成的请求（onRequestFinished 仍保留，用于获取完整的 HAR 数据）
chrome.devtools.network.onRequestFinished.addListener(async (request) => {
  // 检查是否已经通过 debugger 添加过（通过 URL 匹配，不管是否还在 pending）
  const url = request.request.url;
  const existingDebugger = Array.from(requests.values()).find(r =>
    r.url === url && r._debuggerRequestId
  );

  if (existingDebugger) {
    // 用完整的 HAR 数据更新 debugger 捕获的请求（HAR 编码更可靠）
    const id = existingDebugger.id;
    request.getContent ? request.getContent((content, encoding) => {
      updateFromHAR(id, request, content, encoding);
    }) : updateFromHAR(id, request, request.response.content?.text || '', request.response.content?.encoding || '');
  } else {
    addRequest(request);
  }
});

function updateFromHAR(id, request, content, encoding) {
  const data = requests.get(id);
  if (!data) return;

  const debuggerRequestId = data._debuggerRequestId;
  const existingContent = data.response.content;

  data._pending = false;
  data._debuggerRequestId = debuggerRequestId;
  data.status = request.response.status;
  data.request = {
    url: request.request.url,
    method: request.request.method,
    httpVersion: request.request.httpVersion,
    headers: request.request.headers,
    queryString: request.request.queryString,
    postData: request.request.postData,
    cookies: request.request.cookies
  };

  // 检测 HAR content 是否乱码（UTF-8 被当 Latin-1 解读的特征）
  let finalContent;
  if (content) {
    finalContent = tryFixGarbledText(content);
    // 如果修复没变化但 debugger 已有内容，优先用 debugger 的
    if (finalContent === content && existingContent && existingContent !== content) {
      finalContent = existingContent;
    }
  } else {
    finalContent = content || existingContent || '';
  }

  data.response = {
    status: request.response.status,
    statusText: request.response.statusText,
    httpVersion: request.response.httpVersion,
    headers: request.response.headers,
    cookies: request.response.cookies,
    content: finalContent,
    encoding: encoding,
    mimeType: request.response.content?.mimeType,
    size: request.response.content?.size || (finalContent ? finalContent.length : 0)
  };
  data.time = request.time;
  data.startedDateTime = request.startedDateTime;

  renderRequestList();
  if (selectedRequestId === id) renderDetail();
}

// 获取打开 DevTools 之前的请求
chrome.devtools.network.getHAR((harLog) => {
  if (harLog && harLog.entries) {
    harLog.entries.forEach(entry => {
      addRequest(entry);
    });
  }
});

// 添加请求到列表
function addRequest(request) {
  const id = Date.now() + Math.random();
  const url = request.request.url;
  const method = request.request.method;
  const status = request.response.status;
  
  // 检查是否已存在相同 URL 和时间的请求（避免重复）
  const existingRequest = Array.from(requests.values()).find(r => 
    r.url === url && (r.startedDateTime === request.startedDateTime || r._debuggerRequestId)
  );
  if (existingRequest && !existingRequest._pending) return;
  
  request.getContent ? request.getContent((content, encoding) => {
    saveRequest(id, url, method, status, request, content, encoding);
  }) : saveRequest(id, url, method, status, request, request.response.content?.text || '', request.response.content?.encoding || '');
}

function saveRequest(id, url, method, status, request, content, encoding) {
  // 修复可能的 UTF-8 乱码
  let fixedContent = content;
  if (content) {
    fixedContent = tryFixGarbledText(content);
  }

  const requestData = {
    id,
    url,
    method,
    status,
    request: {
      url: request.request.url,
      method: request.request.method,
      httpVersion: request.request.httpVersion,
      headers: request.request.headers,
      queryString: request.request.queryString,
      postData: request.request.postData,
      cookies: request.request.cookies
    },
    response: {
      status: request.response.status,
      statusText: request.response.statusText,
      httpVersion: request.response.httpVersion,
      headers: request.response.headers,
      cookies: request.response.cookies,
      content: fixedContent,
      encoding: encoding,
      mimeType: request.response.content?.mimeType,
      size: request.response.content?.size || (fixedContent ? fixedContent.length : 0)
    },
    time: request.time,
    startedDateTime: request.startedDateTime
  };
  
  requests.set(id, requestData);
  renderRequestList();
}

function renderRequestList() {
  const filter = filterInput.value.toLowerCase();
  const filteredRequests = Array.from(requests.values())
    .filter(r => {
      // URL 筛选
      if (!r.url.toLowerCase().includes(filter)) return false;
      // 类型筛选
      if (currentTypeFilter !== 'all') {
        const type = getRequestType(r);
        if (type !== currentTypeFilter) return false;
      }
      return true;
    })
    .reverse();
  
  if (filteredRequests.length === 0) {
    requestList.innerHTML = '<div class="empty-state">没有匹配的请求</div>';
    return;
  }
  
  requestList.innerHTML = filteredRequests.map(r => {
    const urlObj = new URL(r.url);
    const displayUrl = urlObj.pathname + urlObj.search;
    const isPending = r._pending;
    const statusClass = isPending ? 'pending' : (r.status >= 200 && r.status < 400 ? 'success' : 'error');
    const urlClass = (!isPending && r.status >= 400) ? 'error' : '';
    const selected = r.id === selectedRequestId ? 'selected' : '';
    const size = isPending ? '-' : formatSize(r.response.size || 0);
    const time = isPending ? '(pending)' : formatTime(r.time);
    const statusText = isPending ? (r.status > 0 ? r.status + ' …' : '(pending)') : r.status;

    return `
      <div class="request-item ${selected}" data-id="${r.id}">
        <div class="request-row">
          <button class="copy-icon-btn" data-action="copyAll" data-id="${r.id}" title="复制全部">✓</button>
          <span class="method ${r.method}">${r.method}</span>
          <span class="url ${urlClass}" title="${r.url}">${displayUrl}</span>
          <span class="status ${statusClass}">${statusText}</span>
          <span class="size">${size}</span>
          <span class="time">${time}</span>
        </div>
      </div>
    `;
  }).join('');
}

// 点击选择请求
requestList.addEventListener('click', (e) => {
  const actionBtn = e.target.closest('.copy-icon-btn');
  if (actionBtn) {
    e.stopPropagation();
    const action = actionBtn.dataset.action;
    const id = parseFloat(actionBtn.dataset.id);
    const data = requests.get(id);
    
    if (action === 'copyAll') {
      copyToClipboard(formatCopyAll(data));
    } else if (action === 'copyRequest') {
      copyToClipboard(formatRequestData(data));
    } else if (action === 'copyResponse') {
      copyToClipboard(formatResponseData(data));
    } else if (action === 'replay') {
      replayRequest(data);
    }
    return;
  }
  
  const item = e.target.closest('.request-item');
  if (item) {
    selectedRequestId = parseFloat(item.dataset.id);
    renderRequestList();
    renderDetail();
    if (!detailPanelVisible) {
      showDetailPanel();
    }
  }
});

// Tab 切换
document.querySelectorAll('.detail-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.detail-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    renderDetail();
  });
});

filterInput.addEventListener('input', renderRequestList);

// 类型筛选按钮
document.querySelectorAll('.type-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTypeFilter = btn.dataset.type;
    renderRequestList();
  });
});

// 清空按钮
document.getElementById('clearList').addEventListener('click', () => {
  requests.clear();
  selectedRequestId = null;
  requestList.innerHTML = '<div class="empty-state">等待网络请求...</div>';
  detailContent.innerHTML = '<div class="empty-state">选择一个请求查看详情</div>';
});

// JSON 语法高亮
function syntaxHighlight(json) {
  if (typeof json !== 'string') {
    json = JSON.stringify(json, null, 2);
  }
  return json.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g, (match) => {
    let cls = 'json-number';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'json-key';
        match = match.slice(0, -1) + '</span>:';
        return '<span class="' + cls + '">' + match;
      } else {
        cls = 'json-string';
      }
    } else if (/true|false/.test(match)) {
      cls = 'json-boolean';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return '<span class="' + cls + '">' + match + '</span>';
  });
}

// 渲染 Headers 表格
function renderHeadersTable(headers, title) {
  if (!headers || headers.length === 0) return '';
  
  let html = `<div class="detail-section">
    <div class="section-title">${title}</div>
    <table class="header-table">`;
  
  headers.forEach(h => {
    html += `<tr><td>${escapeHtml(h.name)}</td><td>${escapeHtml(h.value)}</td></tr>`;
  });
  
  html += '</table></div>';
  return html;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderDetail() {
  if (!selectedRequestId) {
    detailContent.innerHTML = '<div class="empty-state">选择一个请求查看详情</div>';
    return;
  }
  
  const data = requests.get(selectedRequestId);
  if (!data) return;
  
  let html = '';
  
  switch (currentTab) {
    case 'headers':
      html = renderHeadersTab(data);
      break;
    case 'payload':
      html = renderPayloadTab(data);
      break;
    case 'response':
      html = renderResponseTab(data);
      break;
    case 'preview':
      html = renderPreviewTab(data);
      break;
  }
  
  detailContent.innerHTML = html;
}

function renderHeadersTab(data) {
  let html = '';
  
  // General 信息
  html += `<div class="detail-section">
    <div class="section-title">General</div>
    <div class="general-info">
      <div><span class="label">Request URL:</span><span class="value">${escapeHtml(data.url)}</span></div>
      <div><span class="label">Request Method:</span><span class="value">${escapeHtml(data.method)}</span></div>
      <div><span class="label">Status Code:</span><span class="value">${data.response.status} ${escapeHtml(data.response.statusText)}</span></div>
    </div>
  </div>`;
  
  // Response Headers
  html += renderHeadersTable(data.response.headers, 'Response Headers');
  
  // Request Headers
  html += renderHeadersTable(data.request.headers, 'Request Headers');
  
  // Query String Parameters
  if (data.request.queryString && data.request.queryString.length > 0) {
    html += `<div class="detail-section">
      <div class="section-title">Query String Parameters</div>
      <table class="header-table">`;
    data.request.queryString.forEach(q => {
      html += `<tr><td>${escapeHtml(q.name)}</td><td>${escapeHtml(q.value)}</td></tr>`;
    });
    html += '</table></div>';
  }
  
  return html;
}

function renderPayloadTab(data) {
  let html = '';
  
  // Query String Parameters
  if (data.request.queryString && data.request.queryString.length > 0) {
    html += `<div class="detail-section">
      <div class="section-title">Query String Parameters</div>
      <table class="header-table">`;
    data.request.queryString.forEach(q => {
      html += `<tr><td>${escapeHtml(q.name)}</td><td>${escapeHtml(q.value)}</td></tr>`;
    });
    html += '</table></div>';
  }
  
  // Request Body
  if (data.request.postData) {
    html += `<div class="detail-section">
      <div class="section-title">Request Payload</div>`;
    
    if (data.request.postData.text) {
      try {
        const json = JSON.parse(data.request.postData.text);
        html += `<div class="code-block">${syntaxHighlight(JSON.stringify(json, null, 2))}</div>`;
      } catch {
        html += `<div class="code-block">${escapeHtml(data.request.postData.text)}</div>`;
      }
    }
    
    if (data.request.postData.params && data.request.postData.params.length > 0) {
      html += '<table class="header-table">';
      data.request.postData.params.forEach(p => {
        html += `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.value)}</td></tr>`;
      });
      html += '</table>';
    }
    
    html += '</div>';
  }
  
  if (!html) {
    html = '<div class="empty-state">没有请求负载</div>';
  }
  
  return html;
}

function renderResponseTab(data) {
  let html = `<div class="detail-section">
    <div class="section-title">Response Body</div>`;
  
  if (data.response.content) {
    try {
      const json = JSON.parse(data.response.content);
      html += `<div class="code-block">${syntaxHighlight(JSON.stringify(json, null, 2))}</div>`;
    } catch {
      html += `<div class="code-block">${escapeHtml(data.response.content)}</div>`;
    }
  } else {
    html += '<div class="empty-state">响应内容为空</div>';
  }
  
  html += '</div>';
  return html;
}

function renderPreviewTab(data) {
  let html = '<div class="detail-section"><div class="section-title">Preview</div>';
  
  if (data.response.content) {
    const mimeType = data.response.mimeType || '';
    
    if (mimeType.includes('json') || data.response.content.trim().startsWith('{') || data.response.content.trim().startsWith('[')) {
      try {
        const json = JSON.parse(data.response.content);
        html += `<div class="code-block">${syntaxHighlight(JSON.stringify(json, null, 2))}</div>`;
      } catch {
        html += `<div class="code-block">${escapeHtml(data.response.content)}</div>`;
      }
    } else if (mimeType.includes('html')) {
      html += `<div class="code-block">${escapeHtml(data.response.content)}</div>`;
    } else if (mimeType.includes('image')) {
      html += `<div class="empty-state">图片预览不可用</div>`;
    } else {
      html += `<div class="code-block">${escapeHtml(data.response.content)}</div>`;
    }
  } else {
    html += '<div class="empty-state">无法预览</div>';
  }
  
  html += '</div>';
  return html;
}

// 显示提示
function showToast(message) {
  toast.textContent = message;
  toast.classList.remove('show');
  void toast.offsetWidth;
  toast.classList.add('show');
}

// 格式化复制全部 - 简洁格式
function formatCopyAll(data) {
  const lines = [];
  
  // URL
  lines.push(`URL: ${data.url}`);
  lines.push('');
  
  // Method
  lines.push(`Method: ${data.method}`);
  lines.push('');
  
  // 请求参数
  lines.push('请求参数:');
  if (data.request.queryString && data.request.queryString.length > 0) {
    data.request.queryString.forEach(q => {
      lines.push(`  ${q.name}: ${q.value}`);
    });
  }
  if (data.request.postData) {
    if (data.request.postData.text) {
      try {
        const json = JSON.parse(data.request.postData.text);
        lines.push(JSON.stringify(json, null, 2));
      } catch {
        lines.push(data.request.postData.text);
      }
    }
    if (data.request.postData.params) {
      data.request.postData.params.forEach(p => {
        lines.push(`  ${p.name}: ${p.value}`);
      });
    }
  }
  if ((!data.request.queryString || data.request.queryString.length === 0) && !data.request.postData) {
    lines.push('  (无)');
  }
  lines.push('');
  
  // 返回
  lines.push('返回:');
  if (data.response.content) {
    try {
      const json = JSON.parse(data.response.content);
      lines.push(JSON.stringify(json, null, 2));
    } catch {
      lines.push(data.response.content);
    }
  } else {
    lines.push('  (空)');
  }
  
  return lines.join('\n');
}

// 格式化请求数据
function formatRequestData(data) {
  const lines = [];
  lines.push('========== REQUEST ==========');
  lines.push(`URL: ${data.request.url}`);
  lines.push(`Method: ${data.request.method}`);
  lines.push('');
  
  lines.push('--- Request Headers ---');
  data.request.headers.forEach(h => {
    lines.push(`${h.name}: ${h.value}`);
  });
  
  if (data.request.queryString && data.request.queryString.length > 0) {
    lines.push('');
    lines.push('--- Query Parameters ---');
    data.request.queryString.forEach(q => {
      lines.push(`${q.name}: ${q.value}`);
    });
  }
  
  if (data.request.postData) {
    lines.push('');
    lines.push('--- Request Body ---');
    if (data.request.postData.text) {
      try {
        const json = JSON.parse(data.request.postData.text);
        lines.push(JSON.stringify(json, null, 2));
      } catch {
        lines.push(data.request.postData.text);
      }
    }
    if (data.request.postData.params) {
      data.request.postData.params.forEach(p => {
        lines.push(`${p.name}: ${p.value}`);
      });
    }
  }
  
  return lines.join('\n');
}

function formatResponseData(data) {
  const lines = [];
  lines.push('========== RESPONSE ==========');
  lines.push(`Status: ${data.response.status} ${data.response.statusText}`);
  lines.push('');
  
  lines.push('--- Response Headers ---');
  data.response.headers.forEach(h => {
    lines.push(`${h.name}: ${h.value}`);
  });
  
  lines.push('');
  lines.push('--- Response Body ---');
  if (data.response.content) {
    try {
      const json = JSON.parse(data.response.content);
      lines.push(JSON.stringify(json, null, 2));
    } catch {
      lines.push(data.response.content);
    }
  } else {
    lines.push('(empty)');
  }
  
  return lines.join('\n');
}

// 重新请求
async function replayRequest(data) {
  showToast('正在重新请求...');
  
  try {
    // 构建请求选项
    const options = {
      method: data.method,
      headers: {}
    };
    
    // 添加请求头（排除一些浏览器自动管理的头）
    const excludeHeaders = ['host', 'connection', 'content-length', 'accept-encoding', 'cookie'];
    data.request.headers.forEach(h => {
      if (!excludeHeaders.includes(h.name.toLowerCase())) {
        options.headers[h.name] = h.value;
      }
    });
    
    // 添加请求体
    if (data.request.postData && data.request.postData.text) {
      options.body = data.request.postData.text;
    }
    
    // 在被检查的页面上下文中执行请求
    const code = `
      (async function() {
        try {
          const response = await fetch(${JSON.stringify(data.url)}, ${JSON.stringify(options)});
          const text = await response.text();
          return {
            status: response.status,
            statusText: response.statusText,
            ok: response.ok,
            bodyLength: text.length
          };
        } catch (e) {
          return { error: e.message };
        }
      })();
    `;
    
    chrome.devtools.inspectedWindow.eval(code, (result, isException) => {
      if (isException) {
        showToast('请求失败: ' + (result?.value || '未知错误'));
      } else if (result?.error) {
        showToast('请求失败: ' + result.error);
      } else {
        showToast(`请求完成: ${result.status} ${result.statusText}`);
      }
    });
  } catch (err) {
    showToast('请求失败: ' + err.message);
  }
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制到剪贴板');
  } catch (err) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('已复制到剪贴板');
  }
}


// 分隔条拖动调整宽度
(function() {
  const resizer = document.getElementById('resizer');
  const requestListEl = document.getElementById('requestList');
  const mainContainer = document.querySelector('.main-container');
  
  if (!resizer || !requestListEl || !mainContainer) {
    console.error('Resizer elements not found');
    return;
  }

  let isResizing = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener('mousedown', function(e) {
    e.preventDefault();
    isResizing = true;
    startX = e.clientX;
    startWidth = requestListEl.offsetWidth;
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');
  });

  document.addEventListener('mousemove', function(e) {
    if (!isResizing) return;
    e.preventDefault();
    
    const dx = e.clientX - startX;
    let newWidth = startWidth + dx;
    
    // 限制最小和最大宽度
    const minWidth = 200;
    const maxWidth = mainContainer.offsetWidth - 200;
    newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
    
    requestListEl.style.width = newWidth + 'px';
  });

  document.addEventListener('mouseup', function() {
    if (isResizing) {
      isResizing = false;
      resizer.classList.remove('dragging');
      document.body.classList.remove('resizing');
    }
  });
  
  console.log('Resizer initialized');
})();


// ==================== Application Storage Panel ====================
(function() {
  const appBtn = document.getElementById('appBtn');
  const appSection = document.getElementById('appSection');
  const appClose = document.getElementById('appClose');
  const vResizer = document.getElementById('vResizer');
  const networkSection = document.getElementById('networkSection');
  const contentWrapper = document.querySelector('.content-wrapper');
  const storageFilter = document.getElementById('storageFilter');
  const storageTableWrap = document.getElementById('storageTableWrap');
  const storageRefresh = document.getElementById('storageRefresh');
  const storageAdd = document.getElementById('storageAdd');
  const storageClearAll = document.getElementById('storageClearAll');

  let currentStorage = 'local'; // 'local' | 'session'
  let storageData = [];
  let selectedStorageKey = null;
  let appVisible = true; // 默认显示

  function showApp() {
    appVisible = true;
    appSection.classList.remove('collapsed');
    vResizer.style.display = '';
    appBtn.classList.add('active');
    loadStorageData();
  }

  function hideApp() {
    appVisible = false;
    appSection.classList.add('collapsed');
    vResizer.style.display = 'none';
    appBtn.classList.remove('active');
  }

  // 切换显示/隐藏
  appBtn.addEventListener('click', () => {
    appVisible ? hideApp() : showApp();
  });

  appClose.addEventListener('click', hideApp);

  // 默认加载
  loadStorageData();

  // 上下拖动分隔条
  (function() {
    let isVResizing = false;
    let startY = 0;
    let startNetH = 0;
    let startAppH = 0;

    vResizer.addEventListener('mousedown', (e) => {
      e.preventDefault();
      isVResizing = true;
      startY = e.clientY;
      startNetH = networkSection.offsetHeight;
      startAppH = appSection.offsetHeight;
      vResizer.classList.add('dragging');
      document.body.classList.add('v-resizing');
    });

    document.addEventListener('mousemove', (e) => {
      if (!isVResizing) return;
      e.preventDefault();
      const dy = e.clientY - startY;
      const totalH = startNetH + startAppH;
      let newNetH = startNetH + dy;
      let newAppH = startAppH - dy;
      const minH = 80;
      if (newNetH < minH) { newNetH = minH; newAppH = totalH - minH; }
      if (newAppH < minH) { newAppH = minH; newNetH = totalH - minH; }
      networkSection.style.flex = 'none';
      networkSection.style.height = newNetH + 'px';
      appSection.style.height = newAppH + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (isVResizing) {
        isVResizing = false;
        vResizer.classList.remove('dragging');
        document.body.classList.remove('v-resizing');
      }
    });
  })();

  // 侧栏切换
  document.querySelectorAll('.app-sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.app-sidebar-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      currentStorage = item.dataset.storage;
      selectedStorageKey = null;
      loadStorageData();
    });
  });

  // 从被检查页面读取 storage 数据
  function loadStorageData() {
    const storageType = currentStorage === 'local' ? 'localStorage' : 'sessionStorage';
    const code = `
      (function() {
        var s = ${storageType};
        var result = [];
        for (var i = 0; i < s.length; i++) {
          var key = s.key(i);
          result.push({ key: key, value: s.getItem(key) });
        }
        return JSON.stringify(result);
      })();
    `;
    chrome.devtools.inspectedWindow.eval(code, (result, isException) => {
      if (isException) {
        storageData = [];
        renderStorageTable();
        return;
      }
      try {
        storageData = JSON.parse(result);
      } catch {
        storageData = [];
      }
      renderStorageTable();
    });
  }

  // 渲染表格
  function renderStorageTable() {
    const filter = (storageFilter.value || '').toLowerCase();
    const filtered = storageData.filter(item =>
      item.key.toLowerCase().includes(filter) || (item.value || '').toLowerCase().includes(filter)
    );

    if (filtered.length === 0) {
      storageTableWrap.innerHTML = `<div class="storage-empty">${storageData.length === 0 ? '暂无数据' : '没有匹配项'}</div>`;
      return;
    }

    let html = `<table class="storage-table">
      <thead><tr>
        <th style="width:36px">#</th>
        <th>Key</th>
        <th>Value</th>
        <th style="width:36px"></th>
      </tr></thead><tbody>`;

    filtered.forEach((item, idx) => {
      const selected = item.key === selectedStorageKey ? 'selected' : '';
      html += `<tr class="${selected}" data-key="${escapeHtml(item.key)}">
        <td style="color:#999;text-align:center">${idx + 1}</td>
        <td class="key-col editable" contenteditable="false" data-field="key" title="${escapeHtml(item.key)}">${escapeHtml(item.key)}</td>
        <td class="val-col editable" contenteditable="false" data-field="value" title="${escapeHtml(item.value)}">${escapeHtml(item.value)}</td>
        <td class="action-col"><button class="storage-delete-btn" data-key="${escapeHtml(item.key)}" title="删除">✕</button></td>
      </tr>`;
    });

    html += '</tbody></table>';
    storageTableWrap.innerHTML = html;

    // 绑定行点击选中
    storageTableWrap.querySelectorAll('tr[data-key]').forEach(tr => {
      tr.addEventListener('click', () => {
        selectedStorageKey = tr.dataset.key;
        storageTableWrap.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
        tr.classList.add('selected');
      });
    });

    // 绑定双击编辑
    storageTableWrap.querySelectorAll('td.editable').forEach(td => {
      td.addEventListener('dblclick', () => {
        td.contentEditable = 'true';
        td.focus();
        // 选中全部文本
        const range = document.createRange();
        range.selectNodeContents(td);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });

      td.addEventListener('blur', () => {
        td.contentEditable = 'false';
        const tr = td.closest('tr');
        const originalKey = tr.dataset.key;
        const field = td.dataset.field;
        const newValue = td.textContent;

        if (field === 'key' && newValue !== originalKey) {
          // key 改了：删旧 key，写新 key
          const storageType = currentStorage === 'local' ? 'localStorage' : 'sessionStorage';
          const oldVal = storageData.find(d => d.key === originalKey)?.value || '';
          const code = `
            (function() {
              ${storageType}.removeItem(${JSON.stringify(originalKey)});
              ${storageType}.setItem(${JSON.stringify(newValue)}, ${JSON.stringify(oldVal)});
            })();
          `;
          chrome.devtools.inspectedWindow.eval(code, () => loadStorageData());
        } else if (field === 'value') {
          const storageType = currentStorage === 'local' ? 'localStorage' : 'sessionStorage';
          const code = `${storageType}.setItem(${JSON.stringify(originalKey)}, ${JSON.stringify(newValue)});`;
          chrome.devtools.inspectedWindow.eval(code, () => loadStorageData());
        }
      });

      td.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          td.blur();
        } else if (e.key === 'Escape') {
          td.contentEditable = 'false';
          loadStorageData(); // 恢复原值
        }
      });
    });

    // 绑定删除按钮
    storageTableWrap.querySelectorAll('.storage-delete-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = btn.dataset.key;
        deleteStorageItem(key);
      });
    });
  }

  // 删除单个 key
  function deleteStorageItem(key) {
    const storageType = currentStorage === 'local' ? 'localStorage' : 'sessionStorage';
    const code = `${storageType}.removeItem(${JSON.stringify(key)});`;
    chrome.devtools.inspectedWindow.eval(code, () => {
      if (selectedStorageKey === key) selectedStorageKey = null;
      showToast('已删除: ' + key);
      loadStorageData();
    });
  }

  // 清空全部
  storageClearAll.addEventListener('click', () => {
    const label = currentStorage === 'local' ? 'Local Storage' : 'Session Storage';
    if (!confirm(`确定要清空所有 ${label} 数据吗？`)) return;
    const storageType = currentStorage === 'local' ? 'localStorage' : 'sessionStorage';
    const code = `${storageType}.clear();`;
    chrome.devtools.inspectedWindow.eval(code, () => {
      selectedStorageKey = null;
      showToast(label + ' 已清空');
      loadStorageData();
    });
  });

  // 添加新条目
  storageAdd.addEventListener('click', () => {
    const storageType = currentStorage === 'local' ? 'localStorage' : 'sessionStorage';
    // 生成一个不重复的 key
    let newKey = 'new-key';
    let i = 1;
    while (storageData.some(d => d.key === newKey)) {
      newKey = 'new-key-' + i++;
    }
    const code = `${storageType}.setItem(${JSON.stringify(newKey)}, '');`;
    chrome.devtools.inspectedWindow.eval(code, () => {
      selectedStorageKey = newKey;
      loadStorageData();
      showToast('已添加新条目，双击可编辑');
    });
  });

  // 刷新
  storageRefresh.addEventListener('click', () => {
    loadStorageData();
    showToast('已刷新');
  });

  // 过滤
  storageFilter.addEventListener('input', renderStorageTable);

  // 键盘 Delete 删除选中行
  document.addEventListener('keydown', (e) => {
    if (appSection.classList.contains('collapsed')) return;
    if (e.key === 'Delete' && selectedStorageKey && document.activeElement.contentEditable !== 'true') {
      deleteStorageItem(selectedStorageKey);
    }
  });
})();


// ==================== Download Sources ====================
(function() {
  const downloadBtn = document.getElementById('downloadSourcesBtn');
  if (!downloadBtn) return;

  // URL -> 本地路径
  function urlToPath(url) {
    try {
      const u = new URL(url);
      let p = u.hostname + (u.pathname === '/' ? '/index.html' : u.pathname);
      if (u.search) p += u.search.replace(/[?&=]/g, '_');
      return p.replace(/\/+/g, '/').replace(/^\//, '');
    } catch {
      return url.replace(/[^a-zA-Z0-9._\-\/]/g, '_');
    }
  }

  // 策略1: Page.getResourceTree 获取资源列表
  function getResourceTree() {
    return new Promise((resolve) => {
      if (!debuggerAttached) { resolve([]); return; }
      // 确保 Page domain 已启用
      chrome.debugger.sendCommand({ tabId }, 'Page.enable', {}, () => {
        if (chrome.runtime.lastError) {
          console.warn('[DownloadSources] Page.enable failed:', chrome.runtime.lastError.message);
        }
        chrome.debugger.sendCommand({ tabId }, 'Page.getResourceTree', {}, (result) => {
          if (chrome.runtime.lastError) {
            console.warn('[DownloadSources] Page.getResourceTree failed:', chrome.runtime.lastError.message);
            resolve([]);
            return;
          }
          if (!result || !result.frameTree) { resolve([]); return; }
          const resources = [];
          const seen = new Set();
          function walk(ft) {
            const frameId = ft.frame.id;
            if (ft.resources) {
              ft.resources.forEach(r => {
                if (r.url.startsWith('data:') || r.url.startsWith('chrome-extension:') || r.url.startsWith('about:') || r.url.startsWith('blob:')) return;
                if (seen.has(r.url)) return;
                seen.add(r.url);
                resources.push({ url: r.url, path: urlToPath(r.url), frameId });
              });
            }
            if (ft.childFrames) ft.childFrames.forEach(c => walk(c));
          }
          walk(result.frameTree);
          resolve(resources);
        });
      });
    });
  }

  // 策略2: 从已捕获的 Network 请求中补充（包含动态加载的 chunks）
  function getNetworkResources(existingUrls) {
    const extra = [];
    // 从 panel 已记录的 requests Map 中获取
    for (const [, r] of requests) {
      if (existingUrls.has(r.url)) continue;
      if (r.url.startsWith('data:') || r.url.startsWith('chrome-extension:') || r.url.startsWith('about:') || r.url.startsWith('blob:')) continue;
      if (r._pending) continue;
      existingUrls.add(r.url);
      extra.push({ url: r.url, path: urlToPath(r.url), hasContent: !!(r.response && r.response.content) });
    }
    return extra;
  }

  // 获取单个资源内容 — 多重回退策略
  function getContent(url, frameId) {
    return new Promise((resolve) => {
      // 1. 先检查 panel 已缓存的 requests 中是否有内容
      for (const [, r] of requests) {
        if (r.url === url && r.response && r.response.content && r.response.content.length > 0) {
          resolve({ content: r.response.content, base64Encoded: false });
          return;
        }
      }

      // 2. 尝试 Page.getResourceContent
      if (debuggerAttached && frameId) {
        chrome.debugger.sendCommand({ tabId }, 'Page.getResourceContent', { frameId, url }, (result) => {
          if (!chrome.runtime.lastError && result && result.content && result.content.length > 0) {
            resolve({ content: result.content, base64Encoded: result.base64Encoded || false });
            return;
          }
          // 3. 尝试 Network.getResponseBody
          tryNetworkGetBody(url, resolve);
        });
      } else {
        tryNetworkGetBody(url, resolve);
      }
    });
  }

  function tryNetworkGetBody(url, resolve) {
    const reqId = allNetworkRequestIds.get(url);
    if (debuggerAttached && reqId) {
      chrome.debugger.sendCommand({ tabId }, 'Network.getResponseBody', { requestId: reqId }, (result) => {
        if (!chrome.runtime.lastError && result && result.body && result.body.length > 0) {
          let body = result.body;
          if (result.base64Encoded) {
            resolve({ content: body, base64Encoded: true });
          } else {
            body = tryFixGarbledText(body);
            resolve({ content: body, base64Encoded: false });
          }
          return;
        }
        // 4. 最后回退：通过页面 fetch 重新请求
        tryFetchFallback(url, resolve);
      });
    } else {
      tryFetchFallback(url, resolve);
    }
  }

  function tryFetchFallback(url, resolve) {
    const code = `
      (async function() {
        try {
          const r = await fetch(${JSON.stringify(url)}, { cache: 'force-cache', credentials: 'same-origin' });
          if (!r.ok) return null;
          const t = await r.text();
          return t;
        } catch(e) { return null; }
      })();
    `;
    chrome.devtools.inspectedWindow.eval(code, (result, isException) => {
      if (!isException && result && result.length > 0) {
        resolve({ content: result, base64Encoded: false });
      } else {
        resolve(null);
      }
    });
  }

  downloadBtn.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    downloadBtn.textContent = '⏳ 收集资源列表...';
    console.log('[DownloadSources] 开始收集资源...');

    try {
      // 收集所有资源 URL
      const treeResources = await getResourceTree();
      console.log('[DownloadSources] ResourceTree 返回:', treeResources.length, '个资源');
      const existingUrls = new Set(treeResources.map(r => r.url));

      // 从 Network 请求中补充
      const networkResources = getNetworkResources(existingUrls);
      console.log('[DownloadSources] Network 补充:', networkResources.length, '个资源');

      // 合并，获取主 frameId 用于 Page.getResourceContent
      let mainFrameId = treeResources.length > 0 ? treeResources[0].frameId : null;
      const allResources = [
        ...treeResources,
        ...networkResources.map(r => ({ ...r, frameId: mainFrameId }))
      ];

      if (allResources.length === 0) {
        showToast('未找到任何资源，请确保页面已加载完成');
        downloadBtn.disabled = false;
        downloadBtn.textContent = '💾 下载源码';
        return;
      }

      console.log('[DownloadSources] 总计:', allResources.length, '个资源，开始下载内容...');

      downloadBtn.textContent = `⏳ 下载中 0/${allResources.length}...`;

      const files = [];
      let done = 0;
      let failed = 0;
      const concurrency = 6;
      let idx = 0;

      async function worker() {
        while (idx < allResources.length) {
          const i = idx++;
          const res = allResources[i];
          try {
            const content = await getContent(res.url, res.frameId);
            if (content !== null && content.content && content.content.length > 0) {
              files.push({ path: res.path, content: content.content, base64: content.base64Encoded });
            } else {
              failed++;
            }
          } catch (e) {
            failed++;
            console.warn('Failed to get:', res.url, e);
          }
          done++;
          downloadBtn.textContent = `⏳ 下载中 ${done}/${allResources.length}...`;
        }
      }

      const workers = [];
      for (let w = 0; w < concurrency; w++) workers.push(worker());
      await Promise.all(workers);

      if (files.length === 0) {
        showToast('没有可下载的资源内容');
        downloadBtn.disabled = false;
        downloadBtn.textContent = '💾 下载源码';
        return;
      }

      downloadBtn.textContent = '⏳ 打包中...';

      const zipBlob = buildZip(files);
      const blobUrl = URL.createObjectURL(zipBlob);

      chrome.devtools.inspectedWindow.eval('location.hostname', (hostname) => {
        const filename = (hostname || 'sources') + '_sources.zip';
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);

        const msg = failed > 0
          ? `已下载 ${files.length} 个文件，${failed} 个获取失败`
          : `已下载 ${files.length} 个文件`;
        showToast(msg);
        downloadBtn.disabled = false;
        downloadBtn.textContent = '💾 下载源码';
      });

    } catch (err) {
      console.error('Download sources error:', err);
      showToast('下载失败: ' + err.message);
      downloadBtn.disabled = false;
      downloadBtn.textContent = '💾 下载源码';
    }
  });

  // ==================== 纯 JS ZIP 打包 ====================
  function buildZip(files) {
    const localFiles = [];
    const centralDir = [];
    let offset = 0;

    for (const file of files) {
      let data;
      if (file.base64) {
        data = base64ToUint8Array(file.content);
      } else {
        data = new TextEncoder().encode(file.content);
      }

      const pathBytes = new TextEncoder().encode(file.path);
      const crc = crc32(data);

      const localHeader = new Uint8Array(30 + pathBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, pathBytes.length, true);
      lv.setUint16(28, 0, true);
      localHeader.set(pathBytes, 30);
      localFiles.push(localHeader, data);

      const cdEntry = new Uint8Array(46 + pathBytes.length);
      const cv = new DataView(cdEntry.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, pathBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      cdEntry.set(pathBytes, 46);
      centralDir.push(cdEntry);
      offset += localHeader.length + data.length;
    }

    const cdSize = centralDir.reduce((s, e) => s + e.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, centralDir.length, true);
    ev.setUint16(10, centralDir.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    const parts = [...localFiles, ...centralDir, eocd];
    const totalSize = parts.reduce((s, p) => s + p.length, 0);
    const zipData = new Uint8Array(totalSize);
    let pos = 0;
    for (const part of parts) { zipData.set(part, pos); pos += part.length; }
    return new Blob([zipData], { type: 'application/zip' });
  }

  function base64ToUint8Array(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  const crc32Table = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = crc32Table[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
})();
