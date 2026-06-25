// service-worker.js — 后台 Service Worker（MV3）
// 通过打开 NGA 页面标签页抓取发言（利用已登录浏览器环境绕过反爬）、调用 API、结果展示

import { getCache, setCache } from './cache.js';
import { analyzeProfile, buildPrompt, getFetchPages, getActiveProvider } from './api.js';

const cooldowns = new Map();

/**
 * 通过打开 NGA 标签页 + Content Script 抓取用户发言
 */
async function fetchPostsFromThread(authorid, baseUrl) {
  const MAX_PAGES = await getFetchPages();
  const allPosts = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${baseUrl}/thread.php?searchpost=1&authorid=${authorid}&page=${page}`;

    try {
      const tab = await chrome.tabs.create({ url, active: false, index: 999 });
      const tabId = tab.id;

      const posts = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.tabs.remove(tabId).catch(() => {});
          reject(new Error('NGA 页面加载超时'));
        }, 20000);

        const listener = (updatedTabId, changeInfo) => {
          if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);

          setTimeout(() => {
            chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_CURRENT_PAGE' }, (response) => {
              if (chrome.runtime.lastError) {
                chrome.tabs.remove(tabId).catch(() => {});
                resolve([]);
                return;
              }
              chrome.tabs.remove(tabId).catch(() => {});
              resolve(response?.posts || []);
            });
          }, 1500);
        };

        chrome.tabs.onUpdated.addListener(listener);

        // 兜底：页面可能已经加载完成
        chrome.tabs.get(tabId, (tabInfo) => {
          if (tabInfo && tabInfo.status === 'complete') {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_CURRENT_PAGE' }, (response) => {
                if (chrome.runtime.lastError) {
                  chrome.tabs.remove(tabId).catch(() => {});
                  resolve([]);
                  return;
                }
                chrome.tabs.remove(tabId).catch(() => {});
                resolve(response?.posts || []);
              });
            }, 1500);
          }
        });
      });

      if (posts.length === 0 && page === 1) {
        throw new Error('未能在页面中找到发帖内容，请确认已登录 NGA 且该页面可访问');
      }
      if (posts.length === 0) break;

      allPosts.push(...posts);
      if (posts.length < 5 && page < MAX_PAGES) continue;

    } catch (err) {
      if (page === 1) throw err;
      break;
    }
  }

  return allPosts;
}

async function handleAnalyzeRequest(authorid, baseUrl, rawUrl, forceRefresh) {
  const cooldownKey = authorid;
  if (cooldowns.has(cooldownKey)) {
    const elapsed = Date.now() - cooldowns.get(cooldownKey);
    if (elapsed < 3000) throw new Error(`请等待 ${Math.ceil((3000 - elapsed) / 1000)} 秒后再试`);
  }
  cooldowns.set(cooldownKey, Date.now());

  try {
    if (!forceRefresh) {
      const cached = await getCache(authorid);
      if (cached) {
        const username = cached._username || `UID:${authorid}`;
        return { cached: true, profile: cached, uid: authorid, username };
      }
    }

    try { await getActiveProvider(); }
    catch (e) { if (e.message === 'MISSING_KEY') throw new Error('MISSING_KEY'); throw e; }

    const username = `UID:${authorid}`;
    let posts;
    try {
      posts = await fetchPostsFromThread(authorid, baseUrl);
    } catch (err) {
      throw new Error(`${err.message}`);
    }

    if (posts.length === 0) throw new Error('未找到该用户的公开发帖记录');

    const prompt = buildPrompt(authorid, username, posts);
    const { profile, report } = await analyzeProfile(prompt);

    profile._username = username;
    profile._report = report;
    profile._analyzedAt = new Date().toISOString();
    profile._posts = posts.map(p => p.content);

    await setCache(authorid, profile);
    return { cached: false, profile, report, uid: authorid, username, replyCount: posts.length, posts: posts.map(p => p.content) };
  } finally {
    cooldowns.delete(cooldownKey);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_USER_VIA_URL') {
    const { authorid, baseUrl, rawUrl, forceRefresh } = message;
    const resolvedBaseUrl = baseUrl || 'https://nga.178.com';

    handleAnalyzeRequest(authorid, resolvedBaseUrl, rawUrl, forceRefresh)
      .then(result => {
        const enc = encodeURIComponent(result.username);
        chrome.tabs.create({
          url: chrome.runtime.getURL(`result.html?uid=${result.uid}&username=${enc}`)
        }, () => {
          chrome.storage.local.set({ [`result_${result.uid}`]: result }).then(() => sendResponse({ success: true }));
        });
      })
      .catch(err => {
        if (err.message === 'MISSING_KEY') sendResponse({ success: false, error: 'MISSING_KEY', message: '请先在设置中配置 API Key' });
        else sendResponse({ success: false, error: 'ANALYSIS_FAILED', message: err.message });
      });
    return true;
  }

  if (message.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    sendResponse({ success: true });
    return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[NGA Analyzer] Extension installed/updated');
});
