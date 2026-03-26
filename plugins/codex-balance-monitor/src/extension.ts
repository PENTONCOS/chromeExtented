import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import * as vscode from 'vscode';

const SECRET_TOKEN_KEY = 'codexBalance.authToken';

type SummaryData = {
    card_balance?: string | number;
    today_request_count?: string | number;
    card_name?: string;
    card_expire_date?: string;
    user_registered_at?: string;
    card_daily_limit?: string | number;
    today_spent_amount?: string | number;
    [key: string]: unknown;
};

type ApiEnvelope = {
    data?: SummaryData;
    error?: string;
    details?: string;
    code?: string;
};

class CodexBalanceExtension {
    private readonly statusBar: vscode.StatusBarItem;
    private readonly outputChannel: vscode.OutputChannel;
    private panel: vscode.WebviewPanel | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;
    private lastSummary: SummaryData | undefined;
    private lastUpdatedAt: Date | undefined;
    private lastError: string | undefined;
    private refreshInFlight = false;
    private pendingRefresh = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.statusBar.name = 'Codex Balance';
        this.statusBar.text = '$(dashboard) Codex 余量';
        this.statusBar.command = 'codexBalance.openPanel';
        this.statusBar.tooltip = '点击查看 Codex 余量详情';

        this.outputChannel = vscode.window.createOutputChannel('Codex Balance');
    }

    public async activate(): Promise<void> {
        this.context.subscriptions.push(
            this.statusBar,
            this.outputChannel,
            vscode.commands.registerCommand('codexBalance.refreshBalance', async () => {
                await this.refreshBalance({ silent: false, trigger: 'command' });
            }),
            vscode.commands.registerCommand('codexBalance.openPanel', async () => {
                await this.openPanel();
            }),
            vscode.commands.registerCommand('codexBalance.setAuthToken', async () => {
                await this.setToken();
            }),
            vscode.commands.registerCommand('codexBalance.clearAuthToken', async () => {
                await this.clearToken();
            }),
            vscode.commands.registerCommand('codexBalance.openDashboard', async () => {
                await this.openDashboard();
            }),
            vscode.commands.registerCommand('codexBalance.toggleCompactMode', async () => {
                await this.toggleCompactMode();
            }),
            vscode.workspace.onDidChangeConfiguration(async (event) => {
                if (!event.affectsConfiguration('codexBalance')) {
                    return;
                }

                this.configureAutoRefresh();

                if (
                    event.affectsConfiguration('codexBalance.apiBaseUrl') ||
                    event.affectsConfiguration('codexBalance.requestTimeoutMs') ||
                    event.affectsConfiguration('codexBalance.authToken')
                ) {
                    await this.refreshBalance({ silent: true, trigger: 'config-change' });
                } else {
                    await this.renderWebview();
                }
            })
        );

        this.statusBar.show();
        this.configureAutoRefresh();
        await this.refreshBalance({ silent: true, trigger: 'startup' });
    }

    public dispose(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private getConfig(): vscode.WorkspaceConfiguration {
        return vscode.workspace.getConfiguration('codexBalance');
    }

    private getApiBaseUrl(): string {
        const raw = this.getConfig().get<string>('apiBaseUrl', 'https://codex-for.me/web/api/v1').trim();
        return raw.replace(/\/+$/, '');
    }

    private getDashboardUrl(): string {
        return this.getConfig().get<string>('dashboardUrl', 'https://codex-for.me/dashboard.html').trim();
    }

    private getTimeoutMs(): number {
        const value = this.getConfig().get<number>('requestTimeoutMs', 10000);
        return Number.isFinite(value) && value >= 1000 ? value : 10000;
    }

    private getAutoRefreshSeconds(): number {
        const value = this.getConfig().get<number>('autoRefreshSeconds', 60);
        return Number.isFinite(value) && value >= 0 ? value : 60;
    }

    private isCompactModeEnabled(): boolean {
        return this.getConfig().get<boolean>('compactMode', false);
    }

    private async getToken(): Promise<string | undefined> {
        const secretToken = (await this.context.secrets.get(SECRET_TOKEN_KEY))?.trim();
        if (secretToken) {
            return normalizeToken(secretToken);
        }

        const configuredToken = this.getConfig().get<string>('authToken', '').trim();
        if (configuredToken) {
            return normalizeToken(configuredToken);
        }

        return undefined;
    }

    private configureAutoRefresh(): void {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }

        const seconds = this.getAutoRefreshSeconds();
        if (seconds <= 0) {
            this.log('自动刷新已关闭。');
            return;
        }

        this.refreshTimer = setInterval(() => {
            void this.refreshBalance({ silent: true, trigger: 'auto-refresh' });
        }, seconds * 1000);
        this.log(`自动刷新间隔：${seconds} 秒。`);
    }

    private async refreshBalance(options: { silent: boolean; trigger: string }): Promise<void> {
        if (this.refreshInFlight) {
            this.pendingRefresh = true;
            this.log(`跳过重复刷新（触发源: ${options.trigger}），等待当前请求结束后补一次。`);
            return;
        }

        this.refreshInFlight = true;
        this.statusBar.text = '$(sync~spin) 刷新 Codex 余量...';
        this.statusBar.command = 'codexBalance.openPanel';
        this.statusBar.tooltip = '正在刷新，请稍候...';

        try {
            const token = await this.getToken();
            if (!token) {
                this.lastSummary = undefined;
                this.lastError = '未配置 Token。请运行“Codex 余额: 设置 Token”。';
                this.lastUpdatedAt = undefined;
                this.updateStatusBar();
                await this.renderWebview();

                if (!options.silent) {
                    const action = await vscode.window.showWarningMessage(
                        '尚未配置 Codex Token，无法获取余量。',
                        '现在设置'
                    );
                    if (action === '现在设置') {
                        await this.setToken();
                    }
                }
                return;
            }

            const summary = await this.fetchSummary(token);
            this.lastSummary = summary;
            this.lastUpdatedAt = new Date();
            this.lastError = undefined;
            this.updateStatusBar();
            await this.renderWebview();

            if (!options.silent) {
                vscode.window.setStatusBarMessage(`Codex 今日已用已刷新：${formatCurrencyOrDash(summary.today_spent_amount)}`, 2500);
            }
        } catch (error) {
            const message = toErrorMessage(error);
            this.lastError = message;
            this.lastSummary = undefined;
            this.lastUpdatedAt = undefined;
            this.updateStatusBar();
            await this.renderWebview();
            this.log(`刷新失败（触发源: ${options.trigger}）: ${message}`);

            if (!options.silent) {
                vscode.window.showErrorMessage(`刷新 Codex 余量失败：${message}`);
            }
        } finally {
            this.refreshInFlight = false;
            if (this.pendingRefresh) {
                this.pendingRefresh = false;
                void this.refreshBalance({ silent: true, trigger: 'queued' });
            }
        }
    }

    private async fetchSummary(token: string): Promise<SummaryData> {
        const endpoint = `${this.getApiBaseUrl()}/users/summary`;
        const timeoutMs = this.getTimeoutMs();
        const { status, body } = await this.requestJson(endpoint, token, timeoutMs);

        const envelope = asApiEnvelope(body);

        if (status < 200 || status >= 300) {
            const detail = envelope.details ? ` (${envelope.details})` : '';
            throw new Error(`${envelope.error || `HTTP ${status}`}${detail}`);
        }

        if (!envelope.data || typeof envelope.data !== 'object') {
            throw new Error('接口返回异常：缺少 data 字段。');
        }

        return envelope.data;
    }

    private requestJson(
        urlString: string,
        token: string,
        timeoutMs: number
    ): Promise<{ status: number; body: unknown }> {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(urlString);
            const client = parsedUrl.protocol === 'http:' ? http : https;

            const request = client.request(
                urlString,
                {
                    method: 'GET',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    }
                },
                (response: http.IncomingMessage) => {
                    const chunks: string[] = [];
                    response.setEncoding('utf8');
                    response.on('data', (chunk: string) => chunks.push(chunk));
                    response.on('end', () => {
                        const raw = chunks.join('');
                        let parsedBody: unknown = {};
                        if (raw.trim().length > 0) {
                            try {
                                parsedBody = JSON.parse(raw);
                            } catch {
                                reject(new Error(`接口返回了非 JSON 内容：${raw.slice(0, 120)}`));
                                return;
                            }
                        }

                        resolve({
                            status: response.statusCode || 0,
                            body: parsedBody
                        });
                    });
                }
            );

            request.on('error', (error: Error) => {
                reject(error);
            });

            request.setTimeout(timeoutMs, () => {
                request.destroy(new Error(`请求超时（>${timeoutMs}ms）`));
            });

            request.end();
        });
    }

    private updateStatusBar(): void {
        if (this.lastSummary) {
            const balance = formatCurrency(this.lastSummary.card_balance);
            const planName = this.lastSummary.card_name ? String(this.lastSummary.card_name) : '-';
            const updateText = this.lastUpdatedAt
                ? this.lastUpdatedAt.toLocaleTimeString()
                : '未知时间';
            const registeredAt = this.lastSummary.user_registered_at
                ? safeDateString(this.lastSummary.user_registered_at)
                : '-';
            const expireAt = this.lastSummary.card_expire_date
                ? safeDateString(this.lastSummary.card_expire_date)
                : '-';
            const dailyBudget = formatCurrencyOrDash(this.lastSummary.card_daily_limit);
            const todaySpent = formatCurrencyOrDash(this.lastSummary.today_spent_amount);

            this.statusBar.text = `$(pulse) 今日已用 ${todaySpent}`;
            this.statusBar.command = 'codexBalance.refreshBalance';
            this.statusBar.tooltip = [
                `今日已用: ${todaySpent}`,
                `Codex 余量: ${balance}`,
                `套餐: ${planName}`,
                `注册时间: ${registeredAt}`,
                `到期时间: ${expireAt}`,
                `每日预算: ${dailyBudget}`,
                `更新时间: ${updateText}`,
                '',
                '点击可立即刷新'
            ].join('\n');
            return;
        }

        if (this.lastError?.includes('未配置 Token')) {
            this.statusBar.text = '$(key) 设置 Codex Token';
            this.statusBar.command = 'codexBalance.openPanel';
            this.statusBar.tooltip = this.lastError;
            return;
        }

        this.statusBar.text = '$(warning) Codex 余量异常';
        this.statusBar.command = 'codexBalance.openPanel';
        this.statusBar.tooltip = this.lastError || '请点击查看详情';
    }

    private async openPanel(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One, true);
            await this.renderWebview();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'codexBalancePanel',
            'Codex 余额监控',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        this.panel.onDidDispose(
            () => {
                this.panel = undefined;
            },
            null,
            this.context.subscriptions
        );

        this.panel.webview.onDidReceiveMessage(
            async (message: { command?: string }) => {
                switch (message.command) {
                    case 'refresh':
                        await this.refreshBalance({ silent: false, trigger: 'panel' });
                        break;
                    case 'toggleCompactMode':
                        await this.toggleCompactMode();
                        break;
                    case 'setToken':
                        await this.setToken();
                        break;
                    case 'clearToken':
                        await this.clearToken();
                        break;
                    case 'openDashboard':
                        await this.openDashboard();
                        break;
                    default:
                        break;
                }
            },
            null,
            this.context.subscriptions
        );

        await this.renderWebview();
    }

    private async renderWebview(): Promise<void> {
        if (!this.panel) {
            return;
        }

        const compactMode = this.isCompactModeEnabled();
        const tokenConfigured = Boolean(await this.getToken());
        const balance = this.lastSummary ? formatCurrency(this.lastSummary.card_balance) : '--';
        const todayRequests = this.lastSummary ? String(this.lastSummary.today_request_count ?? 0) : '--';
        const todayTokens = this.lastSummary ? formatTokenCount(getTodayTokenCount(this.lastSummary)) : '--';
        const planName = this.lastSummary ? String(this.lastSummary.card_name ?? '-') : '--';
        const registeredAt = this.lastSummary?.user_registered_at
            ? safeDateString(this.lastSummary.user_registered_at)
            : '--';
        const expireAt = this.lastSummary?.card_expire_date
            ? safeDateString(this.lastSummary.card_expire_date)
            : '--';
        const dailyBudget = this.lastSummary
            ? formatCurrencyOrDash(this.lastSummary.card_daily_limit)
            : '--';
        const todaySpent = this.lastSummary
            ? formatCurrencyOrDash(this.lastSummary.today_spent_amount)
            : '--';
        const updatedAt = this.lastUpdatedAt ? this.lastUpdatedAt.toLocaleString() : '--';
        const compactModeText = compactMode ? '开' : '关';
        const statusText = this.lastError
            ? `状态：${escapeHtml(this.lastError)}`
            : this.lastSummary
                ? '状态：已连接，数据正常'
                : tokenConfigured
                    ? '状态：等待首次刷新'
                    : '状态：请先配置 Token';
        const errorBlock = this.lastError
            ? `<p class="error">${escapeHtml(this.lastError)}</p>`
            : '';

        this.panel.webview.html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --bg: #f6f8fb;
      --card: #ffffff;
      --text: #1f2937;
      --muted: #6b7280;
      --brand: #0f766e;
      --brand-strong: #115e59;
      --danger: #b91c1c;
      --line: #e5e7eb;
    }
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: radial-gradient(circle at top right, #e6fffa 0%, var(--bg) 45%);
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 10px 20px rgba(2, 6, 23, 0.05);
    }
    .card.compact {
      padding: 12px;
    }
    .card.compact .balance {
      font-size: 28px;
      margin-bottom: 6px;
    }
    .card.compact .meta {
      font-size: 12px;
      margin-bottom: 10px;
    }
    .card.compact .grid {
      gap: 8px;
    }
    .card.compact .item {
      padding: 8px;
    }
    .card.compact .item-value {
      font-size: 14px;
    }
    .card.compact .actions button {
      font-size: 12px;
      padding: 7px 10px;
    }
    h1 {
      margin: 0 0 12px 0;
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.2px;
    }
    .balance {
      font-size: 34px;
      font-weight: 700;
      color: var(--brand-strong);
      margin-bottom: 8px;
    }
    .meta {
      color: var(--muted);
      font-size: 13px;
      margin-bottom: 14px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(140px, 1fr));
      gap: 10px;
      margin: 10px 0 14px 0;
    }
    .item {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
      background: #fafafa;
    }
    .item-label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
    }
    .item-value {
      font-size: 16px;
      font-weight: 650;
      line-height: 1.4;
      word-break: break-word;
    }
    .status {
      font-size: 13px;
      color: var(--muted);
      margin-top: 6px;
    }
    .error {
      margin-top: 8px;
      color: var(--danger);
      font-size: 13px;
      line-height: 1.5;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 14px;
    }
    button {
      border: none;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
      cursor: pointer;
      color: white;
      background: var(--brand);
    }
    button.secondary {
      background: #475569;
    }
    button.warn {
      background: #dc2626;
    }
  </style>
</head>
<body>
  <div class="card ${compactMode ? 'compact' : ''}">
    <h1>Codex 余额监控</h1>
    <div class="balance">${escapeHtml(balance)}</div>
    <div class="meta">上次刷新：${escapeHtml(updatedAt)} | 紧凑模式：${compactModeText}</div>

    <div class="grid">
      <div class="item">
        <div class="item-label">注册时间</div>
        <div class="item-value">${escapeHtml(registeredAt)}</div>
      </div>
      <div class="item">
        <div class="item-label">到期时间</div>
        <div class="item-value">${escapeHtml(expireAt)}</div>
      </div>
      <div class="item">
        <div class="item-label">每日预算</div>
        <div class="item-value">${escapeHtml(dailyBudget)}</div>
      </div>
      <div class="item">
        <div class="item-label">今日已用</div>
        <div class="item-value">${escapeHtml(todaySpent)}</div>
      </div>
      <div class="item">
        <div class="item-label">当前套餐</div>
        <div class="item-value">${escapeHtml(planName)}</div>
      </div>
      ${compactMode ? '' : `
      <div class="item">
        <div class="item-label">今日请求数</div>
        <div class="item-value">${escapeHtml(todayRequests)}</div>
      </div>
      <div class="item">
        <div class="item-label">今日 Tokens</div>
        <div class="item-value">${escapeHtml(todayTokens)}</div>
      </div>
      `}
    </div>

    <div class="status">${statusText}</div>
    ${errorBlock}

    <div class="actions">
      <button id="refreshBtn">刷新余额</button>
      <button id="toggleCompactBtn" class="secondary">切换紧凑模式</button>
      <button id="setTokenBtn" class="secondary">设置 Token</button>
      <button id="clearTokenBtn" class="warn">清除 Token</button>
      <button id="dashboardBtn" class="secondary">打开 Dashboard</button>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    document.getElementById('refreshBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'refresh' }));
    document.getElementById('toggleCompactBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'toggleCompactMode' }));
    document.getElementById('setTokenBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'setToken' }));
    document.getElementById('clearTokenBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'clearToken' }));
    document.getElementById('dashboardBtn')?.addEventListener('click', () => vscode.postMessage({ command: 'openDashboard' }));
  </script>
</body>
</html>`;
    }

    private async setToken(): Promise<void> {
        const input = await vscode.window.showInputBox({
            title: '设置 Codex Token',
            prompt: '请粘贴 codex-for.me 的 authToken（Bearer Token）',
            placeHolder: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
            password: true,
            ignoreFocusOut: true
        });

        if (input === undefined) {
            return;
        }

        const token = normalizeToken(input);
        if (!token) {
            vscode.window.showWarningMessage('Token 为空，未保存。');
            return;
        }

        await this.context.secrets.store(SECRET_TOKEN_KEY, token);
        this.log('Token 已写入 SecretStorage。');
        vscode.window.showInformationMessage('Token 已保存到安全存储。');
        await this.refreshBalance({ silent: false, trigger: 'set-token' });
    }

    private async clearToken(): Promise<void> {
        await this.context.secrets.delete(SECRET_TOKEN_KEY);
        this.lastSummary = undefined;
        this.lastUpdatedAt = undefined;
        this.lastError = '未配置 Token。请运行“Codex 余额: 设置 Token”。';
        this.updateStatusBar();
        await this.renderWebview();
        vscode.window.showInformationMessage('已清除安全存储中的 Token。');
    }

    private async toggleCompactMode(): Promise<void> {
        const current = this.isCompactModeEnabled();
        await this.getConfig().update('compactMode', !current, vscode.ConfigurationTarget.Global);
        const nextText = !current ? '开启' : '关闭';
        vscode.window.setStatusBarMessage(`紧凑模式已${nextText}`, 2000);
        await this.renderWebview();
    }

    private async openDashboard(): Promise<void> {
        const url = this.getDashboardUrl();
        try {
            await vscode.env.openExternal(vscode.Uri.parse(url));
        } catch (error) {
            vscode.window.showErrorMessage(`打开 Dashboard 失败：${toErrorMessage(error)}`);
        }
    }

    private log(message: string): void {
        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
    }
}

function asApiEnvelope(value: unknown): ApiEnvelope {
    if (!value || typeof value !== 'object') {
        return {};
    }
    return value as ApiEnvelope;
}

function normalizeToken(value: string): string {
    return value.replace(/^Bearer\s+/i, '').trim();
}

function toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function formatCurrency(value: unknown): string {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) {
        return `$${numeric.toFixed(2)}`;
    }

    if (typeof value === 'string' && value.trim().length > 0) {
        const normalized = value.startsWith('$') ? value : `$${value}`;
        return normalized;
    }

    return '$0.00';
}

function formatCurrencyOrDash(value: unknown): string {
    if (value === undefined || value === null || value === '') {
        return '--';
    }
    return formatCurrency(value);
}

function getTodayTokenCount(summary: SummaryData): string | number {
    const candidates = [
        'today_token_count',
        'today_tokens',
        'today_total_tokens',
        'today_token_usage',
        'today_tokens_used',
        'today_total_token_count'
    ];

    for (const key of candidates) {
        const value = summary[key];
        if (value !== undefined && value !== null && value !== '') {
            return value as string | number;
        }
    }

    return 0;
}

function formatTokenCount(value: unknown): string {
    const number = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(number)) {
        return number.toLocaleString();
    }

    if (value === undefined || value === null || value === '') {
        return '0';
    }

    return String(value);
}

function safeDateString(raw: string): string {
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        return raw;
    }
    return parsed.toLocaleString();
}

function escapeHtml(input: string): string {
    return input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const extension = new CodexBalanceExtension(context);
    context.subscriptions.push({ dispose: () => extension.dispose() });
    await extension.activate();
}

export function deactivate(): void {
    // no-op
}
