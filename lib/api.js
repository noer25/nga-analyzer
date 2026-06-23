// api.js — 多 Provider AI API 调用模块
// 支持 DeepSeek、OpenAI 兼容接口、自定义端点

const API_TIMEOUT_MS = 60000; // 60 秒超时

export async function getActiveProvider() {
  const { apiProviders, activeProvider } = await chrome.storage.local.get(['apiProviders', 'activeProvider']);

  if (apiProviders && activeProvider && apiProviders[activeProvider]) {
    const p = apiProviders[activeProvider];
    return { apiKey: p.apiKey, baseUrl: p.baseUrl, model: p.model };
  }

  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (apiKey) {
    return { apiKey, baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' };
  }

  throw new Error('MISSING_KEY');
}

export async function analyzeProfile(userPrompt) {
  const { apiKey, baseUrl, model } = await getActiveProvider();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let apiBase = baseUrl.replace(/\/+$/, '');
  if (!apiBase.endsWith('/chat/completions')) {
    apiBase += '/chat/completions';
  }

  try {
    const resp = await fetch(apiBase, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        max_tokens: 8192
      }),
      signal: controller.signal
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      let errMsg = `API 请求失败 (${resp.status})`;
      if (resp.status === 401) errMsg = 'API Key 无效，请检查设置';
      else if (resp.status === 429) errMsg = 'API 请求过于频繁，请稍后重试';
      else if (resp.status === 402) errMsg = 'API 账户余额不足';
      else if (resp.status === 503) errMsg = 'API 服务繁忙，请稍后重试';
      throw new Error(`${errMsg}${errText ? ': ' + errText.slice(0, 200) : ''}`);
    }

    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('API 返回内容为空');

    // 解析 JSON
    let json = content.trim();
    // 去掉可能的 markdown 包裹
    json = json.replace(/^```json\s*/i, '').replace(/^```\s*/i, '');
    json = json.replace(/\s*```\s*$/, '');
    json = json.trim();

    let result;
    try {
      result = JSON.parse(json);
    } catch (parseErr) {
      // JSON 解析失败，可能是被截断或格式错误
      const tail = json.slice(-200);
      const totalLen = json.length;
      console.error('[NGA Analyzer] JSON parse failed. Total length:', totalLen, 'Tail:', tail);

      // 尝试修复：如果被截断，尝试补全尾部
      if (!json.endsWith('}')) {
        // 找到最后一个完整的 "report": 后面补全
        const fixed = json + '"}'; // 简单尝试闭合
        try {
          result = JSON.parse(fixed);
          console.warn('[NGA Analyzer] JSON repaired by appending closing quote/brace');
        } catch {
          throw new Error(`API 返回的 JSON 不完整（共 ${totalLen} 字符），可能被截断。末尾内容: ${tail.slice(-100)}`);
        }
      } else {
        throw new Error(`API 返回格式异常: ${parseErr.message}。末尾内容: ${tail.slice(-100)}`);
      }
    }
    return {
      profile: result.profile,
      report: result.report || ''
    };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('分析请求超时，请重试（已等待60秒）');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function getFetchPages() {
  const { fetchPages } = await chrome.storage.local.get('fetchPages');
  return (fetchPages && fetchPages >= 1 && fetchPages <= 10) ? fetchPages : 3;
}

const SYSTEM_PROMPT = `你是一位专业的论坛用户行为分析员。请根据用户的历史发言文本，以客观、中立、严谨的态度进行分析，所有结论必须基于发言事实，引用原文作为依据。禁止主观臆断、贴标签式评价和人身攻击。

根据用户历史发言，输出一个纯 JSON 对象（不要 markdown 包裹），包含两项：profile（结构化数据）和 report（分析报告）。

JSON 格式（严格按此结构）：

{
  "profile": {
    "political_spectrum": {"label":"政治倾向标签","description":"简短描述","confidence":"高/中/低"},
    "gaming_preferences": {"genres":[],"games":[],"topics":[],"summary":"核心讨论圈总结"},
    "personality_style": {"traits":[],"language_style":"语言风格","activity_pattern":"发言规律"},
    "abnormal_behavior": {"flagged":false,"types":[],"description":"","evidence":[]},
    "score": 0,
    "score_reason": ""
  },
  "report": "分析报告文本"
}

report 字段要求（约 500-800 字，客观中立方言）：
- 六段结构：综合概述 / 政治光谱分析 / 游戏偏好与讨论圈层 / 语言风格与发言特征 / 异常行为研判 / 总评与评分
- ⚠️ 每段结论必须引用至少一条原文发言片段（不超过 20 字），格式：「发言N："原文"」
- 评分 0-100，标准：90+ 高质量发言者 / 70+ 正常用户 / 50+ 普通用户 / 30+ 需关注 / <30 存在较多问题
- 政治不涉及则写"政治相关发言较少，无法做出判断"
- 无异常则写"未发现显著异常行为"`;

export function buildPrompt(uid, username, posts) {
  // NGA thread.php 按时间倒序排列：posts[0] 最新，posts[last] 最旧
  // 不翻转，保持发言1=最新、发言N=最旧
  const postsText = posts
    .map((p, i) => `[发言${i + 1}] ${p.content}`)
    .join('\n\n');

  return `分析 NGA 用户历史发言——UID: ${uid}，用户名: ${username}，共 ${posts.length} 条。
⚠️ 重要：发言编号越小发布时间越晚（发言1是最新发布的，发言${posts.length}是最早发布的，按时间从新到旧排列）。

${postsText}

请输出纯 JSON（无 markdown 代码块包裹），profile 和 report 两项。report 约 500-800 字，客观中立严谨风格，每段引用原文。`;
}
