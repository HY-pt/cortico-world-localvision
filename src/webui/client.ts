import type { WebUiClientBundle, WebUiPanel } from 'cortico/web/shared/client-panel.ts';
import './style.css';

interface Row {
  label: string;
  value: string;
}
interface Report {
  text: string;
  sections: Array<{ title: string; rows: Row[] }>;
  tips: string[];
}
interface ModelState {
  enabled: boolean;
  provider: string;
  protocol: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  customPath: string;
  maxTokens: number;
  temperature: number;
  detail: string;
  timeout: number;
  prompt: string;
  resolvedBase: string;
  resolvedProtocol: string;
  kind: 'local' | 'online';
  ready: boolean;
  coopModel: string;
  priority: string;
}
interface ProbeResult {
  local: { ok: boolean; ms: number; configured: boolean; detail: string };
  online: { ok: boolean; ms: number; configured: boolean; detail: string };
}

// 模型设置经面板 invoke('save') → 后端 ctx.persist 直接深合并落盘，
// 不走配置组 schema（模型键已不在配置页 schema 里，setConfig 会被框架静默丢弃）。
const K = 'worlds.localvision';
const PROVIDER_KEYS = [
  'custom', 'openai', 'anthropic', 'gemini', 'deepseek', 'qwen', 'openrouter', 'xai',
  'kimi', 'zhipu', 'minimax', 'doubao', 'qianfan', 'stepfun', 'ollama', 'lmstudio',
];

/** 状态表：本地 / 在线 两行（Coopanion 模型商由下方灰字说明，不占行）。 */
function statusTable(ui: import('cortico/web/shared/client-panel.ts').WebUi, t: (a: string, b: string) => string) {
  const table = ui.table({ head: [t('类型', 'Kind'), t('地址 / 模型商', 'Base URL'), t('模型', 'Model'), t('状态', 'Status')] });
  const cells: Record<string, { base: HTMLElement; model: HTMLElement; status: HTMLElement }> = {};
  const rows: Array<[keyof typeof cells, string]> = [
    ['local', t('本地模型', 'Local')],
    ['online', t('在线模型', 'Online')],
  ];
  for (const [kind, label] of rows) {
    const base = ui.h('span', 'mono', '—');
    const model = ui.h('span', null, '—');
    const status = ui.pill(t('未检测', 'Not tested'), 'plain');
    table.addRow([label, base, model, status]);
    cells[kind] = { base, model, status };
  }
  return { table, cells };
}

/** 「模型」面板：状态表 + 连接参数编辑（懒检测：点「实测」才联网）。 */
const model: WebUiPanel = {
  mount(ctx) {
    const { ui, root } = ctx;
    const zh = ctx.language.startsWith('zh');
    const t = (a: string, b: string) => (zh ? a : b);

    const app = ui.h('div', 'lv-app');
    root.appendChild(app);

    // 卡 1：状态
    const statusCard = ui.sheet({
      title: t('状态', 'Status'),
      desc: t('点「实测端点」检测下方视觉模型端点是否在线。', 'Click Test to check whether the vision endpoints below are online.'),
    });
    app.appendChild(statusCard.el);
    const { table, cells } = statusTable(ui, t);
    const bar = ui.rowbar();
    const ping = ui.button(t('实测端点', 'Test endpoint'), { size: 'sm', variant: 'primary' });
    const msg = ui.msgline('');
    bar.append(ping, msg);
    const coopNote = ui.msgline(t('Coopanion 模型商本身支持视觉模型，无需配置，对话模型直接看图。', 'The Coopanion provider supports vision natively — no config, your chat model sees images directly.'));
    statusCard.body.append(bar, table.el, coopNote);

    // 卡 2：连接与调参（改动即保存）
    const connCard = ui.sheet({
      title: t('连接与调参', 'Connection'),
      en: 'conn',
      desc: t('改动即时保存；「获取可用模型」可自动拉取端点模型清单，不用手敲。', 'Changes save instantly; "Fetch models" pulls the model list so you don\'t type it by hand.'),
    });
    app.appendChild(connCard.el);
    const saveMsg = ui.msgline(t('改动即保存到 config.json。', 'Changes save to config.json.'));
    connCard.body.appendChild(saveMsg);
    const disabledHint = ui.msgline(
      t('视觉模型未启用，下方配置保留但不生效。', 'Vision model is off; settings below are kept but inactive.'),
    );
    disabledHint.classList.add('lv-hint');
    disabledHint.style.display = 'none';

    const save = async (patch: Record<string, unknown>) => {
      saveMsg.textContent = t('保存中…', 'Saving…');
      saveMsg.classList.remove('bad');
      try {
        // persist 的 patch 是 worlds.localvision 段内的扁平键，去掉前缀。
        const flat: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) {
          flat[k.startsWith(`${K}.`) ? k.slice(K.length + 1) : k] = v;
        }
        await ctx.invoke('save', [flat]);
        saveMsg.textContent = t('已保存 ✓', 'Saved ✓');
        await refresh();
      } catch (e) {
        saveMsg.textContent = e instanceof Error ? e.message : String(e);
        saveMsg.classList.add('bad');
      }
    };
    const num = (s: string, fallback: number) => {
      const n = Number(s);
      return Number.isFinite(n) ? n : fallback;
    };

    const enabled = ui.checkbox(t('启用视觉模型', 'Enable vision model'), {
      onChange: (v) => void save({ [`${K}.localModelEnabled`]: v }),
    });
    const provider = ui.select({
      options: PROVIDER_KEYS,
      onChange: (v) => void save({ [`${K}.localModelProvider`]: v }),
    });
    const protocol = ui.select({
      options: ['auto', 'openai-chat', 'anthropic-messages', 'openai-responses', 'custom'],
      onChange: (v) => void save({ [`${K}.localModelProtocol`]: v }),
    });
    const baseUrl = ui.input({ cls: 'mono', onChange: (v) => void save({ [`${K}.localModelBaseUrl`]: v.trim() }) });
    const apiKey = ui.input({ type: 'password', cls: 'mono', onChange: (v) => void save({ [`${K}.localModelApiKey`]: v }) });
    const modelName = ui.input({ cls: 'mono', onChange: (v) => void save({ [`${K}.localModelName`]: v.trim() }) });
    const customPath = ui.input({ cls: 'mono', onChange: (v) => void save({ [`${K}.localModelPath`]: v.trim() }) });
    const maxTokens = ui.input({ type: 'number', onChange: (v) => void save({ [`${K}.localModelMaxTokens`]: num(v, 1000) }) });
    const temperature = ui.input({ type: 'number', onChange: (v) => void save({ [`${K}.localModelTemperature`]: num(v, 0.2) }) });
    const timeout = ui.input({ type: 'number', onChange: (v) => void save({ [`${K}.localModelTimeoutMs`]: num(v, 20000) }) });
    const prompt = ui.input({ onChange: (v) => void save({ [`${K}.localModelPrompt`]: v }) });
    const detail = ui.select({
      options: ['auto', 'low', 'high'],
      onChange: (v) => void save({ [`${K}.localModelDetail`]: v }),
    });
    const priority = ui.select({
      options: [
        { value: 'auto', label: '自动（本地 > 在线 > Coopanion）' },
        { value: 'local', label: '本地' },
        { value: 'online', label: '在线' },
        { value: 'coop', label: 'Coopanion' },
      ],
      onChange: (v) => void save({ [`${K}.localModelPriority`]: v }),
    });

    // 「获取可用模型」：填好地址/密钥后拉一份端点已部署的模型清单，省得手敲拼错。
    const modelMsg = ui.msgline('');
    const fetchModelsBtn = ui.button(t('获取可用模型', 'Fetch models'), { size: 'sm' });
    const modelSelect = ui.select({ options: [] });
    modelSelect.style.display = 'none';
    const modelSelectField = ui.field(t('已部署模型', 'Deployed models'), modelSelect);
    modelSelectField.style.display = 'none';
    modelSelect.addEventListener('change', () => {
      const v = modelSelect.value;
      if (v) {
        modelName.value = v;
        void save({ [`${K}.localModelName`]: v });
      }
    });
    fetchModelsBtn.addEventListener('click', () => {
      fetchModelsBtn.disabled = true;
      modelMsg.textContent = t('获取模型中…', 'Fetching models…');
      modelMsg.classList.remove('bad');
      void (async () => {
        const r = await ctx.invoke<{ ok: boolean; models: string[]; detail: string }>('models');
        if (r.ok && r.models.length) {
          modelSelect.innerHTML = '';
          for (const m of r.models) {
            const opt = document.createElement('option');
            opt.value = m;
            opt.textContent = m;
            modelSelect.appendChild(opt);
          }
          modelSelect.style.display = '';
          modelSelectField.style.display = '';
          modelSelect.value = modelName.value || r.models[0];
          modelMsg.textContent = `${t('已获取', 'Fetched')} ${r.models.length} ${t('个模型，选一个即填入模型名', 'models; pick one to fill')}`;
        } else {
          modelMsg.textContent = `${t('获取失败', 'Failed')}: ${r.detail}`;
          modelMsg.classList.add('bad');
        }
      })().catch((e) => {
        modelMsg.textContent = e instanceof Error ? e.message : String(e);
        modelMsg.classList.add('bad');
      }).finally(() => { fetchModelsBtn.disabled = false; });
    });
    const modelFetchBar = ui.rowbar();
    modelFetchBar.append(fetchModelsBtn, modelMsg);

    // 顶层：启用开关 → 优先选择的模型（关掉后仍可改，coop 不依赖端点）→ 折叠区。
    connCard.body.append(
      enabled.el,
      ui.field(t('优先选择的模型（看图）', 'Preferred model'), priority),
      disabledHint,
    );

    // 分区：端点与模型（勾选时展开）/ 高级调参（折叠）——未勾选时整体灰掉并收起。
    const secBase = ui.foldSheet('lv-conn-base', {
      title: t('端点与模型', 'Endpoint & model'),
      desc: t('选择本地或在线端点，填好地址与模型名。', 'Pick a local or online endpoint, fill the URL and model name.'),
      defaultOpen: true,
    });
    connCard.body.appendChild(secBase.el);
    secBase.body.append(
      ui.field(t('厂商预设', 'Provider'), provider),
      ui.field(t('协议', 'Protocol'), protocol),
      ui.field(t('地址', 'Base URL'), baseUrl),
      ui.field(t('API Key', 'API key'), apiKey),
      ui.field(t('模型名', 'Model name'), modelName),
      modelFetchBar,
      modelSelectField,
    );

    const secAdv = ui.foldSheet('lv-conn-adv', {
      title: t('高级调参', 'Tuning'),
      desc: t('自定义路径、maxTokens、temperature、图片精度。', 'Custom path, maxTokens, temperature, image detail.'),
      defaultOpen: false,
    });
    connCard.body.appendChild(secAdv.el);
    secAdv.body.append(
      ui.field(t('自定义路径', 'Custom path'), customPath),
      ui.field(t('maxTokens', 'maxTokens'), maxTokens),
      ui.field(t('temperature', 'temperature'), temperature),
      ui.field(t('超时（ms）', 'Timeout (ms)'), timeout),
      ui.field(t('附加指令', 'Extra prompt'), prompt),
      ui.field(t('图片精度', 'Image detail'), detail),
    );

    /** 关掉视觉模型：端点/调参折叠收起并灰掉（配置保留，只是不生效）；优先级保持可改。 */
    const applyEnabledUi = (on: boolean) => {
      const base = secBase.el as HTMLDetailsElement;
      const adv = secAdv.el as HTMLDetailsElement;
      base.classList.toggle('lv-off', !on);
      adv.classList.toggle('lv-off', !on);
      disabledHint.style.display = on ? 'none' : '';
      if (!on) {
        base.open = false;
        adv.open = false;
      } else {
        base.open = true;
      }
    };

    /** 用 state 刷新状态表与输入框；正在编辑的输入框不覆盖。 */
    const applyState = (s: ModelState) => {
      const local = s.kind === 'local';
      cells.local.base.textContent = local ? s.resolvedBase || '—' : '—';
      cells.local.model.textContent = local ? s.model || '—' : '—';
      cells.online.base.textContent = !local ? s.resolvedBase || '—' : '—';
      cells.online.model.textContent = !local ? s.model || '—' : '—';
      for (const kind of ['local', 'online'] as const) {
        if (s.kind !== kind) cells[kind].status.textContent = t('未配置', 'Not set');
        else if (cells[kind].status.dataset.probed !== '1') cells[kind].status.textContent = s.enabled ? t('未检测', 'Not tested') : t('未启用', 'Disabled');
      }
      const setIfIdle = (el: HTMLInputElement, v: string | number) => {
        if (document.activeElement !== el) el.value = String(v);
      };
      enabled.setChecked(s.enabled);
      provider.value = s.provider;
      protocol.value = s.protocol;
      setIfIdle(baseUrl, s.baseUrl);
      setIfIdle(apiKey, s.apiKey);
      setIfIdle(modelName, s.model);
      setIfIdle(customPath, s.customPath);
      setIfIdle(maxTokens, s.maxTokens);
      setIfIdle(temperature, s.temperature);
      setIfIdle(timeout, s.timeout);
      setIfIdle(prompt, s.prompt);
      detail.value = s.detail;
      priority.value = s.priority || 'auto';
      applyEnabledUi(s.enabled);
    };

    const refresh = async () => {
      try {
        applyState(await ctx.invoke<ModelState>('state'));
      } catch (e) {
        msg.textContent = e instanceof Error ? e.message : String(e);
        msg.classList.add('bad');
      }
    };

    ping.addEventListener('click', () => {
      ping.disabled = true;
      msg.textContent = t('实测中…（视觉模型端点）', 'Testing…');
      msg.classList.remove('bad');
      void (async () => {
        const r = await ctx.invoke<ProbeResult>('probe');
        const parts: string[] = [];
        for (const kind of ['local', 'online'] as const) {
          const v = r[kind];
          const pill = cells[kind].status;
          pill.dataset.probed = '1';
          if (!v.configured) {
            pill.textContent = t('未配置', 'Not set');
            pill.className = 'pill';
          } else {
            pill.textContent = v.ok ? `${t('在线', 'Online')} ${v.ms}ms` : t('失败', 'Failed');
            pill.className = `pill ${v.ok ? 'on' : 'off'}`;
          }
          parts.push(`${kind === 'local' ? t('本地模型', 'Local') : t('在线模型', 'Online')}：${v.detail}`);
        }
        msg.textContent = parts.join('　|　');
        const anyBad = (r.local.configured && !r.local.ok) || (r.online.configured && !r.online.ok);
        msg.classList.toggle('bad', anyBad);
      })()
        .catch((e) => {
          msg.textContent = e instanceof Error ? e.message : String(e);
          msg.classList.add('bad');
        })
        .finally(() => {
          ping.disabled = false;
        });
    });

    void refresh();
  },
};

/** 上次诊断报告：存 localStorage，跨页签/刷新保留，直到下次检测覆盖。 */
const REPORT_KEY = 'localvision:lastReport';

/** 「诊断」面板：懒加载——点「运行诊断」才采集；上次结果保留到下次检测覆盖。 */
const diagnostics: WebUiPanel = {
  mount(ctx) {
    const { ui, root } = ctx;
    const zh = ctx.language.startsWith('zh');
    const t = (a: string, b: string) => (zh ? a : b);

    const app = ui.h('div', 'lv-app');
    root.appendChild(app);

    const card = ui.sheet({
      title: t('诊断', 'Diagnostics'),
      desc: t('点「运行诊断」检测屏幕、OCR 与硬拦截，结果保留到下次检测；「打核心补丁」给宿主打硬拦截钩子（幂等，打完重启生效）。', 'Click Run to check screen, OCR and interception; results stay until the next run. "Patch core" installs the interception hook (idempotent, needs a restart).'),
    });
    app.appendChild(card.el);
    const bar = ui.rowbar();
    const run = ui.button(t('运行诊断', 'Run'), { size: 'sm', variant: 'primary' });
    const patch = ui.button(t('打核心补丁', 'Patch core'), { size: 'sm' });
    const copy = ui.copyButton(() => lastText);
    const msg = ui.msgline(t('尚未检测。', 'Not run yet.'));
    bar.append(run, patch, copy, msg);
    const body = ui.h('div', 'lv-body');
    card.body.append(bar, body);

    let lastText = '';
    const rowsInto = (parent: HTMLElement, rows: Row[]) => {
      for (const row of rows ?? []) {
        const line = ui.h('div', 'lv-row');
        line.append(ui.h('span', 'lv-label', row.label), ui.h('span', 'lv-value', row.value));
        parent.appendChild(line);
      }
    };
    const renderReport = (r: Report) => {
      body.textContent = '';
      for (const section of r.sections ?? []) {
        body.appendChild(ui.section(section.title));
        rowsInto(body, section.rows);
      }
      for (const tip of r.tips ?? []) body.appendChild(ui.h('div', 'lv-tip', `建议：${tip}`));
      const det = ui.h('details', 'lv-raw');
      const pre = ui.h('pre', 'lv-doctor');
      pre.textContent = r.text ?? '';
      det.append(ui.h('summary', null, t('原始报告', 'Raw report')), pre);
      body.appendChild(det);
    };

    // 恢复上次检测结果（有记录就不显示占位）。
    try {
      const saved = localStorage.getItem(REPORT_KEY);
      if (saved) {
        const r = JSON.parse(saved) as Report;
        lastText = r.text ?? '';
        renderReport(r);
        msg.textContent = t('显示上次检测结果。', 'Showing the last run.');
      }
    } catch {
      /* 记录损坏则忽略 */
    }
    if (!body.childNodes.length) {
      body.appendChild(ui.placeholder(t('点击「运行诊断」开始检测。', 'Click Run to start.')));
    }

    // 「打核心补丁」：给宿主打工具回执 hook（幂等、自动备份），打完需重启进程。
    patch.addEventListener('click', () => {
      patch.disabled = true;
      msg.textContent = t('打补丁中…', 'Patching…');
      msg.classList.remove('bad');
      void (async () => {
        const r = await ctx.invoke<{ ok: boolean; patched: boolean; detail: string; output: string }>('patch');
        msg.textContent = r.detail;
        msg.classList.toggle('bad', !r.ok);
      })()
        .catch((e) => {
          msg.textContent = e instanceof Error ? e.message : String(e);
          msg.classList.add('bad');
        })
        .finally(() => {
          patch.disabled = false;
        });
    });

    run.addEventListener('click', () => {
      run.disabled = true;
      msg.textContent = t('检测中…（含一次截屏）', 'Running…');
      msg.classList.remove('bad');
      void (async () => {
        const r = await ctx.invoke<Report>('report', [false]);
        lastText = r.text ?? '';
        renderReport(r);
        try {
          localStorage.setItem(REPORT_KEY, JSON.stringify(r));
        } catch {
          /* 存不下也不影响本次显示 */
        }
        msg.textContent = t('检测完成。', 'Done.');
      })()
        .catch((e) => {
          msg.textContent = e instanceof Error ? e.message : String(e);
          msg.classList.add('bad');
        })
        .finally(() => {
          run.disabled = false;
        });
    });
  },
};

const bundle: WebUiClientBundle = { panels: { model, diagnostics } };
export default bundle;
