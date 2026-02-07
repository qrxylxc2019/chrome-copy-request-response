// 创建 DevTools 面板
chrome.devtools.panels.create(
  "Request Copier",
  "icons/icon16.png",
  "panel.html",
  function(panel) {
    console.log("Network Request Copier panel created");
  }
);
