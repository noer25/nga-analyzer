// options.js — 设置页面逻辑
// 支持多 API Provider、自定义抓取页数

import { clearAllCache, getCacheCount } from './cache.js';

// 预设 Provider 模板
const PRESETS = {
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    apiKey: ''
  },
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o',
    apiKey: ''
  },
  'openai-azure': {
    name: 'Azure OpenAI',
    baseUrl: 'https://YOUR_RESOURCE.openai.azure.com',
    model: 'gpt-4o',
    apiKey: ''
  },
  custom: {
    name: '自定义',
    baseUrl: '',
    model: '',
    apiKey: ''
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  const providerList = document.getElementById('providerList');
  const presetSelect = document.getElementById('presetSelect');
  const addPresetBtn = document.getElementById('addPresetBtn');
  const providerStatus = document.getElementById('providerStatus');
  const fetchPagesInput = document.getElementById('fetchPages');
  const pagesStatus = document.getElementById('pagesStatus');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const cacheStatus = document.getElementById('cacheStatus');
  const cacheCountEl = document.getElementById('cacheCount');

  let providers = {};
  let activeProvider = '';

  // === 加载配置 ===
  async function loadConfig() {
    const data = await chrome.storage.local.get(['apiProviders', 'activeProvider', 'apiKey', 'fetchPages']);

    // 迁移旧版单 Key 配置
    if (!data.apiProviders && data.apiKey) {
      providers = {
        deepseek: {
          name: 'DeepSeek',
          baseUrl: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          apiKey: data.apiKey
        }
      };
      activeProvider = 'deepseek';
      await chrome.storage.local.set({ apiProviders: providers, activeProvider });
    } else {
      providers = data.apiProviders || {};
      activeProvider = data.activeProvider || '';
    }

    // 加载抓取页数
    fetchPagesInput.value = data.fetchPages || 3;

    renderProviderList();
    updateCacheCount();
  }

  // === 渲染 Provider 列表 ===
  function renderProviderList() {
    const ids = Object.keys(providers);

    if (ids.length === 0) {
      providerList.innerHTML = '<p style="font-size:13px;color:#999;text-align:center;padding:16px;">尚未添加 API Provider，请从上方预设中选择添加</p>';
      return;
    }

    let html = '';
    for (const id of ids) {
      const p = providers[id];
      const isActive = id === activeProvider;
      html += `
        <div class="provider-item${isActive ? ' active' : ''}">
          <div class="provider-header">
            <span>
              <span class="provider-name">${escHtml(p.name)}</span>
              <span class="provider-model">${escHtml(p.model)}</span>
            </span>
          </div>
          <div class="provider-body">
            <div>
              <label style="font-size:11px;">API Base URL</label>
              <input type="text" value="${escHtml(p.baseUrl)}" data-id="${id}" data-field="baseUrl" placeholder="https://api.xxx.com">
            </div>
            <div>
              <label style="font-size:11px;">Model</label>
              <input type="text" value="${escHtml(p.model)}" data-id="${id}" data-field="model" placeholder="model-name">
            </div>
          </div>
          <div style="margin-top:8px;">
            <label style="font-size:11px;">API Key</label>
            <input type="password" value="${escHtml(p.apiKey)}" data-id="${id}" data-field="apiKey" placeholder="sk-xxxx..." style="width:100%;">
          </div>
          <div class="provider-actions">
            ${!isActive ? `<button class="btn btn-primary btn-xs activate-btn" data-id="${id}">设为当前</button>` : ''}
            <button class="btn btn-danger btn-xs delete-btn" data-id="${id}">删除</button>
          </div>
        </div>`;
    }
    providerList.innerHTML = html;

    // 绑定输入变更事件
    providerList.querySelectorAll('input').forEach(input => {
      input.addEventListener('input', () => {
        const id = input.dataset.id;
        const field = input.dataset.field;
        providers[id][field] = input.value.trim();
        saveProviders(false);
      });
    });

    // 绑定设为当前按钮
    providerList.querySelectorAll('.activate-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        activeProvider = btn.dataset.id;
        await saveProviders(true);
        renderProviderList();
        showStatus(providerStatus, `已切换至 ${providers[activeProvider].name}`, 'success');
      });
    });

    // 绑定删除按钮
    providerList.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!confirm(`确定删除 Provider "${providers[id].name}"？`)) return;
        delete providers[id];
        if (activeProvider === id) {
          activeProvider = Object.keys(providers)[0] || '';
        }
        await saveProviders(true);
        renderProviderList();
        showStatus(providerStatus, 'Provider 已删除', 'info');
      });
    });
  }

  async function saveProviders(showMsg) {
    await chrome.storage.local.set({ apiProviders: providers, activeProvider });
    if (showMsg) {
      showStatus(providerStatus, '配置已保存 ✓', 'success');
    }
  }

  // === 添加预设 Provider ===
  addPresetBtn.addEventListener('click', async () => {
    const presetKey = presetSelect.value;
    if (!presetKey) {
      showStatus(providerStatus, '请先选择一个预设', 'error');
      return;
    }

    const preset = PRESETS[presetKey];
    let id = presetKey;
    let suffix = 1;
    while (providers[id]) {
      id = `${presetKey}-${suffix++}`;
    }

    providers[id] = { ...preset };
    activeProvider = activeProvider || id;
    await saveProviders(true);
    renderProviderList();
    showStatus(providerStatus, `已添加 ${preset.name}，请填入 API Key`, 'success');
    presetSelect.value = '';
  });

  // === 抓取页数设置 ===
  fetchPagesInput.addEventListener('change', async () => {
    let val = parseInt(fetchPagesInput.value);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 10) val = 10;
    fetchPagesInput.value = val;
    await chrome.storage.local.set({ fetchPages: val });
    showStatus(pagesStatus, `抓取页数已设为 ${val} ✓`, 'success');
  });

  // === 清除缓存 ===
  clearCacheBtn.addEventListener('click', async () => {
    if (!confirm('确定要清除所有分析的缓存数据吗？此操作不可撤销。')) return;
    try {
      const count = await clearAllCache();
      showStatus(cacheStatus, `已清除 ${count} 条缓存记录`, 'info');
      updateCacheCount();
    } catch (err) {
      showStatus(cacheStatus, `清除失败: ${err.message}`, 'error');
    }
  });

  async function updateCacheCount() {
    try {
      cacheCountEl.textContent = await getCacheCount();
    } catch { cacheCountEl.textContent = '?'; }
  }

  function showStatus(el, message, type) {
    el.textContent = message;
    el.className = `status ${type}`;
    el.style.display = 'block';
    if (type !== 'error') {
      setTimeout(() => { el.style.display = 'none'; }, 3000);
    }
  }

  function escHtml(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  await loadConfig();
});
