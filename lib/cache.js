// cache.js — 分析结果缓存模块（chrome.storage.local，7天有效期）

const CACHE_PREFIX = 'nga_profile_';
const CACHE_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 天

/**
 * 获取缓存的分析结果
 * @param {string} uid
 * @returns {Promise<object|null>}
 */
export async function getCache(uid) {
  const key = CACHE_PREFIX + uid;
  const result = await chrome.storage.local.get(key);
  const data = result[key];
  if (!data) return null;

  // 检查是否过期
  if (Date.now() - data.timestamp > CACHE_DURATION_MS) {
    await chrome.storage.local.remove(key);
    return null;
  }

  return data.profile;
}

/**
 * 写入缓存
 * @param {string} uid
 * @param {object} profile
 */
export async function setCache(uid, profile) {
  const key = CACHE_PREFIX + uid;
  await chrome.storage.local.set({
    [key]: {
      profile,
      timestamp: Date.now()
    }
  });
}

/**
 * 清除所有缓存
 */
export async function clearAllCache() {
  const all = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
  return keysToRemove.length;
}

/**
 * 获取缓存数量
 */
export async function getCacheCount() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  let valid = 0;
  for (const key of keys) {
    if (Date.now() - all[key].timestamp <= CACHE_DURATION_MS) valid++;
  }
  return valid;
}

/**
 * 获取所有有效缓存条目（含元数据，用于历史记录展示）
 * @returns {Promise<Array<{uid: string, username: string, score: number, timestamp: number}>>}
 */
export async function getAllCaches() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith(CACHE_PREFIX));
  const results = [];

  for (const key of keys) {
    const data = all[key];
    if (Date.now() - data.timestamp <= CACHE_DURATION_MS) {
      results.push({
        uid: key.replace(CACHE_PREFIX, ''),
        username: data.profile?._username || '未知',
        score: data.profile?.score ?? null,
        report: data.profile?._report || '',
        profile: data.profile,
        timestamp: data.timestamp
      });
    }
  }

  // 按时间倒序
  results.sort((a, b) => b.timestamp - a.timestamp);
  return results;
}
