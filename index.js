import { eventSource, event_types, main_api, isGenerating, saveSettingsDebounced, withConnectionValidationSuspended } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';
import * as openai from '/scripts/openai.js';
import { getPresetManager } from '/scripts/preset-manager.js';
import { CONNECT_API_MAP, connectCurrentApi } from '/scripts/slash-commands.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { resolveSecretKey, secret_state, SECRET_KEYS } from '/scripts/secrets.js';

const ROOT_ID = 'tt-independent-switcher';
const oai_settings = openai.oai_settings;
let busy = false;

function family(api) {
    return api === 'koboldhorde' ? 'kobold' : api;
}

export function getConnections() {
    const manager = extension_settings.connectionManager;
    return [
        ...(manager?.profiles ?? []).map(item => ({ key: `profile:${item.id}`, label: item.name, item, modelOnly: false })),
        ...(manager?.modelTargets ?? []).map(item => ({ key: `model:${item.id}`, label: `${item.name} · 模型配置`, item, modelOnly: true })),
    ];
}

function getCurrentModel() {
    return String(SlashCommandParser.commands.model?.callback({ quiet: 'true' }, '') ?? '');
}

function getModels() {
    const entries = SlashCommandParser.commands.model?.unnamedArgumentList?.[0]?.enumProvider?.() ?? [];
    return entries.filter(entry => entry.value).map(entry => ({
        key: String(entry.value),
        label: entry.description ? `${entry.description} · ${entry.value}` : String(entry.value),
    }));
}

async function command(name, value = '', args = {}) {
    const handler = SlashCommandParser.commands[name]?.callback;
    if (!handler) throw new Error(`缺少酒馆命令 /${name}，请确认使用 TauriTavern 2.4.0。`);
    // Call the same callbacks as Connection Manager; never interpolate names into STScript.
    const result = await handler({ quiet: 'true', ...args }, value);
    return String(result ?? '');
}

async function setCommand(name, value, args) {
    if (await command(name, value, args) !== String(value)) {
        throw new Error(`未能准确应用 /${name}。已停止切换，请检查原连接配置；部分连接字段可能已改变。`);
    }
}

async function runSwitch(action) {
    if (busy) throw new Error('正在切换，请等待完成。');
    if (isGenerating()) throw new Error('请先停止生成，再切换 API 或预设。');
    busy = true;
    try {
        if (openai.getPresetApplicationPromise) await openai.getPresetApplicationPromise();
        return await withConnectionValidationSuspended('Independent API/preset switch', action);
    } finally {
        busy = false;
        saveSettingsDebounced();
    }
}

export async function switchApi(key) {
    return runSwitch(async () => {
        const entry = getConnections().find(entry => entry.key === key);
        if (!entry) throw new Error('连接配置已被删除，请刷新列表。');
        const { item, modelOnly } = entry;
        const targetFamily = CONNECT_API_MAP[item.api]?.selected;
        if (!targetFamily) throw new Error('这个配置没有有效的 API 类型，请在原连接管理器中重新保存。');
        if (family(targetFamily) !== family(main_api)) {
            throw new Error('此配置属于另一种补全类型，无法沿用当前预设。请先在原 API 面板切换补全类型。');
        }
        const excluded = modelOnly ? [] : (item.exclude ?? []);
        if (excluded.includes('api')) throw new Error('这个配置排除了 API 类型，无法独立应用。');
        const fields = {};
        for (const name of ['api', 'custom-api-format', 'api-url', 'proxy', 'model', 'secret-id']) {
            if (!excluded.includes(name) && item[name]) fields[name] = String(item[name]);
        }
        const secret = modelOnly ? item.secretRef : null;
        const secretId = secret?.id || fields['secret-id'];
        // Validate exact references before changing an endpoint; never select a fuzzy credential match.
        if (secretId && !Object.values(secret_state).some(list => Array.isArray(list) && list.some(s => s.id === secretId))) {
            throw new Error('此配置引用的密钥已不存在，请在原连接管理器中重新选择并保存。');
        }
        const proxy = fields.proxy || (modelOnly && targetFamily === 'openai' ? 'None' : '');
        if (proxy && !Array.from(document.querySelector('#openai_proxy_preset')?.options ?? []).some(o => o.value === proxy)) {
            throw new Error('此配置引用的反代预设已不存在，请重新保存原连接配置。');
        }

        // Native model/source handlers can clamp sampling values. Keep unsaved prompt settings too.
        if (main_api === 'openai' && !openai.settingsToUpdate) {
            throw new Error('此版本缺少预设字段映射，无法安全保留采样和提示词设置。');
        }
        const promptValues = main_api === 'openai'
            ? Object.entries(openai.settingsToUpdate).filter(([, spec]) => !spec[3])
                .map(([, spec]) => [spec, structuredClone(oai_settings[spec[1]])])
            : [];
        try {
            await setCommand('api', fields.api);
            if (secret?.key && fields.api === 'vertexai') {
                $('#vertexai_auth_mode').val(secret.key === SECRET_KEYS.VERTEXAI_SERVICE_ACCOUNT ? 'full' : 'express').trigger('change');
            }
            if (fields['custom-api-format']) {
                await setCommand('custom-api-format', fields['custom-api-format']);
            } else if (modelOnly && fields.api === 'custom') {
                await setCommand('custom-api-format', 'openai_compat');
            }
            if (fields['api-url']) {
                await setCommand('api-url', fields['api-url'], { connect: 'false' });
            } else if (modelOnly) {
                await command('api-url', '', { connect: 'false', clear: 'true' });
            }
            if (secretId) {
                const secretKey = secret?.key || resolveSecretKey();
                if (!secret_state[secretKey]?.some(s => s.id === secretId)) {
                    throw new Error('密钥与目标 API 不匹配，已停止切换；请检查原连接配置。');
                }
                await setCommand('secret-id', secretId, { key: secretKey });
            }
            if (proxy) await setCommand('proxy', proxy);
            if (fields.model) await setCommand('model', fields.model);
            if (modelOnly && main_api === 'openai') {
                oai_settings.custom_claude_prompt_caching = item.adapterHints?.claudePromptCaching === 'enabled';
                oai_settings.custom_openai_responses_websocket = item.adapterHints?.openaiResponsesMode === 'websocket';
                $('#custom_claude_prompt_caching').prop('checked', oai_settings.custom_claude_prompt_caching);
                $('#custom_openai_responses_websocket').prop('checked', oai_settings.custom_openai_responses_websocket);
            }
        } finally {
            for (const [[selector, setting, checkbox], value] of promptValues) {
                if (JSON.stringify(oai_settings[setting]) === JSON.stringify(value)) continue;
                oai_settings[setting] = value;
                if (selector) {
                    const control = $(selector);
                    if (checkbox) control.prop('checked', value);
                    else control.val(value);
                    control.trigger('input');
                }
            }
        }
        // No /profile replay and no saved-profile mutation: preset/regex/format bindings stay untouched.
        return entry.label;
    }).then(label => {
        connectCurrentApi();
        return label;
    });
}

export async function switchPreset(name) {
    return runSwitch(async () => {
        const manager = getPresetManager();
        if (!manager || !manager.getAllPresets().includes(name)) throw new Error('预设已不存在，请刷新列表。');
        if (!event_types.PRESET_CHANGED) throw new Error('此版本缺少预设完成事件，无法安全切换。');
        const previousBinding = oai_settings.bind_preset_to_connection;
        let finish;
        let timer;
        const applied = new Promise(resolve => {
            const listener = ({ apiId, name: appliedName } = {}) => {
                if (family(apiId) === family(main_api) && appliedName === name) resolve();
            };
            eventSource.on(event_types.PRESET_CHANGED, listener);
            finish = () => {
                clearTimeout(timer);
                eventSource.removeListener(event_types.PRESET_CHANGED, listener);
            };
        });
        try {
            // v2.4.0's preset loader skips every is_connection field when this flag is false.
            oai_settings.bind_preset_to_connection = false;
            await manager.selectPreset(manager.findPreset(name));
            await Promise.race([applied, new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('等待预设加载超时，请检查原预设面板。')), 15000);
            })]);
            if (manager.getSelectedPresetName() !== name) throw new Error('预设未成功应用，请刷新后重试。');
        } finally {
            finish();
            oai_settings.bind_preset_to_connection = previousBinding;
        }
        return name;
    });
}

export async function switchModel(model) {
    return runSwitch(async () => {
        if (!getModels().some(entry => entry.key === model)) {
            throw new Error('模型已不在当前 API 的列表中，请刷新后重新选择。');
        }
        if (await command('model', model) !== model || getCurrentModel() !== model) {
            throw new Error('模型未成功应用，请检查原 API 面板。');
        }
        return model;
    });
}

function fillSelect(select, entries, preferred) {
    select.replaceChildren(new Option('请选择…', ''));
    for (const entry of entries) {
        const option = new Option(entry.label, entry.key);
        option.disabled = Boolean(entry.disabled);
        select.append(option);
    }
    if (entries.some(entry => entry.key === preferred && !entry.disabled)) select.value = preferred;
}

function refresh() {
    const root = document.getElementById(ROOT_ID);
    if (!root || busy) return;
    const apiSelect = root.querySelector('[data-api]');
    const presets = getPresetManager();
    const entries = getConnections().map(entry => {
        const incompatible = family(CONNECT_API_MAP[entry.item.api]?.selected) !== family(main_api);
        return { ...entry, disabled: incompatible, label: entry.label + (incompatible ? '（补全类型不同）' : '') };
    });
    fillSelect(apiSelect, entries, apiSelect.value);
    fillSelect(root.querySelector('[data-preset]'), (presets?.getAllPresets() ?? []).map(name => ({ key: name, label: name })), presets?.getSelectedPresetName());
    const currentModel = getCurrentModel();
    const models = getModels();
    fillSelect(root.querySelector('[data-model]'), models, currentModel);
    root.querySelector('[data-current]').textContent = `当前预设：${presets?.getSelectedPresetName() || '无'} · API：${main_api === 'openai' ? oai_settings.chat_completion_source : main_api}`;
    root.querySelector('[data-current-model]').textContent = `当前模型：${currentModel || '未选择'}`;
    root.querySelector('[data-empty]').textContent = entries.length ? '' : '没有已保存的连接配置。请先在原 API 面板保存连接配置，再点刷新。';
    root.querySelector('[data-model-empty]').textContent = models.length ? '' : '当前 API 尚无可选模型。请先在原 API 面板加载模型，再点刷新。';
    root.querySelector('[data-apply-api]').disabled = !apiSelect.value;
    root.querySelector('[data-apply-preset]').disabled = !root.querySelector('[data-preset]').value;
    root.querySelector('[data-apply-model]').disabled = !root.querySelector('[data-model]').value || root.querySelector('[data-model]').value === currentModel;
}

export function init() {
    if (document.getElementById(ROOT_ID)) return;
    const container = document.getElementById('extensions_settings');
    if (!container) throw new Error('未找到扩展设置页。');
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
      <details open>
        <summary><b>API / 预设 / 模型独立切换</b></summary>
        <p class="ttis-note">分别应用连接、预设和模型，已有配置无需重新录入。</p>
        <p data-current class="ttis-current"></p>
        <p data-current-model class="ttis-current"></p>
        <fieldset>
          <label for="ttis-api">已有 API 配置</label>
          <select id="ttis-api" data-api class="text_pole"></select>
          <button type="button" data-apply-api class="menu_button">仅切换 API</button>
          <p class="ttis-note">应用 API、地址、模型、反代和密钥引用，保留当前预设及未保存的提示词设置。</p>
          <label for="ttis-model">当前 API 的模型</label>
          <select id="ttis-model" data-model class="text_pole"></select>
          <button type="button" data-apply-model class="menu_button">仅切换模型</button>
          <p data-model-empty class="ttis-note"></p>
          <p class="ttis-note">模型列表来自原 API 面板；切换模型不会重新应用连接配置或预设。</p>
          <label for="ttis-preset">已有预设</label>
          <select id="ttis-preset" data-preset class="text_pole"></select>
          <button type="button" data-apply-preset class="menu_button">仅切换预设</button>
          <p class="ttis-note">应用提示词和采样参数，保留当前连接。预设绑定的正则、脚本等仍按酒馆原行为加载。</p>
          <button type="button" data-refresh class="menu_button">刷新 API、模型和预设</button>
        </fieldset>
        <p data-empty class="ttis-note"></p>
        <p data-status role="status" aria-live="polite"></p>
        <p class="ttis-note">独立切换仅在此面板生效；原连接管理器仍按原规则加载整套配置。</p>
      </details>`;
    container.append(root);
    root.querySelector('[data-refresh]').addEventListener('click', refresh);
    root.querySelector('[data-api]').addEventListener('change', () => {
        root.querySelector('[data-apply-api]').disabled = !root.querySelector('[data-api]').value;
    });
    root.querySelector('[data-preset]').addEventListener('change', () => {
        root.querySelector('[data-apply-preset]').disabled = !root.querySelector('[data-preset]').value;
    });
    root.querySelector('[data-model]').addEventListener('change', () => {
        root.querySelector('[data-apply-model]').disabled = !root.querySelector('[data-model]').value || root.querySelector('[data-model]').value === getCurrentModel();
    });
    const apply = async (kind) => {
        const status = root.querySelector('[data-status]');
        const fieldset = root.querySelector('fieldset');
        fieldset.disabled = true;
        status.textContent = '正在应用…';
        try {
            const value = root.querySelector(`[data-${kind}]`).value;
            const label = await (kind === 'api' ? switchApi(value) : kind === 'preset' ? switchPreset(value) : switchModel(value));
            status.textContent = kind === 'api' ? `已应用 ${label}，预设已保留；连接结果请查看原 API 面板。` : kind === 'preset' ? `已应用预设 ${label}，连接已保留。` : `已切换到模型 ${label}，API 和预设已保留。`;
        } catch (error) {
            status.textContent = error.message || '切换失败，请检查原 API 面板。';
        } finally {
            fieldset.disabled = false;
            refresh();
        }
    };
    root.querySelector('[data-apply-api]').addEventListener('click', () => apply('api'));
    root.querySelector('[data-apply-preset]').addEventListener('click', () => apply('preset'));
    root.querySelector('[data-apply-model]').addEventListener('click', () => apply('model'));
    root.querySelector('details').addEventListener('toggle', refresh);
    for (const event of ['CONNECTION_PROFILE_CREATED', 'CONNECTION_PROFILE_UPDATED', 'CONNECTION_PROFILE_DELETED', 'MODEL_TARGET_CREATED', 'MODEL_TARGET_UPDATED', 'MODEL_TARGET_DELETED', 'PRESET_CHANGED', 'MAIN_API_CHANGED', 'CHATCOMPLETION_MODEL_CHANGED', 'ONLINE_STATUS_CHANGED']) {
        if (event_types[event]) eventSource.on(event_types[event], refresh);
    }
    const modelObserver = new MutationObserver(refresh);
    for (const control of document.querySelectorAll('select[id*="model"], datalist[id*="model"]')) {
        if (!root.contains(control)) modelObserver.observe(control, { childList: true, subtree: true, attributes: true, characterData: true });
    }
    refresh();
}
