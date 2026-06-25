// scraper.js — NGA 发帖搜索页内容抓取脚本
// 在已登录用户的浏览器上下文中执行，绕过反爬

/**
 * 从当前页面抓取发帖列表内容
 */
function scrapePage() {
  const posts = [];
  const doc = document;

  // 查找所有 <a href="read.php?tid=xxx"> 链接所在的表格行
  const tidLinks = doc.querySelectorAll('a[href*="read.php?tid="]');
  const seen = new Set();

  tidLinks.forEach(link => {
    // 找到包含该链接的 tr
    const row = link.closest('tr');
    if (!row || seen.has(row)) return;
    seen.add(row);

    const text = (row.textContent || '').replace(/\s+/g, ' ').trim();

    // 过滤表头行
    if (text.length < 20) return;

    const skipKeywords = ['发表时间', '版面', '操作', '管理'];
    if (skipKeywords.some(k => text.startsWith(k)) && text.length < 80) return;

    const tidMatch = link.href.match(/tid=(\d+)/);
    const tid = tidMatch ? tidMatch[1] : null;

    posts.push({ content: text, tid });
  });

  return posts;
}

/**
 * 获取当前页号
 */
function getCurrentPage() {
  const pageMatch = location.search.match(/[&?]page=(\d+)/);
  return pageMatch ? parseInt(pageMatch[1]) : 1;
}

// 监听来自 Service Worker 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SCRAPE_CURRENT_PAGE') {
    const page = getCurrentPage();
    const posts = scrapePage();
    sendResponse({ page, posts, url: location.href });
  }
  return true;
});
