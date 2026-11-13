import { findCdpTarget, findCsrfToken } from './cdp-helpers.mjs';

async function main() {
  const csrfToken = await findCsrfToken();
  const { pageTarget } = await findCdpTarget();
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

  const injectCode = `
  (() => {
    const CSRF_TOKEN = "${csrfToken}";

    const KNOWN_LIMITS = {
      'MODEL_PLACEHOLDER_M318': { name: 'Gemini 3.8 Flash (High)', limit: 262144 },
      'MODEL_PLACEHOLDER_M319': { name: 'Gemini 3.8 Flash (Medium)', limit: 262144 },
      'MODEL_PLACEHOLDER_M320': { name: 'Gemini 3.8 Flash (Low)', limit: 262144 },
      'MODEL_PLACEHOLDER_M298': { name: 'Gemini 3.7 Flash', limit: 262144 },
      'MODEL_PLACEHOLDER_M71':  { name: 'Gemini 3.6 Flash', limit: 262144 },
      'MODEL_PLACEHOLDER_M84':  { name: 'Gemini 3.5 Flash', limit: 262144 },
      'MODEL_PLACEHOLDER_M16':  { name: 'Gemini 3.1 Pro', limit: 262144 },
      'MODEL_PLACEHOLDER_M37':  { name: 'Gemini 3.1 Pro', limit: 262144 },
      'MODEL_PLACEHOLDER_M35':  { name: 'Claude Sonnet 4.6', limit: 200000 },
      'MODEL_PLACEHOLDER_M26':  { name: 'Claude Opus 4.6', limit: 200000 },
      'MODEL_PLACEHOLDER_M400': { name: 'Claude Opus 5.5', limit: 200000 },
      'MODEL_PLACEHOLDER_M405': { name: 'Claude Sonnet 5.5', limit: 200000 },
      'MODEL_PLACEHOLDER_M408': { name: 'Gemini 4 Argon', limit: 262144 },
      'MODEL_PLACEHOLDER_M409': { name: 'Gemini 4 Argon (Low)', limit: 262144 },
      'MODEL_PLACEHOLDER_M410': { name: 'Gemini 4 Argon (Medium)', limit: 262144 },
      'MODEL_PLACEHOLDER_M411': { name: 'Gemini 4 Argon (High)', limit: 262144 },
      'MODEL_PLACEHOLDER_M412': { name: 'Gemini 4 Argon', limit: 262144 },
      'MODEL_PLACEHOLDER_M413': { name: 'Gemini 4 Argon', limit: 262144 },
      'MODEL_PLACEHOLDER_M417': { name: 'Gemini 4 Argon (High)', limit: 262144 },
      'MODEL_PLACEHOLDER_M418': { name: 'Gemini 4 Argon (Medium)', limit: 262144 },
      'MODEL_PLACEHOLDER_M419': { name: 'Gemini 4 Argon (Low)', limit: 262144 },
      'MODEL_PLACEHOLDER_M420': { name: 'Gemini 4 Argon', limit: 262144 },
      'MODEL_PLACEHOLDER_M421': { name: 'Gemini 4 Argon', limit: 262144 },
      'MODEL_PLACEHOLDER_M429': { name: 'Gemini 4 Argon', limit: 262144 },
      'MODEL_PLACEHOLDER_M430': { name: 'Gemini 4 Argon', limit: 262144 },
      'MODEL_PLACEHOLDER_M431': { name: 'Gemini 4 Argon', limit: 262144 },
    };

    const dynamicModels = {};
    let modelsLoaded = false;
    let lastModelFetch = 0;

    function inferLimitByLabelOrId(label, rawModel) {
      const text = ((label || '') + ' ' + (rawModel || '')).toLowerCase();
      if (text.includes('claude') || text.includes('sonnet') || text.includes('opus') || text.includes('haiku')) {
        return 200000;
      }
      if (text.includes('gpt-oss') || text.includes('128k')) {
        return 128000;
      }
      if (text.includes('2m') || text.includes('2000k')) {
        return 2000000;
      }
      return 262144;
    }

    function resolveLimit(rawModel) {
      if (dynamicModels[rawModel]) return dynamicModels[rawModel];
      if (KNOWN_LIMITS[rawModel]) return KNOWN_LIMITS[rawModel];
      const lower = (rawModel || '').toLowerCase();
      const limit = inferLimitByLabelOrId('', rawModel);
      let name = rawModel || 'Gemini 默认模型';
      if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('haiku')) {
        name = rawModel || 'Claude 默认模型';
      } else if (lower.includes('argon')) {
        name = 'Gemini 4 Argon';
      } else if (rawModel && rawModel.startsWith('MODEL_PLACEHOLDER_')) {
        name = 'Gemini (新: ' + rawModel.replace('MODEL_PLACEHOLDER_', '') + ')';
      }
      return { name, limit };
    }

    function estimateTokens(text) {
      if (!text) return 0;
      let ascii = 0, nonAscii = 0;
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) <= 127) ascii++; else nonAscii++;
      }
      return Math.round(ascii / 4 + nonAscii / 1.5);
    }

    async function rpc(endpoint, body) {
      const res = await fetch('/exa.language_server_pb.LanguageServerService/' + endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connect-Protocol-Version': '1',
          'x-codeium-csrf-token': CSRF_TOKEN
        },
        body: JSON.stringify(body)
      });
      return await res.json();
    }

    async function refreshDynamicModels(force = false) {
      const now = Date.now();
      if (modelsLoaded && (!force || now - lastModelFetch < 60000)) return;
      lastModelFetch = now;
      try {
        const res = await rpc('GetUserStatus', {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
        });
        const configs = res?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
        for (const c of configs) {
          const id = c?.modelOrAlias?.model || c?.modelOrAlias?.alias;
          const label = c?.label;
          if (id && label) {
            dynamicModels[id] = {
              name: label,
              limit: inferLimitByLabelOrId(label, id)
            };
          }
        }
        if (configs.length > 0) modelsLoaded = true;
      } catch {}
    }

    // 状态栏 DOM（优先内联嵌入输入框底部工具栏，兜底右下角悬浮）
    let bar = document.getElementById('antigravity-live-statusbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'antigravity-live-statusbar';
    }

    function applyInlineStyle(targetLeft) {
      bar.dataset.mode = 'inline';
      Object.assign(bar.style, {
        position: 'static',
        bottom: 'auto',
        right: 'auto',
        zIndex: 'auto',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '28px',
        padding: '0 8px',
        marginLeft: '4px',
        borderRadius: '9999px',
        backgroundColor: 'transparent',
        border: 'none',
        boxShadow: 'none',
        backdropFilter: 'none',
        webkitBackdropFilter: 'none',
        fontFamily: '"Google Sans Flex", "Google Sans", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        fontSize: '12px',
        fontWeight: '400',
        lineHeight: '1',
        whiteSpace: 'nowrap',
        flexShrink: '0',
        cursor: 'default',
        userSelect: 'none',
        transform: 'none',
        transition: 'background-color 0.15s ease, color 0.2s ease'
      });
      const refBtn = targetLeft.querySelector('button');
      bar.dataset.baseColor = refBtn ? getComputedStyle(refBtn).color : 'rgba(128, 128, 128, 0.85)';
      bar.onmouseenter = () => {
        if (bar.dataset.mode === 'inline') bar.style.backgroundColor = 'rgba(128, 128, 128, 0.10)';
      };
      bar.onmouseleave = () => {
        if (bar.dataset.mode === 'inline') bar.style.backgroundColor = 'transparent';
      };
    }

    function applyFloatingStyle() {
      bar.dataset.mode = 'floating';
      Object.assign(bar.style, {
        position: 'fixed',
        bottom: '12px',
        right: '24px',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        height: 'auto',
        padding: '5px 12px',
        marginLeft: '0',
        borderRadius: '8px',
        backgroundColor: 'rgba(24, 24, 37, 0.92)',
        color: '#10b981',
        border: '1px solid rgba(16, 185, 129, 0.35)',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.45)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: '12px',
        fontWeight: '600',
        cursor: 'pointer',
        userSelect: 'none',
        backdropFilter: 'blur(8px)',
        webkitBackdropFilter: 'blur(8px)',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)'
      });
      bar.onmouseenter = () => {
        if (bar.dataset.mode === 'floating') {
          bar.style.transform = 'translateY(-2px) scale(1.02)';
          bar.style.boxShadow = '0 6px 20px rgba(0, 0, 0, 0.6)';
        }
      };
      bar.onmouseleave = () => {
        if (bar.dataset.mode === 'floating') {
          bar.style.transform = 'none';
          bar.style.boxShadow = '0 4px 16px rgba(0, 0, 0, 0.45)';
        }
      };
    }

    function ensureMounted() {
      const footer = document.querySelector('[id="antigravity.agentSidePanelInputBox"] .agy-composer-footer, .agy-composer-footer');
      const leftGroup = footer?.firstElementChild;
      if (leftGroup) {
        if (bar.parentElement !== leftGroup || bar.dataset.mode !== 'inline') {
          leftGroup.appendChild(bar);
          applyInlineStyle(leftGroup);
        }
      } else if (bar.parentElement !== document.body || bar.dataset.mode !== 'floating') {
        document.body.appendChild(bar);
        applyFloatingStyle();
      }
    }

    ensureMounted();

    async function updateContext() {
      try {
        ensureMounted();
        const trajData = await rpc('GetAllCascadeTrajectories', {
          metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
        });
        const summaries = trajData?.trajectorySummaries || {};
        if (Object.keys(summaries).length === 0) {
          bar.innerHTML = '⚡ 无活跃会话';
          return;
        }

        // 优先从当前 URL 感知会话 ID
        const urlMatch = window.location.pathname.match(/\\/c\\/([a-zA-Z0-9_-]+)/);
        let targetId = urlMatch ? urlMatch[1] : null;
        let s = targetId ? summaries[targetId] : null;

        // 若未命中，优先取正在 RUNNING 的会话
        if (!s) {
          for (const [cid, sum] of Object.entries(summaries)) {
            if (sum.status === 'CASCADE_RUN_STATUS_RUNNING') {
              targetId = cid;
              s = sum;
              break;
            }
          }
        }

        // 最终降级取最新会话
        if (!s) {
          const sorted = Object.entries(summaries).sort((a, b) => (b[1].lastModifiedTime || '').localeCompare(a[1].lastModifiedTime || ''));
          targetId = sorted[0][0];
          s = sorted[0][1];
        }

        const stepCount = s.stepCount || 0;
        let detectedModel = '';
        let totalUsed = 0;
        let cacheRead = 0;
        let inputTokens = 0;
        let outputTokens = 0;

        if (stepCount > 0) {
          const startIndex = Math.max(0, stepCount - 40);
          const stepsData = await rpc('GetCascadeTrajectorySteps', {
            cascadeId: targetId,
            startIndex,
            endIndex: stepCount
          });
          const steps = stepsData?.steps || [];
          let lastCheckIdx = -1;

          for (let i = steps.length - 1; i >= 0; i--) {
            const mu = steps[i]?.metadata?.modelUsage;
            if (mu) {
              inputTokens = parseInt(String(mu.inputTokens || '0'), 10);
              cacheRead = parseInt(String(mu.cacheReadTokens || '0'), 10);
              outputTokens = parseInt(String(mu.outputTokens || '0'), 10);
              detectedModel = mu.model || '';
              lastCheckIdx = i;
              break;
            }
          }

          let delta = 0;
          const dStart = lastCheckIdx >= 0 ? lastCheckIdx + 1 : 0;
          for (let i = dStart; i < steps.length; i++) {
            const st = steps[i];
            if (st?.metadata?.toolCallOutputTokens) delta += st.metadata.toolCallOutputTokens;
            if (st?.userInput) delta += estimateTokens(st.userInput.userResponse || '');
            if (st?.plannerResponse) {
              delta += estimateTokens(st.plannerResponse.response || '');
              delta += estimateTokens(st.plannerResponse.thinking || '');
            }
          }
          totalUsed = (cacheRead + inputTokens) + outputTokens + delta;
        }

        const rawModel = s.requestedModel || s.generatorModel || '';
        const effectiveModel = detectedModel || rawModel;
        await refreshDynamicModels(!dynamicModels[effectiveModel]);
        const modelInfo = resolveLimit(effectiveModel);

        const ratio = modelInfo.limit > 0 ? (totalUsed / modelInfo.limit) * 100 : 0;
        const pctStr = ratio.toFixed(1);

        const fmt = (n) => (n === 262144 || n === 256000) ? '256k' : (n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)));
        const usedStr = fmt(totalUsed);
        const limitStr = fmt(modelInfo.limit);

        const isInline = bar.dataset.mode === 'inline';
        let color = isInline ? (bar.dataset.baseColor || 'rgba(128, 128, 128, 0.85)') : '#10b981';
        let bgBorder = 'rgba(16, 185, 129, 0.35)';
        let icon = '⚡';

        if (ratio >= 80) {
          color = isInline ? '#dc2626' : '#ef4444';
          bgBorder = 'rgba(239, 68, 68, 0.5)';
          icon = '🔥';
        } else if (ratio >= 50) {
          color = isInline ? '#d97706' : '#f59e0b';
          bgBorder = 'rgba(245, 158, 11, 0.45)';
          icon = '⚠️';
        }

        bar.style.color = color;
        if (!isInline) {
          bar.style.borderColor = bgBorder;
        }
        bar.innerHTML = (isInline ? '' : icon + ' ') + '<span>' + pctStr + '%</span> <span style=\"font-size:11px; opacity:0.85; font-weight:normal; margin-left:2px;\">(' + usedStr + '/' + limitStr + ')</span>';

        bar.title = '【Antigravity 状态栏上下文监控】\\n' +
                    '当前会话: ' + (s.summary || targetId) + '\\n' +
                    '使用模型: ' + modelInfo.name + '\\n' +
                    '总消耗量: ' + totalUsed.toLocaleString() + ' / ' + modelInfo.limit.toLocaleString() + ' tokens (' + pctStr + '%)\\n' +
                    '剩余可用: ' + Math.max(0, modelInfo.limit - totalUsed).toLocaleString() + ' tokens\\n' +
                    '---------------------------\\n' +
                    'Prompt缓存: ' + cacheRead.toLocaleString() + ' tokens\\n' +
                    '轮次输入: ' + inputTokens.toLocaleString() + ' tokens\\n' +
                    '模型回复: ' + outputTokens.toLocaleString() + ' tokens';
      } catch (e) {
        // 静默
      }
    }

    if (window.__ag_statusbar_timer) {
      clearInterval(window.__ag_statusbar_timer);
    }
    window.__ag_statusbar_timer = setInterval(updateContext, 2000);
    updateContext();

    return 'STATUSBAR_ACTIVATED_SUCCESSFULLY';
  })();
  `;

  await new Promise((resolve, reject) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: injectCode }
      }));
    };

    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      console.log('Result:', JSON.stringify(data.result));
      ws.close();
      resolve();
    };

    ws.onerror = (err) => reject(err);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
