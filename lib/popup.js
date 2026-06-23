// popup.js — NGA 用户画像分析器主页面
// 功能：输入 URL 触发分析 + 历史记录查看

import { getAllCaches, clearAllCache } from './cache.js';

// 评分对应的 CSS class
function scoreClass(score) {
  if (score == null) return '';
  if (score >= 90) return 'a';
  if (score >= 70) return 'b';
  if (score >= 50) return 'c';
  if (score >= 30) return 'd';
  return 'f';
}

document.addEventListener('DOMContentLoaded', async () => {
  const urlInput = document.getElementById('targetUrl');
  const analyzeBtn = document.getElementById('analyzeBtn');
  const statusBox = document.getElementById('statusBox');
  const historyList = document.getElementById('historyList');
  const historyEmpty = document.getElementById('historyEmpty');
  const refreshHistoryBtn = document.getElementById('refreshHistoryBtn');
  const openOptionsLink = document.getElementById('openOptionsLink');
  const clearCacheLink = document.getElementById('clearCacheLink');

  // 检查 API Key 状态
  const { apiProviders, activeProvider, apiKey } =
    await chrome.storage.local.get(['apiProviders', 'activeProvider', 'apiKey']);
  const hasKey = (apiProviders && activeProvider && apiProviders[activeProvider]?.apiKey) || apiKey;
  if (!hasKey) {
    showStatus('warn', '⚠️ 尚未配置 AI API Key，请先前往 ⚙️ 设置 页面配置');
  }

  // 自动粘贴剪贴板中的 NGA URL
  try {
    const clipText = await navigator.clipboard.readText();
    if (clipText && /thread\.php\?.*authorid=\d+/.test(clipText)) {
      urlInput.value = clipText.trim();
    }
  } catch { /* 忽略 */ }

  // 加载历史
  await loadHistory();

  // === 开始分析 ===
  analyzeBtn.addEventListener('click', async () => {
    const rawUrl = urlInput.value.trim();
    if (!rawUrl) {
      showStatus('error', '请输入目标用户的发帖页面 URL');
      return;
    }

    const { authorid, baseUrl } = parseNgaUrl(rawUrl);
    if (!authorid) {
      showStatus('error',
        'URL 格式不正确，需要包含 authorid 参数。<br>' +
        '示例: https://nga.178.com/thread.php?searchpost=1&authorid=12345678');
      return;
    }

    // 检查 API Key
    const { apiProviders: p, activeProvider: active, apiKey: legacyKey } =
      await chrome.storage.local.get(['apiProviders', 'activeProvider', 'apiKey']);
    const hasKey = (p && active && p[active]?.apiKey) || legacyKey;
    if (!hasKey) {
      showStatus('error', '请先在设置中配置 AI API Key');
      return;
    }

    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = '<span class="spinner"></span>分析中...';
    showStatus('info', '正在抓取发言数据并进行分析，请稍候...');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'ANALYZE_USER_VIA_URL',
        authorid,
        baseUrl,
        rawUrl
      });

      if (!response) throw new Error('扩展通信失败，请重试');

      if (response.success) {
        showStatus('success', '✅ 分析完成！结果已在新标签页中打开');
        await loadHistory();
      } else {
        if (response.error === 'MISSING_KEY') {
          showStatus('error', '请先设置 API Key');
        } else if (response.error === 'CAPTCHA') {
          showStatus('warn', '⚠️ 遇到验证码，请在浏览器中手动打开该页面完成验证后重试');
        } else {
          showStatus('error', response.message || '分析失败，请重试');
        }
      }
    } catch (err) {
      showStatus('error', `分析失败: ${err.message}`);
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.innerHTML = '🔍 开始分析';
    }
  });

  // === 历史记录 ===
  refreshHistoryBtn.addEventListener('click', loadHistory);

  // 打开设置
  const openOptions = () => chrome.runtime.openOptionsPage();
  openOptionsLink.addEventListener('click', openOptions);

  // 清除历史
  clearCacheLink.addEventListener('click', async () => {
    if (!confirm('确定要清除所有分析记录吗？此操作不可撤销。')) return;
    try {
      const count = await clearAllCache();
      showStatus('success', `已清除 ${count} 条记录`);
      await loadHistory();
    } catch (err) {
      showStatus('error', `清除失败: ${err.message}`);
    }
  });

  // === 加载历史列表 ===
  async function loadHistory() {
    historyList.innerHTML = '';
    historyEmpty.style.display = 'block';
    historyEmpty.textContent = '加载中...';

    try {
      const items = await getAllCaches();

      if (items.length === 0) {
        historyEmpty.textContent = '暂无分析记录，输入 URL 开始分析吧';
        return;
      }

      historyEmpty.style.display = 'none';

      for (const item of items) {
        const cls = scoreClass(item.score);
        const firstChar = (item.username || '?')[0];
        const dateStr = new Date(item.timestamp).toLocaleString('zh-CN');

        const div = document.createElement('div');
        div.className = 'history-item';
        div.innerHTML = `
          <div class="history-avatar ${cls}">${escHtml(firstChar)}</div>
          <div class="history-info">
            <div class="history-name">${escHtml(item.username)}</div>
            <div class="history-meta">
              <span>UID: ${item.uid}</span>
              <span>${dateStr}</span>
            </div>
          </div>
          ${item.score != null ? `<div class="history-score ${cls}">${item.score}</div>` : ''}
          <div class="history-actions">
            <button class="btn btn-primary btn-xs view-btn" data-uid="${item.uid}" data-username="${escAttr(item.username)}">查看</button>
            <button class="btn btn-secondary btn-xs del-btn" data-uid="${item.uid}">删除</button>
          </div>
        `;

        // 点击行查看
        div.addEventListener('click', (e) => {
          if (e.target.closest('button')) return;
          openResult(item.uid, item.username);
        });

        // 查看按钮
        div.querySelector('.view-btn').addEventListener('click', (e) => {
          e.stopPropagation();
          openResult(item.uid, item.username);
        });

        // 删除按钮
        div.querySelector('.del-btn').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm(`确定删除 "${item.username}" 的分析记录？`)) return;
          await chrome.storage.local.remove(`nga_profile_${item.uid}`);
          await loadHistory();
        });

        historyList.appendChild(div);
      }
    } catch (err) {
      console.error('[NGA Analyzer] loadHistory error', err);
      historyEmpty.textContent = '加载历史失败';
    }
  }

  function openResult(uid, username) {
    // 先确保缓存数据可读，直接打开 result 页，由 result.js 从 storage 读取
    chrome.tabs.create({
      url: chrome.runtime.getURL(`result.html?uid=${uid}&username=${encodeURIComponent(username)}&fromCache=1`)
    });
  }
});

function showStatus(type, message) {
  const box = document.getElementById('statusBox');
  box.className = `status ${type}`;
  box.innerHTML = message;
  box.style.display = 'block';
  if (type !== 'error' && type !== 'warn') {
    setTimeout(() => { box.style.display = 'none'; }, 5000);
  }
}

function parseNgaUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const validHosts = ['nga.178.com', 'ngabbs.com', 'bbs.nga.cn', 'nga.cn'];
    const hostOk = validHosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
    if (!hostOk || !url.pathname.includes('thread.php')) return { authorid: null, baseUrl: null };
    const authorid = url.searchParams.get('authorid');
    if (!authorid || !/^\d+$/.test(authorid)) return { authorid: null, baseUrl: null };
    return { authorid, baseUrl: `${url.protocol}//${url.host}` };
  } catch { return { authorid: null, baseUrl: null }; }
}

function escHtml(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function escAttr(s) {
  if (!s) return '';
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
