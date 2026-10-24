import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { Window } from 'happy-dom';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

async function fixture(options = {}) {
    const window = new Window();
    const document = window.document;
    document.body.innerHTML = '<div id="extensions_settings"></div><select id="openai_proxy_preset"><option>None</option><option>Proxy B</option></select><select id="settings_preset_openai"><option value="0">Original</option><option value="1">New preset</option></select><input id="temp_openai">';
    const state = {
        generating: false, connects: 0, saves: 0, suspended: false, calls: [],
        api: 'custom', url: 'https://old.example/v1', model: 'old-model', secret: 'old-id', proxy: 'None',
        selectedPreset: 'Original', fail: null, pause: null,
    };
    const settings = {
        chat_completion_source: 'custom', custom_url: state.url, custom_model: state.model,
        bind_preset_to_connection: true, temp_openai: 0.73, preset_settings_openai: 'Original',
        extensions: { unsaved: true }, prompts: [{ content: 'unsaved prompt' }],
    };
    const mapping = {
        temperature: ['#temp_openai', 'temp_openai', false, false],
        extensions: ['', 'extensions', false, false],
        custom_url: ['', 'custom_url', false, true],
        custom_model: ['', 'custom_model', false, true],
    };
    const profile = {
        id: 'p1', name: 'API B', mode: 'cc', api: 'custom', 'api-url': 'https://new.example/v1',
        'custom-api-format': 'claude_messages', model: 'new-model', 'secret-id': 'new-id',
        proxy: 'Proxy B', preset: 'Bundled preset', 'regex-preset': 'unwanted-regex', 'start-reply-with': 'unwanted-prefill',
    };
    const extensionSettings = { connectionManager: { profiles: [profile], modelTargets: [] } };
    const events = {};
    const eventSource = {
        on: (event, fn) => { (events[event] ??= []).push(fn); },
        removeListener: (event, fn) => { events[event] = (events[event] ?? []).filter(listener => listener !== fn); },
        emit: async (event, ...args) => { for (const fn of events[event] ?? []) await fn(...args); },
    };
    const $ = (selector) => {
        const elements = typeof selector === 'string' ? [...document.querySelectorAll(selector || ':not(*)')] : [selector];
        const facade = {
            val(value) { if (arguments.length === 0) return elements[0]?.value; elements.forEach(el => { el.value = value; }); return facade; },
            prop(key, value) { elements.forEach(el => { el[key] = value; }); return facade; },
            trigger() { return facade; },
            empty() { elements.forEach(el => el.replaceChildren()); return facade; },
            find(selector) { return $(selector === ':selected' ? elements[0]?.selectedOptions[0] : elements[0]?.querySelector(selector)); },
            text() { return elements[0]?.textContent ?? ''; },
        };
        return facade;
    };
    const commands = Object.fromEntries(['api', 'api-url', 'model', 'proxy', 'secret-id', 'custom-api-format'].map(name => [name, { callback: async (args, value) => {
        state.calls.push({ name, value, args, suspended: state.suspended });
        if (state.pause && name === 'api') await state.pause;
        if (state.fail === name) return '';
        if (name === 'api') { state.api = value; settings.temp_openai = 0.1; }
        if (name === 'api-url') { state.url = value; settings.custom_url = value; }
        if (name === 'model') { state.model = value; settings.custom_model = value; }
        if (name === 'proxy') state.proxy = value;
        if (name === 'secret-id') state.secret = value;
        return value;
    } }]));
    const modelChoices = ['old-model', 'new-model'];
    commands.model = {
        callback: (args, value) => {
            if (!value) return state.model;
            state.calls.push({ name: 'model', value, args, suspended: state.suspended });
            state.model = value;
            return value;
        },
        unnamedArgumentList: [{ enumProvider: () => modelChoices.map(value => ({ value, description: null })) }],
    };
    let pendingPreset = Promise.resolve();
    const manager = {
        getAllPresets: () => ['Original', 'New preset'],
        findPreset: name => String(['Original', 'New preset'].indexOf(name)),
        getSelectedPresetName: () => state.selectedPreset,
        selectPreset: async value => {
            if (options.failPreset) throw new Error('preset loader failed');
            const apply = async () => {
                await Promise.resolve();
                if (settings.bind_preset_to_connection) {
                    settings.custom_url = 'https://wrong.example';
                    settings.custom_model = 'wrong-model';
                }
                settings.temp_openai = 0.9;
                state.selectedPreset = ['Original', 'New preset'][value];
                await eventSource.emit('preset', { apiId: 'openai', name: state.selectedPreset });
            };
            if (options.delayedPreset) { setImmediate(() => void apply()); return; }
            await apply();
        },
    };
    // Happy DOM does not expose the browser's Option convenience constructor.
    function Option(text, value) {
        const option = document.createElement('option');
        option.textContent = text;
        option.value = value;
        return option;
    }
    const context = vm.createContext({ document, Option, structuredClone, $, console, setTimeout, clearTimeout });
    const modules = {
        '/script.js': { eventSource, event_types: { PRESET_CHANGED: 'preset' }, main_api: options.mainApi ?? 'openai',
            isGenerating: () => state.generating, saveSettingsDebounced: () => state.saves++,
            withConnectionValidationSuspended: async (_, fn) => { state.suspended = true; try { return await fn(); } finally { state.suspended = false; } } },
        '/scripts/extensions.js': { extension_settings: extensionSettings },
        '/scripts/openai.js': { oai_settings: settings, ...(!options.missingMapping && { settingsToUpdate: mapping }),
            ...(!options.missingPresetPromise && { getPresetApplicationPromise: () => pendingPreset }) },
        '/scripts/preset-manager.js': { getPresetManager: () => manager },
        '/scripts/slash-commands.js': { CONNECT_API_MAP: { custom: { selected: 'openai' }, kobold: { selected: 'kobold' } }, connectCurrentApi: () => { assert.equal(state.suspended, false); state.connects++; } },
        '/scripts/slash-commands/SlashCommandParser.js': { SlashCommandParser: { commands } },
        '/scripts/secrets.js': { resolveSecretKey: () => 'custom-key', secret_state: { 'custom-key': [{ id: 'old-id' }, { id: 'new-id' }] }, SECRET_KEYS: { VERTEXAI_SERVICE_ACCOUNT: 'vertex-service' } },
    };
    const module = new vm.SourceTextModule(source, { context });
    await module.link(specifier => {
        const exports = modules[specifier];
        assert.ok(exports, `Unexpected dependency ${specifier}`);
        return new vm.SyntheticModule(Object.keys(exports), function () {
            for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
        }, { context });
    });
    await module.evaluate();
    return { ...module.namespace, window, document, state, settings, mapping, profile, extensionSettings, manager, commands, modelChoices, eventSource, $, setPending: promise => { pendingPreset = promise; } };
}

test('API switch preserves preset, unsaved prompts, sampling and saved profiles; reconnects only after all fields', async () => {
    const f = await fixture();
    const before = structuredClone(f.extensionSettings);
    await f.switchApi('profile:p1');
    assert.equal(f.state.selectedPreset, 'Original');
    assert.equal(f.settings.temp_openai, 0.73);
    assert.deepEqual(f.settings.prompts, [{ content: 'unsaved prompt' }]);
    assert.equal(f.state.url, 'https://new.example/v1');
    assert.equal(f.state.model, 'new-model');
    assert.equal(f.state.secret, 'new-id');
    assert.deepEqual(f.extensionSettings, before);
    assert.ok(f.state.calls.every(call => call.suspended));
    assert.ok(f.state.calls.every(call => !['preset', 'regex-preset', 'start-reply-with'].includes(call.name)));
    assert.equal(f.state.connects, 1);
});

test('loads when Android openai.js omits getPresetApplicationPromise', async () => {
    const f = await fixture({ missingPresetPromise: true });
    f.init();
    assert.ok(f.document.getElementById('tt-independent-switcher'));
    await f.switchPreset('New preset');
    assert.equal(f.settings.custom_url, 'https://old.example/v1');
});

test('keeps connection unbound until an asynchronous native preset finishes', async () => {
    const f = await fixture({ missingPresetPromise: true, delayedPreset: true });
    await f.switchPreset('New preset');
    assert.equal(f.settings.custom_url, 'https://old.example/v1');
    assert.equal(f.settings.bind_preset_to_connection, true);
});

test('missing prompt mapping blocks API changes before touching the connection', async () => {
    const f = await fixture({ missingPresetPromise: true, missingMapping: true });
    f.init();
    await assert.rejects(f.switchApi('profile:p1'), /缺少预设字段映射/);
    assert.equal(f.state.calls.length, 0);
    await f.switchPreset('New preset');
    assert.equal(f.settings.custom_url, 'https://old.example/v1');
});

test('preset switch preserves connection and restores both original binding states', async () => {
    for (const binding of [true, false]) {
        const f = await fixture();
        f.settings.bind_preset_to_connection = binding;
        await f.switchPreset('New preset');
        assert.equal(f.state.selectedPreset, 'New preset');
        assert.equal(f.settings.temp_openai, 0.9);
        assert.equal(f.settings.custom_url, 'https://old.example/v1');
        assert.equal(f.settings.custom_model, 'old-model');
        assert.equal(f.state.secret, 'old-id');
        assert.equal(f.settings.bind_preset_to_connection, binding);
    }
});

test('reads current API models and switches only the model', async () => {
    const f = await fixture({ missingPresetPromise: true });
    const saved = structuredClone(f.extensionSettings);
    f.init();
    assert.match(f.document.querySelector('[data-current-model]').textContent, /old-model/);
    assert.deepEqual([...f.document.querySelectorAll('[data-model] option')].map(option => option.value), ['', 'old-model', 'new-model']);
    await f.switchModel('new-model');
    assert.equal(f.state.model, 'new-model');
    assert.equal(f.state.selectedPreset, 'Original');
    assert.equal(f.state.api, 'custom');
    assert.equal(f.state.url, 'https://old.example/v1');
    assert.equal(f.state.secret, 'old-id');
    assert.deepEqual(f.extensionSettings, saved);
    assert.deepEqual(f.state.calls.map(call => call.name), ['model']);
    assert.ok(f.state.calls[0].suspended);
});

test('model list refreshes and rejects a model not offered by the current API', async () => {
    const f = await fixture();
    f.init();
    f.modelChoices.splice(1, 1, 'fresh-model');
    f.document.querySelector('[data-refresh]').click();
    assert.ok(f.document.querySelector('[data-model] option[value="fresh-model"]'));
    await assert.rejects(f.switchModel('new-model'), /不在当前 API 的列表中/);
    assert.equal(f.state.model, 'old-model');
    assert.equal(f.state.calls.length, 0);
});

test('model button updates the displayed current model', async () => {
    const f = await fixture();
    f.init();
    const select = f.document.querySelector('[data-model]');
    select.value = 'new-model';
    select.dispatchEvent(new f.window.Event('change'));
    assert.equal(f.document.querySelector('[data-apply-model]').disabled, false);
    f.document.querySelector('[data-apply-model]').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(f.document.querySelector('[data-current-model]').textContent, /new-model/);
    assert.match(f.document.querySelector('[data-status]').textContent, /API 和预设已保留/);
    assert.equal(f.document.querySelector('[data-apply-model]').disabled, true);
});

test('failed preset load restores binding and releases busy state', async () => {
    const f = await fixture({ failPreset: true });
    await assert.rejects(f.switchPreset('New preset'), /preset loader failed/);
    assert.equal(f.settings.bind_preset_to_connection, true);
    await f.switchApi('profile:p1');
});

test('deleted references and cross-family profiles fail before any connection change', async () => {
    for (const kind of ['profile', 'secret', 'proxy', 'family']) {
        const f = await fixture();
        if (kind === 'profile') f.extensionSettings.connectionManager.profiles = [];
        if (kind === 'secret') f.profile['secret-id'] = 'deleted-id';
        if (kind === 'proxy') f.profile.proxy = 'deleted-proxy';
        if (kind === 'family') f.profile.api = 'kobold';
        await assert.rejects(f.switchApi('profile:p1'));
        assert.equal(f.state.calls.length, 0);
    }
});

test('command failure stops subsequent fields and never reconnects a partial configuration', async () => {
    const f = await fixture();
    f.state.fail = 'api-url';
    await assert.rejects(f.switchApi('profile:p1'), /部分连接字段可能已改变/);
    assert.equal(f.state.secret, 'old-id');
    assert.equal(f.state.connects, 0);
    assert.equal(f.settings.temp_openai, 0.73);
});

test('generation and simultaneous operations cannot change connection or preset', async () => {
    const f = await fixture();
    f.state.generating = true;
    await assert.rejects(f.switchApi('profile:p1'), /停止生成/);
    await assert.rejects(f.switchModel('new-model'), /停止生成/);
    f.state.generating = false;
    let release;
    f.state.pause = new Promise(resolve => { release = resolve; });
    const first = f.switchApi('profile:p1');
    await assert.rejects(f.switchPreset('New preset'), /正在切换/);
    release();
    await first;
});

test('profile names and field values are data, not STScript or HTML', async () => {
    const f = await fixture();
    f.profile.name = '<img src=x onerror=alert(1)> | /delete';
    f.profile.model = 'model | /delete {{getvar::secret}}';
    f.init();
    assert.equal(f.document.querySelector('#ttis-api option[value="profile:p1"]').textContent, f.profile.name);
    assert.equal(f.document.querySelector('#tt-independent-switcher img'), null);
    await f.switchApi('profile:p1');
    assert.equal(f.state.model, f.profile.model);
});

test('empty list, refresh, selection and failed UI action leave controls usable', async () => {
    const f = await fixture();
    f.extensionSettings.connectionManager.profiles = [];
    f.init();
    f.init();
    assert.equal(f.document.querySelectorAll('#tt-independent-switcher').length, 1);
    assert.ok(f.document.querySelector('[data-empty]').textContent.includes('没有已保存'));
    assert.equal(f.document.querySelector('[data-apply-api]').disabled, true);
    f.extensionSettings.connectionManager.profiles.push(f.profile);
    f.document.querySelector('[data-refresh]').click();
    const select = f.document.querySelector('[data-api]');
    select.value = 'profile:p1';
    select.dispatchEvent(new f.window.Event('change'));
    assert.equal(f.document.querySelector('[data-apply-api]').disabled, false);
    f.state.fail = 'api';
    f.document.querySelector('[data-apply-api]').click();
    await new Promise(resolve => setImmediate(resolve));
    assert.match(f.document.querySelector('[data-status]').textContent, /未能准确应用/);
    assert.equal(f.document.querySelector('fieldset').disabled, false);
});

test('model-only targets clear absent route and proxy, preserve preset, and apply secret reference', async () => {
    const f = await fixture();
    f.extensionSettings.connectionManager.modelTargets.push({ id: 't1', name: 'Target', api: 'custom', model: 'new-model', secretRef: { key: 'custom-key', id: 'new-id' } });
    await f.switchApi('model:t1');
    assert.equal(f.state.url, '');
    assert.equal(f.state.proxy, 'None');
    assert.equal(f.state.secret, 'new-id');
    assert.equal(f.state.selectedPreset, 'Original');
    assert.equal(f.settings.custom_claude_prompt_caching, false);
});

test('excluded fields are not replayed and unsaved/deleted presets are rejected', async () => {
    const f = await fixture();
    f.profile.exclude = ['model'];
    await f.switchApi('profile:p1');
    assert.equal(f.state.model, 'old-model');
    await assert.rejects(f.switchPreset('Deleted preset'), /预设已不存在/);
});

test('waits for an already-running native preset application before starting a switch', async () => {
    const f = await fixture();
    let release;
    f.setPending(new Promise(resolve => { release = resolve; }));
    const switched = f.switchApi('profile:p1');
    await Promise.resolve();
    assert.equal(f.state.calls.length, 0);
    release();
    await switched;
});

test('integration: actual v2.4.0 OpenAI preset loader skips connection fields but applies prompt fields', async () => {
    const f = await fixture();
    const upstream = await readFile(new URL('../../TauriTavern-v2.4.0-reference/src/scripts/openai.js', import.meta.url), 'utf8');
    const start = upstream.indexOf('let presetApplicationPromise = Promise.resolve();');
    const end = upstream.indexOf('function getMaxContextOpenAI', start);
    assert.ok(start > 0 && end > start, 'Target source must be TauriTavern v2.4.0');
    const nativeContext = vm.createContext({
        $, structuredClone, oai_settings: f.settings, settingsToUpdate: f.mapping,
        openai_setting_names: { 'Original': 0, 'New preset': 1 },
        openai_settings: [{}, { temperature: 1.25, custom_url: 'https://wrong.example', custom_model: 'wrong-model', extensions: { newPreset: true } }],
        eventSource: f.eventSource,
        event_types: { OAI_PRESET_CHANGED_BEFORE: 'before', OAI_PRESET_CHANGED_AFTER: 'after', PRESET_CHANGED: 'preset' },
        migrateChatCompletionSettings: () => false, saveSettingsDebounced: () => {},
        saveOpenAIPreset: () => { throw new Error('Saved presets must not be overwritten'); },
        syncChatCompletionSourceSelector: () => { throw new Error('Connection rebinding must not run'); },
        applyCustomModelOptionsToAllSources: () => { throw new Error('Model rebinding must not run'); },
    });
    function $(selector) { return f.$(selector); }
    vm.runInContext(upstream.slice(start, end).replace('export function getPresetApplicationPromise', 'function getPresetApplicationPromise'), nativeContext);
    f.manager.selectPreset = async value => {
        f.$('#settings_preset_openai').val(value);
        nativeContext.onSettingsPresetChange();
        await nativeContext.getPresetApplicationPromise();
        f.state.selectedPreset = f.settings.preset_settings_openai;
    };
    await f.switchPreset('New preset');
    assert.equal(f.settings.temp_openai, 1.25);
    assert.deepEqual(f.settings.extensions, { newPreset: true });
    assert.equal(f.settings.custom_url, 'https://old.example/v1');
    assert.equal(f.settings.custom_model, 'old-model');
    assert.equal(f.settings.bind_preset_to_connection, true);
});
