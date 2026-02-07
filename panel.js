const requests = new Map();
let selectedRequestId = null;
let currentTab = 'headers';
let currentTypeFilter = 'fetch';

const requestList = document.getElementById('requestList');
const filterInput = document.getElementById('filter');
const detailContent = document.getElementById('detailContent');
const toast = document.getElementById('toast');

// 根据 MIME 类型和 URL 判断请求类型
function getRequestType(data) {
  const mimeType = (data.response.mimeType || '').toLowerCase();
  const url = data.url.toLowerCase();
  
  // Fetch/XHR
  if (mimeType.includes('json') || mimeType.includes('xml') || 
      data.request.headers?.some(h => h.name.toLowerCase() === 'x-requested-with')) {
    return 'fetch';
  }
  
  // Document
  if (mimeType.includes('html') || mimeType.includes('xhtml')) {
    return 'doc';
  }
  
  // CSS
  if (mimeType.includes('css') || url.endsWith('.css')) {
    return 'css';
  }
  
  // JavaScript
  if (mimeType.includes('javascript') || mimeType.includes('ecmascript') || 
      url.endsWith('.js') || url.endsWith('.mjs')) {
    return 'js';
  }
  
  // Font
  if (mimeType.includes('font') || mimeType.includes('woff') || mimeType.includes('ttf') ||
      url.match(/\.(woff2?|ttf|otf|eot)(\?|$)/)) {
    return 'font';
  }
  
  // Image
  if (mimeType.includes('image') || url.match(/\.(png|jpg|jpeg|gif|svg|ico|webp|bmp)(\?|$)/)) {
    return 'img';
  }
  
  // Media
  if (mimeType.includes('video') || mimeType.includes('audio') ||
      url.match(/\.(mp4|webm|ogg|mp3|wav|m3u8)(\?|$)/)) {
    return 'media';
  }
  
  // Manifest
  if (mimeType.includes('manifest') || url.match(/manifest\.json(\?|$)/)) {
    return 'manifest';
  }
  
  // WebSocket (通常不会在这里捕获，但保留)
  if (url.startsWith('ws://') || url.startsWith('wss://')) {
    return 'ws';
  }
  
  // WebAssembly
  if (mimeType.includes('wasm') || url.endsWith('.wasm')) {
    return 'wasm';
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

// 监听网络请求
chrome.devtools.network.onRequestFinished.addListener(async (request) => {
  addRequest(request);
});

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
    r.url === url && r.startedDateTime === request.startedDateTime
  );
  if (existingRequest) return;
  
  request.getContent ? request.getContent((content, encoding) => {
    saveRequest(id, url, method, status, request, content, encoding);
  }) : saveRequest(id, url, method, status, request, request.response.content?.text || '', request.response.content?.encoding || '');
}

function saveRequest(id, url, method, status, request, content, encoding) {
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
      content: content,
      encoding: encoding,
      mimeType: request.response.content?.mimeType,
      size: request.response.content?.size || (content ? content.length : 0)
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
    const statusClass = r.status >= 200 && r.status < 400 ? 'success' : 'error';
    const urlClass = r.status >= 400 ? 'error' : '';
    const selected = r.id === selectedRequestId ? 'selected' : '';
    const size = formatSize(r.response.size || 0);
    const time = formatTime(r.time);
    
    return `
      <div class="request-item ${selected}" data-id="${r.id}">
        <div class="request-row">
          <span class="method ${r.method}">${r.method}</span>
          <span class="url ${urlClass}" title="${r.url}">${displayUrl}</span>
          <span class="status ${statusClass}">${r.status}</span>
        </div>
        <div class="request-actions">
          <button class="action-btn primary" data-action="copyAll" data-id="${r.id}">复制全部</button>
          <button class="action-btn" data-action="copyRequest" data-id="${r.id}">请求</button>
          <button class="action-btn" data-action="copyResponse" data-id="${r.id}">响应</button>
          <button class="action-btn replay" data-action="replay" data-id="${r.id}">重新请求</button>
          <span class="size">${size}</span>
          <span class="time">${time}</span>
        </div>
      </div>
    `;
  }).join('');
}

// 点击选择请求
requestList.addEventListener('click', (e) => {
  const actionBtn = e.target.closest('.action-btn');
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
