// result.js — 结果展示页面逻辑
// 以用户画像分析报告为主体，结构化卡片为折叠补充

document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const uid = params.get('uid');
  const username = params.get('username') || '未知用户';

  if (!uid) {
    showError('缺少用户 UID 参数');
    return;
  }

  const fromCache = params.get('fromCache') === '1';

  let result;

  if (fromCache) {
    // 直接从缓存读取（历史记录入口）
    const cacheKey = `nga_profile_${uid}`;
    const cacheData = await chrome.storage.local.get(cacheKey);
    const cached = cacheData[cacheKey];
    if (cached && cached.profile) {
      result = {
        profile: cached.profile,
        report: cached.profile._report || '',
        cached: true,
        uid,
        username: cached.profile._username || username
      };
    }
  } else {
    // 新分析结果：从临时 storage 读取
    const storageKey = `result_${uid}`;
    const { [storageKey]: data } = await chrome.storage.local.get(storageKey);
    if (data) {
      result = data;
      chrome.storage.local.remove(storageKey);
    }
  }

  if (!result) {
    showError('未找到分析结果，请在扩展中重新分析');
    return;
  }

  const { profile, report, cached, replyCount, posts } = result;

  // 隐藏 loading，显示内容
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('resultContent').style.display = 'block';

  // === 报告头部 ===
  document.getElementById('reportUid').textContent = uid;
  document.getElementById('reportUser').textContent = username;
  document.getElementById('reportTime').textContent = new Date().toLocaleString('zh-CN');

  if (replyCount) {
    document.getElementById('reportCountBadge').style.display = '';
    document.getElementById('reportCount').textContent = replyCount;
  }

  // === 分析报告正文 ===
  const reportText = (report && report.trim())
    ? report
    : (profile?._report || profile?.overall_summary || '分析完成，但未生成分析报告。');

  // 给报告正文做一些高亮处理
  const highlighted = highlightReport(reportText, profile?.score);
  document.getElementById('reportBody').innerHTML = highlighted;

  // === 缓存标记 ===
  document.getElementById('cacheNote').textContent = cached
    ? '(缓存数据 · 7天内有效)'
    : '';

  // === 结构化补充卡片 ===
  if (profile) {
    renderPolitical(profile.political_spectrum);
    renderGaming(profile.gaming_preferences);
    renderPersonality(profile.personality_style);
    renderAbnormal(profile.abnormal_behavior);
  }

  // === 原始发言对照 ===
  const rawPosts = posts || profile?._posts;
  if (rawPosts && rawPosts.length > 0) {
    renderRawPosts(rawPosts);
  }

  // === 按钮事件 ===
  document.getElementById('refreshBtn').addEventListener('click', async () => {
    if (!confirm('确认强制刷新？将重新抓取发言并调用 API 分析。')) return;
    document.getElementById('refreshBtn').disabled = true;
    document.getElementById('refreshBtn').textContent = '刷新中...';

    try {
      const resp = await chrome.runtime.sendMessage({
        type: 'ANALYZE_USER_VIA_URL',
        authorid: uid,
        baseUrl: 'https://nga.178.com',
        forceRefresh: true
      });
      if (!resp || !resp.success) {
        alert('刷新失败: ' + (resp?.message || '未知错误'));
      }
    } catch (err) {
      alert('刷新失败: ' + err.message);
    }
    document.getElementById('refreshBtn').disabled = false;
    document.getElementById('refreshBtn').textContent = '🔄 强制刷新分析';
  });

  document.getElementById('copyBtn').addEventListener('click', async () => {
    const text = `【NGA 用户画像分析 · ${username} (UID:${uid})】\n\n${reportText}`;
    try {
      await navigator.clipboard.writeText(text);
      alert('报告已复制到剪贴板');
    } catch {
      alert('复制失败，请手动选择复制');
    }
  });
});

function showError(msg) {
  document.getElementById('loadingState').style.display = 'none';
  document.getElementById('errorState').style.display = 'block';
  document.getElementById('errorMessage').textContent = msg;
}

// 高亮报告中的关键内容
function highlightReport(text, score) {
  let html = escapeHtml(text);

  // 评分数字高亮
  if (score != null) {
    const scoreClass = score >= 90 ? 'score-a' : score >= 70 ? 'score-b'
      : score >= 50 ? 'score-c' : score >= 30 ? 'score-d' : 'score-f';
    html = html.replace(
      new RegExp(`\\b(${score})\\b`, 'g'),
      `<span class="score-highlight ${scoreClass}">$1</span>`
    );
    // 也匹配 "评分: 75" 这类格式
    html = html.replace(
      /(评分[：:]\s*)(\d{1,3})/g,
      (_, prefix, num) => {
        const cls = +num >= 90 ? 'score-a' : +num >= 70 ? 'score-b'
          : +num >= 50 ? 'score-c' : +num >= 30 ? 'score-d' : 'score-f';
        return `${prefix}<span class="score-highlight ${cls}">${num}</span>`;
      }
    );
  }

  // 【xxx】加粗标黄
  html = html.replace(/【([^】]+)】/g, '<strong>【$1】</strong>');

  // 「发言N: "..."」引用原文高亮（青色）
  html = html.replace(/「(发言\d+[:"：].*?)」/g, '<span class="quote-inline">$1</span>');

  // 独立的引用行高亮
  html = html.replace(/^(发言\d+[:：].*)$/gm, '<span class="quote-inline">$1</span>');

  return html;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML
    .replace(/\n/g, '<br>');
}

// === 结构化卡片渲染 ===

function renderPolitical(data) {
  const el = document.getElementById('politicalContent');
  if (!data) { el.innerHTML = '<p class="label-text">—</p>'; return; }
  el.innerHTML = `
    <p class="label-text"><strong>${escapeHtml(data.label || '—')}</strong>${renderConf(data.confidence)}</p>
    <p class="section-desc">${escapeHtml(data.description || '—')}</p>`;
}

function renderGaming(data) {
  const el = document.getElementById('gamingContent');
  if (!data) { el.innerHTML = '<p class="label-text">—</p>'; return; }
  let h = '';
  if (data.genres?.length) h += `<p class="label-text"><strong>类型:</strong> ${data.genres.map(g => `<span class="tag gaming">${escapeHtml(g)}</span>`).join('')}</p>`;
  if (data.games?.length) h += `<p class="label-text"><strong>游戏:</strong> ${data.games.map(g => `<span class="tag">${escapeHtml(g)}</span>`).join('')}</p>`;
  if (data.topics?.length) h += `<p class="label-text"><strong>话题:</strong> ${data.topics.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</p>`;
  if (data.summary) h += `<p class="section-desc">${escapeHtml(data.summary)}</p>`;
  el.innerHTML = h || '<p class="label-text">—</p>';
}

function renderPersonality(data) {
  const el = document.getElementById('personalityContent');
  if (!data) { el.innerHTML = '<p class="label-text">—</p>'; return; }
  let h = '';
  if (data.traits?.length) h += `<p class="label-text">${data.traits.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</p>`;
  if (data.language_style) h += `<p class="section-desc">${escapeHtml(data.language_style)}</p>`;
  if (data.activity_pattern && data.activity_pattern !== '信息不足') h += `<p class="section-desc">🕐 ${escapeHtml(data.activity_pattern)}</p>`;
  el.innerHTML = h || '<p class="label-text">—</p>';
}

function renderAbnormal(data) {
  const card = document.getElementById('abnormalCard');
  const el = document.getElementById('abnormalContent');
  if (!data || !data.flagged) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  let h = '';
  if (data.types?.length) h += `<p class="label-text">${data.types.map(t => `<span class="tag warning">${escapeHtml(t)}</span>`).join('')}</p>`;
  if (data.description) h += `<p class="label-text">${escapeHtml(data.description)}</p>`;
  if (data.evidence?.length) {
    h += '<p class="label-text" style="margin-top:8px;"><strong>典型片段:</strong></p>';
    data.evidence.forEach(e => { h += `<div class="evidence-block">${escapeHtml(e)}</div>`; });
  }
  el.innerHTML = h;
}

function renderConf(level) {
  if (!level) return '';
  const cls = level === '高' ? 'high' : level === '中' ? 'medium' : 'low';
  return `<span class="confidence-badge ${cls}">${escapeHtml(level)}</span>`;
}

// === 发言原文对照渲染 ===
function renderRawPosts(posts) {
  const section = document.getElementById('postsSection');
  const list = document.getElementById('postsList');
  const countEl = document.getElementById('postsCount');

  section.style.display = '';
  countEl.textContent = posts.length;

  let html = '';
  posts.forEach((content, i) => {
    const truncated = content.length > 300;
    const displayText = truncated ? content.slice(0, 300) + ' ...' : content;
    const idx = i + 1;

    html += `
      <div class="post-item" id="post-${idx}">
        <div class="post-index">#${idx}</div>
        <div class="post-content">
          <span class="post-text" data-full="${_escapeAttr(content)}">${escapeHtml(displayText)}</span>
          ${truncated ? `<button class="btn btn-xs btn-secondary post-expand" data-idx="${idx}">展开全文</button>` : ''}
        </div>
      </div>`;
  });

  list.innerHTML = html;

  list.querySelectorAll('.post-expand').forEach(btn => {
    btn.addEventListener('click', function () {
      const idx = this.dataset.idx;
      const span = list.querySelector(`#post-${idx} .post-text`);
      const full = span.dataset.full;
      if (span.classList.contains('expanded')) {
        span.classList.remove('expanded');
        span.textContent = full.slice(0, 300) + ' ...';
        this.textContent = '展开全文';
      } else {
        span.classList.add('expanded');
        const div = document.createElement('div');
        div.textContent = full;
        span.innerHTML = div.innerHTML.replace(/\n/g, '<br>');
        this.textContent = '收起';
      }
    });
  });
}

function _escapeAttr(s) {
  if (!s) return '';
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
