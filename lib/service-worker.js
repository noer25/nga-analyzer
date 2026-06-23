// service-worker.js — 后台 Service Worker（MV3）
// 负责：标签页管理、消息中转、抓取发言、调用 API、打开结果页面

import { getCache, setCache } from './cache.js';
import { analyzeProfile, buildPrompt, getFetchPages, getActiveProvider } from './api.js';

// 冷却计时器
const cooldowns = new Map();

/**
 * 从 NGA thread.php 发帖搜索页抓取用户发言
 * @param {string} authorid
 * @param {string} baseUrl - 如 https://nga.178.com
 * @returns {Promise<{content: string, tid: string|null}[]>}
 */
async function fetchPostsFromThread(authorid, baseUrl) {
  const allPosts = [];
  const MAX_PAGES = await getFetchPages();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${baseUrl}/thread.php?searchpost=1&authorid=${authorid}&page=${page}`;
    console.log(`[NGA Analyzer] Fetching page ${page}: ${url}`);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const resp = await fetch(url, {
        credentials: 'include',
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        if (page === 1) throw new Error(`页面请求失败 (${resp.status})`);
        break;
      }

      const buffer = await resp.arrayBuffer();
      // NGA 页面使用 GBK/GB2312 编码，优先用 GBK 解码
      let html;
      try {
        html = new TextDecoder('gbk').decode(buffer);
      } catch {
        html = new TextDecoder('gb2312').decode(buffer);
      }

      // 检测反爬/验证码
      if (/验证码|captcha|sec-bypass|请输入验证码/i.test(html)) {
        if (page === 1) throw new Error('CAPTCHA');
        break;
      }

      const posts = parseThreadPage(html);
      if (posts.length === 0 && page === 1) {
        // 第1页就没有结果，可能是页面结构不同
        console.log('[NGA Analyzer] No posts found on page 1, page may require login or parsing failed');
        throw new Error('未能在页面中找到发帖内容，可能需要登录或页面结构已变更');
      }
      if (posts.length === 0) break;

      allPosts.push(...posts);

      if (posts.length < 5 && page < MAX_PAGES) continue;

    } catch (err) {
      if (err.name === 'AbortError') {
        if (page === 1) throw new Error('NGA 页面请求超时（15秒），请检查网络');
        break;
      }
      if (err.message === 'CAPTCHA') throw err;
      if (page === 1) throw err;
      break;
    }
  }

  return allPosts;
}

/**
 * 用正则表达式解析 thread.php 发帖搜索页 HTML
 * （Service Worker 中没有 DOMParser，只能用字符串匹配）
 */
function parseThreadPage(html) {
  const posts = [];

  // 策略1：匹配 NGA 常见的帖子列表行结构
  // 每行通常包含 <a href="read.php?tid=xxx">标题</a> 和作者/时间/回复等信息
  // 先找到所有包含 tid 链接的片段

  // 方法：按 <tr 分割，找包含 read.php?tid= 的行
  const rowPattern = /<tr[\s\S]*?<\/tr>/gi;
  const rows = html.match(rowPattern) || [];

  const skipKeywords = ['发表时间', '版面', '回复', '查看', '最后更新', '排序', '主题', '作者',
    'thread', 'topic', 'post', 'author', 'date', '操作', '管理'];

  for (const row of rows) {
    // 必须包含帖子链接
    if (!/read\.php\?tid=\d+/.test(row)) continue;

    // 去掉 HTML 标签获取纯文本
    const text = stripHtml(row).replace(/\s+/g, ' ').trim();

    // 过滤表头行
    if (text.length < 15) continue;
    const lowerText = text.toLowerCase();
    if (skipKeywords.some(k => {
      const kw = k.toLowerCase();
      // 仅当文本整体以这些关键词开头或很短时才过滤
      return lowerText.length < 60 && lowerText.includes(kw);
    })) {
      // 再检查：如果文本长度 > 80，可能确实是有效内容行
      if (text.length < 80) continue;
    }

    // 提取 tid
    const tidMatch = row.match(/read\.php\?tid=(\d+)/);
    const tid = tidMatch ? tidMatch[1] : null;

    posts.push({ content: text, tid });
  }

  // 策略2：如果上面的方法没找到，尝试更宽松的匹配
  // 查找所有 <a href="...read.php?tid=..." ...> 周围的文字段落
  if (posts.length === 0) {
    const linkPattern = /<a[^>]*href="[^"]*read\.php\?tid=(\d+)[^"]*"[^>]*>([^<]*)<\/a>/gi;
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
      const tid = match[1];
      const title = match[2].trim();

      // 获取该链接周围的文本（前后各 200 字符）
      const idx = match.index;
      const contextStart = Math.max(0, idx - 200);
      const contextEnd = Math.min(html.length, idx + match[0].length + 200);
      const context = html.slice(contextStart, contextEnd);
      const text = stripHtml(context).replace(/\s+/g, ' ').trim();

      if (text.length > 20) {
        posts.push({ content: text, tid });
      }
    }
  }

  return posts;
}

/**
 * 去掉 HTML 标签
 */
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#?\w+;/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * 尝试从 NGA 页面获取用户名
 */
async function fetchUsername(authorid, baseUrl) {
  try {
    const url = `${baseUrl}/nuke.php?func=ucp&uid=${authorid}`;
    const resp = await fetch(url, { credentials: 'include' });
    if (!resp.ok) return `UID:${authorid}`;

    const buffer = await resp.arrayBuffer();
    let html;
    try {
      html = new TextDecoder('gbk').decode(buffer);
    } catch {
      html = new TextDecoder('gb2312').decode(buffer);
    }

    // 从页面标题提取用户名
    const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
    if (titleMatch && titleMatch[1]) {
      const title = stripHtml(titleMatch[1]).trim();
      const name = title.split(/[-–—|]/)[0].trim();
      if (name && name.length < 50) return name;
    }

    // 备用：匹配包含 uid 链接附近的用户名文本
    const uidPattern = new RegExp(
      `<a[^>]*href="[^"]*uid=${authorid}[^"]*"[^>]*>([^<]+)</a>`,
      'i'
    );
    const uidMatch = html.match(uidPattern);
    if (uidMatch && uidMatch[1].trim().length < 50) {
      return uidMatch[1].trim();
    }

    // 再备用：找 h2/h3
    const hTagMatch = html.match(/<h[23][^>]*>([^<]+)<\/h[23]>/i);
    if (hTagMatch) {
      const name = hTagMatch[1].trim();
      if (name.length < 50) return name;
    }

  } catch {
    // 获取用户名失败不算致命错误
  }
  return `UID:${authorid}`;
}

/**
 * 处理分析请求
 */
async function handleAnalyzeRequest(authorid, baseUrl, rawUrl, forceRefresh) {
  const cooldownKey = authorid;
  if (cooldowns.has(cooldownKey)) {
    const elapsed = Date.now() - cooldowns.get(cooldownKey);
    if (elapsed < 3000) {
      throw new Error(`请等待 ${Math.ceil((3000 - elapsed) / 1000)} 秒后再试`);
    }
  }
  cooldowns.set(cooldownKey, Date.now());

  try {
    // 1. 检查缓存
    if (!forceRefresh) {
      const cached = await getCache(authorid);
      if (cached) {
        const username = cached._username || `UID:${authorid}`;
        return { cached: true, profile: cached, uid: authorid, username };
      }
    }

    // 2. 检查 API Key
    try {
      await getActiveProvider();
    } catch (e) {
      if (e.message === 'MISSING_KEY') throw new Error('MISSING_KEY');
      throw e;
    }

    // 3. 尝试获取用户名
    const username = await fetchUsername(authorid, baseUrl);

    // 4. 抓取发帖页面内容
    let posts;
    try {
      posts = await fetchPostsFromThread(authorid, baseUrl);
    } catch (err) {
      if (err.message === 'CAPTCHA') throw new Error('CAPTCHA');
      throw new Error(`${err.message}`);
    }

    if (posts.length === 0) {
      throw new Error('未找到该用户的公开发帖记录。请确认 URL 正确且页面可访问。');
    }

    // 5. 构建 prompt 并调用 API
    const prompt = buildPrompt(authorid, username, posts);
    const { profile, report } = await analyzeProfile(prompt);

    // 附加用户名和报告用于结果展示
    profile._username = username;
    profile._report = report;
    profile._analyzedAt = new Date().toISOString();
    profile._posts = posts.map(p => p.content); // 保存原始发言用于对照展示

    // 6. 缓存结果（包含 report 和原始发言）
    await setCache(authorid, profile);

    return { cached: false, profile, report, uid: authorid, username, replyCount: posts.length, posts: posts.map(p => p.content) };
  } finally {
    cooldowns.delete(cooldownKey);
  }
}

// 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_USER_VIA_URL') {
    const { authorid, baseUrl, rawUrl, forceRefresh } = message;
    // baseUrl 允许缺失，默认用 nga.178.com
    const resolvedBaseUrl = baseUrl || 'https://nga.178.com';

    handleAnalyzeRequest(authorid, resolvedBaseUrl, rawUrl, forceRefresh)
      .then(result => {
        const usernameEncoded = encodeURIComponent(result.username);
        chrome.tabs.create({
          url: chrome.runtime.getURL(`result.html?uid=${result.uid}&username=${usernameEncoded}`)
        }, (tab) => {
          chrome.storage.local.set({
            [`result_${result.uid}`]: result
          }).then(() => {
            sendResponse({ success: true });
          });
        });
      })
      .catch(err => {
        if (err.message === 'MISSING_KEY') {
          sendResponse({ success: false, error: 'MISSING_KEY', message: '请先在设置中配置 API Key' });
        } else if (err.message === 'CAPTCHA') {
          sendResponse({ success: false, error: 'CAPTCHA', message: '需要完成验证码验证，请在浏览器中打开该页面并完成验证后重试' });
        } else {
          sendResponse({ success: false, error: 'ANALYSIS_FAILED', message: err.message });
        }
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
