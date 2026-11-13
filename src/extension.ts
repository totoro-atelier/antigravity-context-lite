import * as vscode from 'vscode';
import * as https from 'https';
import * as http from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ─── 接口定义 ────────────────────────────────────────────────────────────────
interface LSInfo {
    pid: number;
    csrfToken: string;
    port: number;
    useTls: boolean;
}

interface TokenUsage {
    sessionSummary: string;
    model: string;
    modelDisplayName: string;
    contextLimit: number;
    totalUsed: number;
    inputTokens: number;
    cacheReadTokens: number;
    outputTokens: number;
    deltaEstimated: number;
    ratio: number;
    status: string;
}

// ─── 模型上下文上限与显示名映射 ──────────────────────────────────────────────
const KNOWN_LIMITS: Record<string, { name: string; limit: number }> = {
    'MODEL_PLACEHOLDER_M318': { name: 'Gemini 3.8 Flash (High)', limit: 262_144 },
    'MODEL_PLACEHOLDER_M319': { name: 'Gemini 3.8 Flash (Medium)', limit: 262_144 },
    'MODEL_PLACEHOLDER_M320': { name: 'Gemini 3.8 Flash (Low)', limit: 262_144 },
    'MODEL_PLACEHOLDER_M298': { name: 'Gemini 3.7 Flash', limit: 262_144 },
    'MODEL_PLACEHOLDER_M71':  { name: 'Gemini 3.6 Flash', limit: 262_144 },
    'MODEL_PLACEHOLDER_M84':  { name: 'Gemini 3.5 Flash', limit: 262_144 },
    'MODEL_PLACEHOLDER_M16':  { name: 'Gemini 3.1 Pro', limit: 262_144 },
    'MODEL_PLACEHOLDER_M37':  { name: 'Gemini 3.1 Pro', limit: 262_144 },
    'MODEL_PLACEHOLDER_M35':  { name: 'Claude Sonnet 4.6', limit: 200_000 },
    'MODEL_PLACEHOLDER_M26':  { name: 'Claude Opus 4.6', limit: 200_000 },
    'MODEL_PLACEHOLDER_M400': { name: 'Claude Opus 5.5 (Low)', limit: 200_000 },
    'MODEL_PLACEHOLDER_M401': { name: 'Claude Opus 5.5 (Medium)', limit: 200_000 },
    'MODEL_PLACEHOLDER_M402': { name: 'Claude Opus 5.5 (High)', limit: 200_000 },
    'MODEL_PLACEHOLDER_M403': { name: 'Claude Sonnet 5.5 (Low)', limit: 200_000 },
    'MODEL_PLACEHOLDER_M404': { name: 'Claude Sonnet 5.5 (Medium)', limit: 200_000 },
    'MODEL_PLACEHOLDER_M405': { name: 'Claude Sonnet 5.5 (High)', limit: 200_000 },
    'MODEL_PLACEHOLDER_M408': { name: 'Gemini 4 Argon', limit: 262_144 },
    'MODEL_PLACEHOLDER_M409': { name: 'Gemini 4 Argon (Low)', limit: 262_144 },
    'MODEL_PLACEHOLDER_M410': { name: 'Gemini 4 Argon (Medium)', limit: 262_144 },
    'MODEL_PLACEHOLDER_M411': { name: 'Gemini 4 Argon (High)', limit: 262_144 },
    'MODEL_PLACEHOLDER_M412': { name: 'Gemini 4 Argon', limit: 262_144 },
    'MODEL_PLACEHOLDER_M413': { name: 'Gemini 4 Argon', limit: 262_144 },
    'MODEL_PLACEHOLDER_M417': { name: 'Gemini 4 Argon (High)', limit: 262_144 },
    'MODEL_PLACEHOLDER_M418': { name: 'Gemini 4 Argon (Medium)', limit: 262_144 },
    'MODEL_PLACEHOLDER_M419': { name: 'Gemini 4 Argon (Low)', limit: 262_144 },
    'MODEL_PLACEHOLDER_M420': { name: 'Gemini 4 Argon', limit: 262_144 },
    'MODEL_PLACEHOLDER_M421': { name: 'Gemini 4 Argon', limit: 262_144 },
    'MODEL_PLACEHOLDER_M429': { name: 'Gemini 4 Argon', limit: 262_144 },
    'MODEL_PLACEHOLDER_M430': { name: 'Gemini 4 Argon', limit: 262_144 },
    'MODEL_PLACEHOLDER_M431': { name: 'Gemini 4 Argon', limit: 262_144 },
};

const dynamicModels: Record<string, { displayName: string; limit: number }> = {};
let modelsLoaded = false;
let lastModelFetch = 0;

function inferLimitByLabelOrId(label: string, rawModel: string): number {
    const text = `${label} ${rawModel}`.toLowerCase();
    if (text.includes('claude') || text.includes('sonnet') || text.includes('opus') || text.includes('haiku')) {
        return 200_000;
    }
    if (text.includes('gpt-oss') || text.includes('128k')) {
        return 128_000;
    }
    if (text.includes('2m') || text.includes('2000k')) {
        return 2_000_000;
    }
    return 262_144;
}

async function refreshDynamicModels(ls: LSInfo, force = false): Promise<void> {
    const now = Date.now();
    if (modelsLoaded && (!force || now - lastModelFetch < 60_000)) { return; }
    lastModelFetch = now;
    try {
        const res = await rpcCall(ls, 'GetUserStatus', {
            metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
        });
        const userStatus = res.userStatus as Record<string, unknown> | undefined;
        const cfgData = userStatus?.cascadeModelConfigData as Record<string, unknown> | undefined;
        const configs = (cfgData?.clientModelConfigs as Array<Record<string, unknown>>) || [];
        for (const c of configs) {
            const moa = c.modelOrAlias as Record<string, unknown> | undefined;
            const id = (moa?.model as string) || (moa?.alias as string) || '';
            const label = (c.label as string) || '';
            if (id && label) {
                dynamicModels[id] = {
                    displayName: label,
                    limit: inferLimitByLabelOrId(label, id)
                };
            }
        }
        if (configs.length > 0) { modelsLoaded = true; }
    } catch { /* ignore */ }
}

function resolveModelInfo(rawModel: string): { displayName: string; limit: number } {
    if (dynamicModels[rawModel]) {
        return dynamicModels[rawModel];
    }
    if (KNOWN_LIMITS[rawModel]) {
        return { displayName: KNOWN_LIMITS[rawModel].name, limit: KNOWN_LIMITS[rawModel].limit };
    }
    const lower = rawModel.toLowerCase();
    const limit = inferLimitByLabelOrId('', rawModel);
    let displayName = rawModel || 'Gemini Model';
    if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('haiku')) {
        displayName = rawModel || 'Claude Model';
    } else if (lower.includes('argon')) {
        displayName = 'Gemini 4 Argon';
    } else if (rawModel.startsWith('MODEL_PLACEHOLDER_')) {
        displayName = `Gemini (New: ${rawModel.replace('MODEL_PLACEHOLDER_', '')})`;
    }
    return { displayName, limit };
}

// ─── 本地语言服务器进程与端口发现 ───────────────────────────────────────────
async function findListeningPorts(pid: number): Promise<number[]> {
    const ports: number[] = [];
    if (process.platform === 'win32') {
        try {
            const { stdout } = await execFileAsync('netstat', ['-ano'], { timeout: 3000 });
            for (const line of stdout.split('\n')) {
                const parts = line.trim().split(/\s+/);
                if (parts.length >= 5 && parts[0].toUpperCase() === 'TCP') {
                    const linePid = parseInt(parts[parts.length - 1], 10);
                    if (linePid === pid) {
                        const m = parts[1].match(/:(\d+)$/);
                        if (m) { ports.push(parseInt(m[1], 10)); }
                    }
                }
            }
        } catch { /* ignore */ }
    } else {
        try {
            const { stdout } = await execFileAsync('ss', ['-tlnp'], { timeout: 3000 });
            for (const line of stdout.split('\n')) {
                if (line.includes(`pid=${pid},`) || line.includes(`pid=${pid}`)) {
                    const parts = line.trim().split(/\s+/);
                    const localAddr = parts[3] || '';
                    const m = localAddr.match(/:(\d+)$/);
                    if (m) { ports.push(parseInt(m[1], 10)); }
                }
            }
        } catch {
            try {
                const { stdout } = await execFileAsync('lsof', ['-Pan', '-p', String(pid), '-iTCP', '-sTCP:LISTEN'], { timeout: 3000 });
                for (const line of stdout.split('\n')) {
                    const m = line.match(/:(\d+)\s+\(LISTEN\)/);
                    if (m) { ports.push(parseInt(m[1], 10)); }
                }
            } catch { /* ignore */ }
        }
    }
    return Array.from(new Set(ports));
}

async function probePort(port: number, csrfToken: string, useTls: boolean): Promise<boolean> {
    return new Promise((resolve) => {
        const client = useTls ? https : http;
        const req = client.request({
            hostname: '127.0.0.1',
            port,
            path: '/exa.language_server_pb.LanguageServerService/GetUnleashData',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'x-codeium-csrf-token': csrfToken,
                'Content-Length': 2
            },
            timeout: 1500,
            rejectUnauthorized: false
        }, (res) => {
            resolve(res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
        req.write('{}');
        req.end();
    });
}

async function discoverLanguageServer(): Promise<LSInfo | null> {
    try {
        let psOutput = '';
        if (process.platform === 'win32') {
            try {
                const { stdout } = await execFileAsync('powershell.exe', [
                    '-NoProfile', '-NoLogo', '-Command',
                    'Get-CimInstance Win32_Process -Filter "Name like \'language_server%\'" | Select-Object ProcessId, CommandLine | ConvertTo-Csv -NoTypeInformation'
                ], { timeout: 5000 });
                psOutput = stdout;
            } catch {
                return null;
            }
        } else {
            const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], { timeout: 5000 });
            psOutput = stdout;
        }

        const lines = psOutput.split('\n').filter(l => l.toLowerCase().includes('language_server'));
        if (lines.length === 0) { return null; }

        for (const line of lines) {
            const csrfMatch = line.match(/--csrf_token\s+([^\s,"]+)/);
            if (!csrfMatch) { continue; }
            const csrfToken = csrfMatch[1];

            let pid: number | null = null;
            const pidMatch = line.trim().match(/^"?(\d+)"?/);
            if (pidMatch) {
                pid = parseInt(pidMatch[1], 10);
            } else {
                const trailingPidMatch = line.trim().match(/,(\d+)\s*$/);
                if (trailingPidMatch) { pid = parseInt(trailingPidMatch[1], 10); }
            }
            if (!pid) { continue; }

            const ports = await findListeningPorts(pid);
            for (const port of ports) {
                if (await probePort(port, csrfToken, true)) {
                    return { pid, csrfToken, port, useTls: true };
                }
                if (await probePort(port, csrfToken, false)) {
                    return { pid, csrfToken, port, useTls: false };
                }
            }
        }
    } catch { /* ignore */ }
    return null;
}

// ─── RPC 请求封装 ────────────────────────────────────────────────────────────
function rpcCall(ls: LSInfo, endpoint: string, body: Record<string, unknown>, timeoutMs = 8000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const client = ls.useTls ? https : http;
        const postData = JSON.stringify(body);
        const req = client.request({
            hostname: '127.0.0.1',
            port: ls.port,
            path: `/exa.language_server_pb.LanguageServerService/${endpoint}`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Connect-Protocol-Version': '1',
                'x-codeium-csrf-token': ls.csrfToken,
                'Content-Length': Buffer.byteLength(postData)
            },
            timeout: timeoutMs,
            rejectUnauthorized: false
        }, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 150)}`));
                    return;
                }
                try {
                    resolve(JSON.parse(data) as Record<string, unknown>);
                } catch (e) {
                    reject(e);
                }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('RPC timeout')); });
        req.write(postData);
        req.end();
    });
}

// ─── Token 实时估算算法 ──────────────────────────────────────────────────────
function estimateTokens(text: string): number {
    if (!text) { return 0; }
    let ascii = 0;
    let nonAscii = 0;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) <= 127) { ascii++; } else { nonAscii++; }
    }
    return Math.round(ascii / 4 + nonAscii / 1.5);
}

// ─── 核心会话用量拉取 ────────────────────────────────────────────────────────
async function getContextUsage(ls: LSInfo): Promise<TokenUsage | null> {
    // 1. 获取所有会话列表
    const trajResp = await rpcCall(ls, 'GetAllCascadeTrajectories', {
        metadata: { ideName: 'antigravity', extensionName: 'antigravity' }
    });
    const summaries = trajResp.trajectorySummaries as Record<string, Record<string, unknown>> | undefined;
    if (!summaries || Object.keys(summaries).length === 0) { return null; }

    // 2. 筛选目标会话：优先 RUNNING 会话，否则按最近修改时间排序取最新
    let targetCascadeId = '';
    let targetSummary: Record<string, unknown> | null = null;

    for (const [cid, s] of Object.entries(summaries)) {
        if (s.status === 'CASCADE_RUN_STATUS_RUNNING') {
            targetCascadeId = cid;
            targetSummary = s;
            break;
        }
    }
    if (!targetCascadeId) {
        const sorted = Object.entries(summaries).sort((a, b) => {
            const timeA = (a[1].lastModifiedTime as string) || '';
            const timeB = (b[1].lastModifiedTime as string) || '';
            return timeB.localeCompare(timeA);
        });
        targetCascadeId = sorted[0][0];
        targetSummary = sorted[0][1];
    }

    if (!targetSummary) { return null; }

    const stepCount = (targetSummary.stepCount as number) || 0;
    if (stepCount === 0) {
        const rawModel = (targetSummary.requestedModel as string) || (targetSummary.generatorModel as string) || '';
        const { displayName, limit } = resolveModelInfo(rawModel);
        return {
            sessionSummary: (targetSummary.summary as string) || targetCascadeId,
            model: rawModel,
            modelDisplayName: displayName,
            contextLimit: limit,
            totalUsed: 0,
            inputTokens: 0,
            cacheReadTokens: 0,
            outputTokens: 0,
            deltaEstimated: 0,
            ratio: 0,
            status: (targetSummary.status as string) || 'IDLE'
        };
    }

    // 3. 拉取步骤数据（获取最近一批 steps）
    const startIndex = Math.max(0, stepCount - 60);
    const stepsResp = await rpcCall(ls, 'GetCascadeTrajectorySteps', {
        cascadeId: targetCascadeId,
        startIndex,
        endIndex: stepCount
    });

    const steps = (stepsResp.steps as Array<Record<string, unknown>>) || [];

    // 4. 计算用量：定位最近一次 Checkpoint 作为基线，累计后续增量
    let checkpointInput = 0;
    let checkpointCacheRead = 0;
    let checkpointOutput = 0;
    let lastCheckpointIdx = -1;
    let detectedModel = '';

    for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        const meta = s.metadata as Record<string, unknown> | undefined;
        if (meta?.modelUsage) {
            const mu = meta.modelUsage as Record<string, unknown>;
            checkpointInput = parseInt(String(mu.inputTokens || '0'), 10);
            checkpointCacheRead = parseInt(String(mu.cacheReadTokens || '0'), 10);
            checkpointOutput = parseInt(String(mu.outputTokens || '0'), 10);
            detectedModel = (mu.model as string) || detectedModel;
            lastCheckpointIdx = i;
            break;
        }
    }

    // 统计 Checkpoint 后的增量字符
    let delta = 0;
    const deltaStart = lastCheckpointIdx >= 0 ? lastCheckpointIdx + 1 : 0;
    for (let i = deltaStart; i < steps.length; i++) {
        const s = steps[i];
        const meta = s.metadata as Record<string, unknown> | undefined;
        if (meta?.toolCallOutputTokens) {
            delta += (meta.toolCallOutputTokens as number) || 0;
        }
        if (s.userInput) {
            const ui = s.userInput as Record<string, unknown>;
            delta += estimateTokens((ui.userResponse as string) || '');
        }
        if (s.plannerResponse) {
            const pr = s.plannerResponse as Record<string, unknown>;
            delta += estimateTokens((pr.response as string) || '');
            delta += estimateTokens((pr.thinking as string) || '');
        }
    }

    const effectiveModel = detectedModel || (targetSummary.requestedModel as string) || '';
    await refreshDynamicModels(ls, !dynamicModels[effectiveModel]);
    const { displayName, limit } = resolveModelInfo(effectiveModel);

    // 真实输入上下文 = cacheReadTokens + inputTokens
    const totalInput = checkpointCacheRead + checkpointInput;
    const totalUsed = totalInput + checkpointOutput + delta;
    const ratio = limit > 0 ? (totalUsed / limit) * 100 : 0;

    return {
        sessionSummary: (targetSummary.summary as string) || targetCascadeId,
        model: effectiveModel,
        modelDisplayName: displayName,
        contextLimit: limit,
        totalUsed,
        inputTokens: checkpointInput,
        cacheReadTokens: checkpointCacheRead,
        outputTokens: checkpointOutput,
        deltaEstimated: delta,
        ratio,
        status: (targetSummary.status as string) || 'IDLE'
    };
}

// ─── 格式化工具函数 ──────────────────────────────────────────────────────────
function formatTokens(count: number): string {
    if (count === 262_144 || count === 256_000) {
        return '256k';
    }
    if (count >= 1_000_000) {
        return (count / 1_000_000).toFixed(1) + 'M';
    }
    if (count >= 1_000) {
        return (count / 1_000).toFixed(1) + 'k';
    }
    return String(count);
}

// ─── 扩展激活入口 ────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
    const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.name = 'Antigravity Context Lite';
    statusBar.command = 'antigravity-context-lite.refresh';
    statusBar.text = '$(sync~spin) 上下文探测中...';
    statusBar.show();

    let cachedLs: LSInfo | null = null;
    let isPolling = false;
    let timer: NodeJS.Timeout | null = null;

    async function update() {
        if (isPolling) { return; }
        isPolling = true;
        try {
            if (!cachedLs) {
                cachedLs = await discoverLanguageServer();
            }
            if (!cachedLs) {
                statusBar.text = '$(zap) 未检测到 LS';
                statusBar.tooltip = '未发现 Antigravity Language Server 进程，将在后台自动重试';
                statusBar.backgroundColor = undefined;
                return;
            }

            const usage = await getContextUsage(cachedLs);
            if (!usage) {
                statusBar.text = '$(zap) 无活跃会话';
                statusBar.tooltip = '当前未检测到任何对话会话';
                statusBar.backgroundColor = undefined;
                return;
            }

            const usedStr = formatTokens(usage.totalUsed);
            const limitStr = formatTokens(usage.contextLimit);
            const pctStr = usage.ratio.toFixed(1);

            // 依据使用率调整图标与警报背景
            if (usage.ratio >= 80) {
                statusBar.text = `$(flame) ${usedStr}/${limitStr} (${pctStr}%)`;
                statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            } else if (usage.ratio >= 50) {
                statusBar.text = `$(warning) ${usedStr}/${limitStr} (${pctStr}%)`;
                statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            } else {
                statusBar.text = `$(zap) ${usedStr}/${limitStr} (${pctStr}%)`;
                statusBar.backgroundColor = undefined;
            }

            // Markdown 格式的高清 Tooltip
            const tooltip = new vscode.MarkdownString('', true);
            tooltip.isTrusted = true;
            tooltip.appendMarkdown(`### ⚡ Antigravity 上下文监控\n\n`);
            tooltip.appendMarkdown(`- **当前会话**: \`${usage.sessionSummary}\`\n`);
            tooltip.appendMarkdown(`- **当前模型**: \`${usage.modelDisplayName}\`\n`);
            tooltip.appendMarkdown(`- **上下文占用**: **${usage.totalUsed.toLocaleString()}** / ${usage.contextLimit.toLocaleString()} tokens (**${pctStr}%**)\n`);
            tooltip.appendMarkdown(`- **剩余可用**: ${(usage.contextLimit - usage.totalUsed).toLocaleString()} tokens\n\n`);
            tooltip.appendMarkdown(`---\n`);
            tooltip.appendMarkdown(`*基线明细*:\n`);
            tooltip.appendMarkdown(`- 缓存/Prompt Token: ${usage.cacheReadTokens.toLocaleString()}\n`);
            tooltip.appendMarkdown(`- 轮次输入 Token: ${usage.inputTokens.toLocaleString()}\n`);
            tooltip.appendMarkdown(`- 模型回复 Token: ${usage.outputTokens.toLocaleString()}\n`);
            tooltip.appendMarkdown(`- 增量字符估算: +${usage.deltaEstimated.toLocaleString()} tokens\n\n`);
            tooltip.appendMarkdown(`*(点击状态栏可立即刷新)*`);

            statusBar.tooltip = tooltip;
        } catch {
            cachedLs = null; // 连接失败时重置缓存重新探测
            statusBar.text = '$(sync~spin) 重连中...';
            statusBar.backgroundColor = undefined;
        } finally {
            isPolling = false;
        }
    }

    // 注册手动刷新命令
    const refreshCmd = vscode.commands.registerCommand('antigravity-context-lite.refresh', () => {
        cachedLs = null;
        update();
    });

    // 启动 3 秒轮询
    update();
    timer = setInterval(update, 3000);

    context.subscriptions.push(statusBar, refreshCmd, {
        dispose: () => {
            if (timer) { clearInterval(timer); }
            statusBar.dispose();
        }
    });
}

export function deactivate() {}
