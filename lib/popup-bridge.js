// popup-bridge.js — 点击图标后的小弹窗：引导用户在新标签页打开完整操作页面
document.getElementById('openBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
  window.close();
});
