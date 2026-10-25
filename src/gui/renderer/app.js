/* ============================================================
   wb-switch 渲染进程
   - 无框架、无构建步骤，直接操作 DOM
   - 所有危险操作（切换/删除/还原）都二次确认
   ============================================================ */

(() => {
  'use strict';

  const api = window.wb;

  const state = {
    overview: null,
    detail: null,
    view: 'sources',
    backups: [],
    doctor: null,
    busy: false,
    proxy: '',
    selected: new Set(), // 多选的源名
  };

  const $ = (sel, root = document) => root.querySelector(sel);

  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[c]);
  }

  class ApiError extends Error {
    constructor(reply) {
      super(reply?.error || '操作失败');
      this.hint = reply?.hint || '';
    }
  }

  /** 统一拆包 IPC 回执：{ok, data} | {ok:false, error, hint} */
  async function call(promise) {
    const reply = await promise;
    if (!reply || reply.ok !== true) throw new ApiError(reply);
    return reply.data;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function sizeText(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  // ───────────────────────── Toast ─────────────────────────

  function toast(kind, text, hint) {
    const el = document.createElement('div');
    el.className = `toast ${kind}`;
    el.innerHTML =
      `<span class="ti">${kind === 'ok' ? '✓' : kind === 'err' ? '!' : 'i'}</span>` +
      `<div class="tx">${esc(text)}${hint ? `<span class="th">${esc(hint)}</span>` : ''}</div>`;
    $('#toasts').appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .2s ease';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 240);
    }, kind === 'err' ? 7000 : 3200);
  }

  function reportError(err) {
    if (err instanceof ApiError) toast('err', err.message, err.hint);
    else toast('err', err?.message ? String(err.message) : String(err));
    console.error(err);
  }

  // ───────────────────────── 模态 ─────────────────────────

  function openModal({ title, body, footer = [], wide = false }) {
    $('#modalTitle').textContent = title;
    const bodyEl = $('#modalBody');
    bodyEl.innerHTML = '';
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else bodyEl.appendChild(body);

    const footEl = $('#modalFoot');
    footEl.innerHTML = '';
    for (const b of footer) {
      const btn = document.createElement('button');
      btn.className = b.className || 'btn btn-quiet';
      btn.textContent = b.label;
      if (b.id) btn.id = b.id;
      btn.onclick = b.onClick;
      footEl.appendChild(btn);
    }
    $('#modal').classList.toggle('wide', wide);
    $('#overlay').hidden = false;
  }

  function closeModal() {
    $('#overlay').hidden = true;
    $('#modalBody').innerHTML = '';
    $('#modalFoot').innerHTML = '';
  }

  function confirmDialog({ title, message, hint, confirmLabel = '确定', danger = false }) {
    return new Promise((resolve) => {
      const box = document.createElement('div');
      box.innerHTML =
        `<p class="confirm-msg">${esc(message)}</p>` +
        (hint ? `<p class="form-hint">${esc(hint)}</p>` : '');
      openModal({
        title,
        body: box,
        footer: [
          {
            label: '取消',
            className: 'btn btn-quiet',
            onClick: () => {
              closeModal();
              resolve(false);
            },
          },
          {
            label: confirmLabel,
            className: danger ? 'btn btn-danger' : 'btn btn-primary',
            onClick: () => {
              closeModal();
              resolve(true);
            },
          },
        ],
      });
    });
  }

  // ───────────────────────── 数据加载 ─────────────────────────

  async function loadDetail(name) {
    try {
      return await call(api.profile(name));
    } catch (err) {
      state.detail = null;
      toast('err', `读取源「${name}」失败`, err.hint || err.message);
      return null;
    }
  }

  async function reload(preselect) {
    const ov = await call(api.overview());
    state.overview = ov;

    let target = preselect || state.detail?.name || null;
    if (!target) {
      const active = ov.profiles.find((p) => p.active);
      target = active?.name ?? ov.profiles[0]?.name ?? null;
    }
    if (target && !ov.profiles.some((p) => p.name === target)) target = null;

    state.detail = target ? await loadDetail(target) : null;
    renderAll();
  }

  /** 包一层忙碌锁，避免连点重复执行 */
  async function guarded(fn) {
    if (state.busy) return;
    state.busy = true;
    document.body.classList.add('is-busy');
    try {
      await fn();
    } catch (err) {
      reportError(err);
    } finally {
      state.busy = false;
      document.body.classList.remove('is-busy');
    }
  }

  // ───────────────────────── 渲染：侧栏 ─────────────────────────

  function renderSidebar() {
    const o = state.overview;
    const activeProfile = o.profiles.find((p) => p.active);

    $('#currentName').textContent = o.state.active || '未设置';
    if (!o.profiles.length) {
      $('#currentMeta').textContent = '还没有源';
    } else if (activeProfile) {
      const host = activeProfile.hosts[0] || '无地址';
      $('#currentMeta').textContent = `${activeProfile.modelCount} 个模型 · ${host}`;
    } else {
      $('#currentMeta').textContent = '磁盘配置未匹配任何源';
    }

    $('#profileCount').textContent = String(o.profiles.length);
    $('#backupBadge').textContent = String(o.backupCount);

    const list = $('#profileList');
    list.innerHTML = '';
    if (!o.profiles.length) {
      list.innerHTML = '<div class="list-empty">暂无源</div>';
      renderBatchBar();
      return;
    }

    for (const p of o.profiles) {
      const btn = document.createElement('button');
      const multi = state.selected.has(p.name);
      btn.className = `profile-item${state.detail?.name === p.name ? ' is-selected' : ''}${multi ? ' is-multi' : ''}`;
      btn.innerHTML =
        `<div class="pi-top">
           ${multi ? '<span class="multi-check">✓</span>' : ''}
           <span class="dot${p.active ? ' active' : ''}"></span>
           <span class="pi-name">${esc(p.name)}</span>
           ${p.inSync ? '<span class="tag-sync">同步</span>' : ''}
         </div>
         <div class="pi-meta">${p.modelCount} 个模型 · ${esc(p.hosts.join(' / ') || '无地址')}</div>`;
      btn.onclick = (e) => {
        // Ctrl/Cmd 或 Shift 点击 → 多选
        if (e.ctrlKey || e.metaKey) {
          if (state.selected.has(p.name)) state.selected.delete(p.name);
          else state.selected.add(p.name);
          renderSidebar();
          return;
        }
        // 普通点击：清空多选，切到该源
        if (state.selected.size) {
          state.selected.clear();
          renderSidebar();
        }
        if (state.detail?.name === p.name) return;
        void guarded(async () => {
          state.detail = await loadDetail(p.name);
          renderAll();
        });
      };
      list.appendChild(btn);
    }

    renderBatchBar();
  }

  /** 批量操作栏：仅在多选时出现 */
  function renderBatchBar() {
    const bar = $('#batchBar');
    if (!bar) return;
    const n = state.selected.size;
    bar.hidden = n === 0;
    if (!n) return;
    bar.querySelector('#batchCount').textContent = `已选 ${n} 个源`;
  }

  // ───────────────────────── 渲染：源详情 ─────────────────────────

  function renderDetail() {
    const o = state.overview;
    const d = state.detail;
    const empty = o.profiles.length === 0;

    $('#emptyState').hidden = !empty;
    $('#detail').hidden = empty || !d;
    if (empty || !d) return;

    $('#dName').textContent = d.name;
    $('#dDesc').textContent = d.description || '';
    $('#dDesc').hidden = !d.description;

    const badges = [];
    if (d.active) badges.push('<span class="badge accent">当前源</span>');
    if (d.inSync) badges.push('<span class="badge ok">与磁盘一致</span>');
    if (d.active && !d.inSync) badges.push('<span class="badge warn">磁盘内容已变</span>');
    if (!d.active) badges.push('<span class="badge">未启用</span>');
    $('#dBadges').innerHTML = badges.join('');

    const hosts = [...new Set(d.models.map((m) => m.host).filter((h) => h && h !== '-'))];
    $('#dMeta').innerHTML = [
      ['模型数量', `${d.models.length} 个`],
      ['网关', hosts.join(' / ') || '—'],
      ['创建时间', fmtTime(d.origin?.createdAt)],
      ['源文件', d.filePath.split(/[\\/]/).pop()],
    ]
      .map(
        ([k, v]) =>
          `<div class="meta-cell"><div class="k">${esc(k)}</div><div class="v" title="${esc(v)}">${esc(v)}</div></div>`,
      )
      .join('');

    $('#dModelCount').textContent = String(d.models.length);
    $('#btnSwitch').disabled = Boolean(d.active && d.inSync);
    $('#btnSwitch').textContent = d.active && d.inSync ? '已在此源' : '切换到此源';

    const flags = [
      ['supportsToolCall', '工具调用'],
      ['supportsImages', '图像'],
      ['supportsReasoning', '推理'],
      ['useCustomProtocol', '自定义协议'],
    ];

    $('#dModels').innerHTML = d.models
      .map((m, i) => {
        const chips = flags
          .map(
            ([k, label]) =>
              `<span class="chip${m[k] ? ' on' : ''}">${label}${m[k] ? '' : ' 关'}</span>`,
          )
          .join('');
        return `<div class="model-card">
          <div class="mc-head">
            <span class="mc-name">${esc(m.name || m.id)}</span>
            ${m.name && m.name !== m.id ? `<span class="mc-id">${esc(m.id)}</span>` : ''}
            <span class="mc-vendor">${esc(m.vendor || '未标注')}</span>
          </div>
          <div class="mc-grid">
            <div class="field">
              <div class="k">接口地址</div>
              <div class="v" title="${esc(m.url)}">${esc(m.url || '—')}</div>
            </div>
            <div class="field">
              <div class="k">API Key</div>
              <div class="key-line">
                <span class="v" data-key="${i}">${esc(m.keyMasked || '未设置')}</span>
                ${
                  m.apiKey
                    ? `<button class="icon-btn" data-reveal="${i}" title="显示 / 隐藏">${eyeSvg()}</button>
                       <button class="icon-btn" data-copykey="${i}" title="复制">${copySvg()}</button>`
                    : ''
                }
              </div>
            </div>
          </div>
          <div class="chips">${chips}</div>
        </div>`;
      })
      .join('');

    // Key 显示切换
    $('#dModels').onclick = (e) => {
      const reveal = e.target.closest('[data-reveal]');
      if (reveal) {
        const i = Number(reveal.dataset.reveal);
        const span = $(`[data-key="${i}"]`);
        const shown = span.dataset.shown === '1';
        span.textContent = shown ? d.models[i].keyMasked : d.models[i].apiKey;
        span.dataset.shown = shown ? '0' : '1';
        return;
      }
      const copy = e.target.closest('[data-copykey]');
      if (copy) {
        const i = Number(copy.dataset.copykey);
        void call(api.copy(d.models[i].apiKey)).then(() =>
          toast('ok', 'API Key 已复制到剪贴板'),
        );
      }
    };
  }

  function eyeSvg() {
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z"/><circle cx="12" cy="12" r="2.6"/></svg>`;
  }

  function copySvg() {
    return `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/></svg>`;
  }

  function renderAll() {
    renderBanner();
    renderSidebar();
    renderDetail();
    $('#statusPath').textContent = `${state.overview.configRoot}`;
    $('#statusVersion').textContent = `v${state.overview.appVersion}`;
  }

  /** 磁盘上的 models.json 读不出来时，在主区域顶部说明清楚 */
  function renderBanner() {
    const el = $('#errBanner');
    const err = state.overview?.currentError;
    if (!err) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;
    el.innerHTML = `<span>⚠</span><span><b>读取 models.json 失败</b>：${esc(err)}<br />切换任意源会覆盖这个文件（覆盖前会自动备份）。</span>`;
  }

  // ───────────────────────── 渲染：备份 ─────────────────────────

  async function loadBackups() {
    try {
      state.backups = await call(api.backups());
      renderBackups();
    } catch (err) {
      reportError(err);
    }
  }

  function renderBackups() {
    const box = $('#backupList');
    if (!state.backups.length) {
      box.innerHTML =
        '<div class="check-row"><div class="check-body"><div class="check-name">还没有备份</div>' +
        '<div class="check-detail">第一次切换源时会自动创建。</div></div></div>';
      return;
    }
    const kindLabel = {
      switch: '切换前',
      restore: '还原前',
      deleted: '已删除的源',
      other: '其它',
    };
    box.innerHTML = state.backups
      .map(
        (b) => `<div class="row-card">
          <div class="rc-main">
            <div class="rc-title" title="${esc(b.file)}">${esc(b.file)}</div>
            <div class="rc-sub">${esc(kindLabel[b.kind] || '其它')} · ${esc(fmtTime(b.mtime))} · ${sizeText(b.size)}</div>
          </div>
          <button class="btn btn-quiet btn-sm" data-restore="${esc(b.file)}">还原</button>
        </div>`,
      )
      .join('');
    box.onclick = (e) => {
      const btn = e.target.closest('[data-restore]');
      if (btn) void doRestore(btn.dataset.restore);
    };
  }

  async function doRestore(file) {
    const okToGo = await confirmDialog({
      title: '还原备份',
      message: `用「${file}」覆盖当前 models.json？`,
      hint: '还原前会再备份一次当前配置，可以再还原回来。',
      confirmLabel: '还原',
    });
    if (!okToGo) return;
    await guarded(async () => {
      const r = await call(api.restore(file));
      await reload(r.active);
      await loadBackups();
      toast(
        'ok',
        '已还原配置',
        r.active ? `当前源已回填为「${r.active}」` : '内容未匹配任何源，当前源指针已清空',
      );
    });
  }

  // ───────────────────────── 渲染：自检 ─────────────────────────

  async function loadDoctor() {
    try {
      state.doctor = await call(api.doctor());
      renderDoctor();
    } catch (err) {
      reportError(err);
    }
  }

  function renderDoctor() {
    const r = state.doctor;
    if (!r) return;
    const mark = { ok: '✓', warn: '!', fail: '✕' };
    $('#doctorList').innerHTML = r.checks
      .map(
        (c) => `<div class="check-row">
          <div class="check-icon ${c.level}">${mark[c.level]}</div>
          <div class="check-body">
            <div class="check-name">${esc(c.name)}</div>
            <div class="check-detail">${esc(c.detail)}</div>
          </div>
        </div>`,
      )
      .join('');
    const fails = r.checks.filter((c) => c.level === 'fail').length;
    const warns = r.checks.filter((c) => c.level === 'warn').length;
    $('#doctorSub').textContent = r.ok
      ? warns
        ? `全部通过，${warns} 项提示`
        : '全部通过'
      : `${fails} 项异常，${warns} 项提示`;
  }

  // ───────────────────────── 动作：切换 ─────────────────────────

  async function doSwitch(name) {
    const o = state.overview;
    const target = o.profiles.find((p) => p.name === name);
    if (!target) return;
    if (target.active && target.inSync) {
      toast('info', `已经在「${name}」上了`);
      return;
    }

    const unmatched =
      o.currentModels !== null && o.profiles.length > 0 && !o.profiles.some((p) => p.inSync);
    if (unmatched) {
      const go = await confirmDialog({
        title: '磁盘上的配置与任何源都不一致',
        message: `当前 models.json 不是任何一个源的副本，切换到「${name}」会用源的配置覆盖它。`,
        hint: '覆盖前会自动备份，可在「备份」页还原。',
        confirmLabel: '继续切换',
      });
      if (!go) return;
    }

    await guarded(async () => {
      const r = await call(api.switchTo(name));
      await reload(name);
      if (r.identical) {
        toast('info', `「${name}」已同步`, '内容一致，无需重启');
      } else {
        toast(
          'ok',
          `已切换到「${name}」`,
          `写入 ${r.modelCount} 个模型${r.backup ? ` · 已备份原配置` : ''} · 需重启 WorkBuddy 或新开对话才能生效`,
        );
      }
      // 刷新托盘菜单（当前源变了）
      if (api.refreshTray) api.refreshTray();
    });
  }

  // ───────────────────────── 动作：删除 ─────────────────────────

  async function doDelete() {
    const d = state.detail;
    if (!d) return;
    const go = await confirmDialog({
      title: '删除源',
      message: `删除源「${d.name}」？`,
      hint: '源文件会被移到备份目录，之后仍可从「备份」页找回。当前 models.json 不会被修改。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!go) return;
    await guarded(async () => {
      const r = await call(api.remove(d.name));
      await reload();
      toast('ok', `已删除「${r.name}」`, r.keptCopy ? '源文件已保留在备份目录' : '');
    });
  }

  // ───────────────────────── 动作：导出 ─────────────────────────

  async function doExport() {
    const d = state.detail;
    if (!d) return;
    await guarded(async () => {
      const r = await call(api.exportProfile(d.name));
      if (!r) return;
      toast('ok', `已导出 ${r.modelCount} 个模型`, r.file);
    });
  }

  /** 批量删除选中的源 */
  async function batchDelete() {
    const names = [...state.selected];
    if (!names.length) return;
    const ok = await confirmDialog({
      title: '批量删除',
      message: `确定要删除 ${names.length} 个源吗？`,
      hint: names.join('、'),
      confirmLabel: '全部删除',
      danger: true,
    });
    if (!ok) return;
    await guarded(async () => {
      for (const name of names) {
        await call(api.remove(name));
      }
      state.selected.clear();
      await reload(null);
      toast('ok', `已删除 ${names.length} 个源`);
    });
  }

  /** 批量导出选中的源到一个文件夹 */
  async function batchExport() {
    const names = [...state.selected];
    if (!names.length) return;
    await guarded(async () => {
      // 逐个导出，文件名为 源名-models.json
      const dir = await call(api.pickExportDir());
      if (!dir) return;
      for (const name of names) {
        await call(api.exportProfileTo(name, dir));
      }
      toast('ok', `已导出 ${names.length} 个源`, dir);
    });
  }

  async function doImport() {
    await guarded(async () => {
      const file = await call(api.pickImportFile());
      if (!file) return;
      const baseName = file.split(/[\\/]/).pop().replace(/\.json$/i, '');
      openModal({
        title: '导入模型配置',
        body: (() => {
          const box = document.createElement('div');
          box.innerHTML =
            `<p class="confirm-msg">导入文件 <b>${esc(baseName)}</b></p>` +
            `<div class="form-row" style="margin-top:8px"><label class="form-label">源名称</label>` +
            `<input class="input" id="impName" value="${esc(baseName)}" maxlength="64" /></div>`;
          return box;
        })(),
        footer: [
          { label: '取消', className: 'btn btn-quiet', onClick: closeModal },
          {
            label: '导入',
            className: 'btn btn-primary',
            onClick: () => {
              const name = $('#impName')?.value.trim();
              if (!name) { toast('err', '请填写源名称'); return; }
              void (async () => {
                await guarded(async () => {
                  const r = await call(api.importAs(file, name));
                  closeModal();
                  await reload(r.name);
                  toast('ok', `已导入「${r.name}」`, `${r.modelCount} 个模型`);
                });
              })();
            },
          },
        ],
      });
    });
  }

  /** 重命名当前源 */
  function openRenameModal() {
    const d = state.detail;
    if (!d) return;
    const box = document.createElement('div');
    box.innerHTML =
      `<div class="form-row"><label class="form-label">新名称</label>` +
      `<input class="input" id="rnName" value="${esc(d.name)}" maxlength="64" /></div>`;
    openModal({
      title: '重命名源',
      body: box,
      footer: [
        { label: '取消', className: 'btn btn-quiet', onClick: closeModal },
        {
          label: '保存',
          className: 'btn btn-primary',
          onClick: () => {
            const name = $('#rnName')?.value.trim();
            if (!name) { toast('err', '请填写名称'); return; }
            void (async () => {
              await guarded(async () => {
                const r = await call(api.rename(d.name, name));
                closeModal();
                await reload(r.to);
                toast('ok', `已重命名为「${r.to}」`);
              });
            })();
          },
        },
      ],
    });
    setTimeout(() => $('#rnName')?.focus(), 30);
  }

  /** Ctrl+F：聚焦侧栏搜索框（如果有的话），否则选第一个源 */
  function focusSidebarSearch() {
    const search = $('#sidebarSearch');
    if (search) { search.focus(); search.select(); return; }
    const first = document.querySelector('.profile-item');
    if (first) first.click();
  }

  /** 源对比 diff：选另一个源，显示模型差异 */
  function openDiffModal() {
    const d = state.detail;
    if (!d) return;
    const others = state.overview.profiles.filter((p) => p.name !== d.name);
    if (!others.length) {
      toast('err', '没有其他源可对比');
      return;
    }

    const box = document.createElement('div');
    box.innerHTML = `
      <div class="form-row">
        <label class="form-label">对比对象</label>
        <select class="input" id="diffSel">
          ${others.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}（${p.modelCount} 个模型）</option>`).join('')}
        </select>
      </div>
      <div id="diffResult"></div>`;

    const sel = box.querySelector('#diffSel');
    const result = box.querySelector('#diffResult');

    async function render() {
      const otherName = sel.value;
      const other = await loadDetail(otherName);
      if (!other) return;
      const a = new Map(d.models.map((m) => [m.id, m]));
      const b = new Map(other.models.map((m) => [m.id, m]));
      const allIds = [...new Set([...a.keys(), ...b.keys()])].sort();

      const added = [];
      const removed = [];
      const changed = [];
      const same = [];
      for (const id of allIds) {
        const ma = a.get(id);
        const mb = b.get(id);
        if (ma && !mb) removed.push(id);
        else if (!ma && mb) added.push(id);
        else if (ma && mb) {
          const fields = ['url', 'apiKey', 'vendor', 'supportsToolCall', 'supportsImages', 'supportsReasoning'];
          const diff = fields.filter((f) => String(ma[f]) !== String(mb[f]));
          if (diff.length) changed.push({ id, fields: diff, a: ma, b: mb });
          else same.push(id);
        }
      }

      const parts = [];
      if (added.length) parts.push(`<div class="diff-section diff-add">
        <h3>仅在「${esc(other.name)}」中有（+${added.length}）</h3>
        ${added.map((id) => `<div class="diff-row add"><span class="diff-id">${esc(id)}</span></div>`).join('')}
      </div>`);
      if (removed.length) parts.push(`<div class="diff-section diff-rem">
        <h3>仅在「${esc(d.name)}」中有（-${removed.length}）</h3>
        ${removed.map((id) => `<div class="diff-row rem"><span class="diff-id">${esc(id)}</span></div>`).join('')}
      </div>`);
      if (changed.length) parts.push(`<div class="diff-section diff-chg">
        <h3>两侧都有但字段不同（${changed.length}）</h3>
        ${changed.map((c) => `<div class="diff-row chg">
          <span class="diff-id">${esc(c.id)}</span>
          <span class="diff-fields">${c.fields.map((f) => esc(f)).join('、')}</span>
        </div>`).join('')}
      </div>`);
      if (same.length) parts.push(`<div class="diff-section diff-same">
        <h3>完全相同（${same.length}）</h3>
        <div class="diff-hint">${same.length} 个模型在两个源中配置一致</div>
      </div>`);
      if (!parts.length) parts.push('<div class="diff-hint">两个源完全相同</div>');

      result.innerHTML = parts.join('');
    }

    sel.onchange = () => void render();
    void render();

    openModal({
      title: `对比：${d.name} ⇄ ?`,
      body: box,
      wide: true,
      footer: [{ label: '关闭', className: 'btn btn-quiet', onClick: closeModal }],
    });
  }

  // ───────────────────────── 模型编辑组件 ─────────────────────────

  const FLAGS = [
    ['supportsToolCall', '工具调用'],
    ['supportsImages', '图像'],
    ['supportsReasoning', '推理'],
    ['useCustomProtocol', '自定义协议'],
  ];

  function blankModel() {
    return {
      id: '',
      name: '',
      vendor: 'Custom',
      url: '',
      host: '',
      apiKey: '',
      keyMasked: '',
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false,
      extra: {},
    };
  }

  function modelBlock(m, i) {
    const flags = FLAGS.map(
      ([k, label]) => `<label class="switch-line">
        <input type="checkbox" data-i="${i}" data-f="${k}" ${m[k] ? 'checked' : ''} />${label}
      </label>`,
    ).join('');
    return `<div class="editor-block" draggable="true" data-idx="${i}">
      <div class="eb-head">
        <span class="eb-drag" title="拖拽排序">⣿</span>
        <span class="eb-title">模型 ${i + 1}</span>
        <span class="eb-id-hint">${esc(m.id || '未填写')}</span>
        <button class="btn btn-danger-quiet btn-sm" data-del="${i}">移除</button>
      </div>
      <div class="grid-2">
        <div class="form-row">
          <label class="form-label">id<span class="req">*</span></label>
          <input class="input mono" data-i="${i}" data-f="id" value="${esc(m.id)}" placeholder="deepseek-flash" />
        </div>
        <div class="form-row">
          <label class="form-label">显示名称</label>
          <input class="input" data-i="${i}" data-f="name" value="${esc(m.name)}" placeholder="留空则用 id" />
        </div>
      </div>
      <div class="form-row">
        <label class="form-label">接口地址<span class="req">*</span></label>
        <input class="input mono" data-i="${i}" data-f="url" value="${esc(m.url)}"
          placeholder="https://api.example.com/v1/chat/completions" />
      </div>
      <div class="grid-2">
        <div class="form-row">
          <label class="form-label">API Key</label>
          <input class="input mono" type="password" data-i="${i}" data-f="apiKey" value="${esc(m.apiKey)}" placeholder="sk-..." />
        </div>
        <div class="form-row">
          <label class="form-label">供应商</label>
          <input class="input" data-i="${i}" data-f="vendor" value="${esc(m.vendor)}" placeholder="Custom" />
        </div>
      </div>
      <div class="checks">${flags}</div>
    </div>`;
  }

  function buildEditor(initial) {
    const list = initial.map((m) => ({ ...blankModel(), ...m, extra: { ...(m.extra || {}) } }));
    const wrap = document.createElement('div');

    function draw() {
      wrap.innerHTML =
        list.map((m, i) => modelBlock(m, i)).join('') +
        `<button class="btn btn-quiet btn-sm" data-add>＋ 添加模型</button>`;
    }
    draw();

    // ── 拖拽排序：拖动一个 block 放到另一个 block 上方，交换位置 ──
    let dragIdx = null;
    wrap.addEventListener('dragstart', (e) => {
      const block = e.target.closest('.editor-block');
      if (!block) return;
      dragIdx = Number(block.dataset.idx);
      block.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    wrap.addEventListener('dragend', () => {
      wrap.querySelectorAll('.editor-block.dragging').forEach((b) => b.classList.remove('dragging'));
      wrap.querySelectorAll('.editor-block.drag-over').forEach((b) => b.classList.remove('drag-over'));
      dragIdx = null;
    });
    wrap.addEventListener('dragover', (e) => {
      if (dragIdx === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const block = e.target.closest('.editor-block');
      if (!block) return;
      const overIdx = Number(block.dataset.idx);
      if (overIdx === dragIdx) return;
      wrap.querySelectorAll('.editor-block.drag-over').forEach((b) => b.classList.remove('drag-over'));
      block.classList.add('drag-over');
    });
    wrap.addEventListener('drop', (e) => {
      e.preventDefault();
      if (dragIdx === null) return;
      const block = e.target.closest('.editor-block');
      if (!block) return;
      const overIdx = Number(block.dataset.idx);
      if (overIdx === dragIdx) return;
      // 把拖动的项移到目标位置
      const item = list.splice(dragIdx, 1)[0];
      list.splice(overIdx, 0, item);
      draw();
    });

    wrap.addEventListener('input', (e) => {
      const t = e.target;
      const i = Number(t.dataset.i);
      const f = t.dataset.f;
      if (!Number.isInteger(i) || !f) return;
      list[i][f] = t.type === 'checkbox' ? t.checked : t.value;
    });

    wrap.addEventListener('click', (e) => {
      if (e.target.closest('[data-add]')) {
        list.push(blankModel());
        draw();
        const blocks = wrap.querySelectorAll('.editor-block');
        blocks[blocks.length - 1]?.scrollIntoView({ block: 'nearest' });
        return;
      }
      const del = e.target.closest('[data-del]');
      if (del) {
        if (list.length === 1) {
          toast('err', '至少要保留一个模型');
          return;
        }
        list.splice(Number(del.dataset.del), 1);
        draw();
      }
    });

    return {
      el: wrap,
      getModels: () => list,
      /** 追加若干模型（编辑源时从网关拉取用） */
      append: (models) => {
        for (const m of models) {
          list.push({ ...blankModel(), ...m, extra: { ...(m.extra || {}) } });
        }
        draw();
      },
    };
  }

  function validateModels(list) {
    if (!list.length) return '至少要有一个模型条目。';
    const ids = new Set();
    for (const m of list) {
      const id = (m.id || '').trim();
      if (!id) return '每个模型都要填 id。';
      if (ids.has(id)) return `模型 id 重复：「${id}」。`;
      ids.add(id);
      const url = (m.url || '').trim();
      if (!url) return `模型「${id}」缺少接口地址。`;
      if (!/^https?:\/\//i.test(url)) return `模型「${id}」的地址需以 http:// 或 https:// 开头。`;
    }
    return null;
  }

  // ───────────────────── 从网关获取模型的面板 ─────────────────────

  /**
   * 构建「获取模型 → 搜索 → 勾选（启用/禁用）→ 指定写入」的面板。
   * 只负责交互与展示，真正的网络请求走 IPC（主进程），URL 推导也在服务层完成。
   */
  function buildFetchPanel() {
    const el = document.createElement('div');
    el.className = 'fetch-panel';
    // 左：连接信息（地址 / 密钥 / 供应商 / 能力默认值）；右：模型列表（搜索 + 勾选）
    el.innerHTML = `
      <div class="fetch-split">
        <div class="fetch-left">
          <div class="form-row">
            <label class="form-label">接口地址<span class="req">*</span></label>
            <input class="input mono" id="fmUrl" placeholder="https://网关地址/v1/chat/completions" spellcheck="false" />
          </div>
          <div class="form-row">
            <label class="form-label">API Key<span class="req">*</span></label>
            <div class="input-wrap">
              <input class="input mono" id="fmKey" type="password" placeholder="sk-..." spellcheck="false" />
              <button class="icon-btn in-input" id="fmEye" type="button" title="显示 / 隐藏密钥">${eyeSvg()}</button>
            </div>
          </div>
          <div class="form-row">
            <label class="form-label">供应商</label>
            <input class="input" id="fmVendor" placeholder="Custom" />
          </div>
          <div class="fetch-bar">
            <button class="btn btn-primary btn-sm" id="fmFetch" type="button">获取模型</button>
            <button class="btn btn-quiet btn-sm" id="fmUseCurrent" type="button">带入当前源</button>
          </div>
          <div class="fetch-status" id="fmStatus">填写地址与密钥后点「获取模型」</div>
          <div class="checks" id="fmFlags">
            <span class="flags-label">默认能力</span>
            <label class="switch-line"><input type="checkbox" data-flag="supportsToolCall" checked />工具调用</label>
            <label class="switch-line"><input type="checkbox" data-flag="supportsImages" />图像</label>
            <label class="switch-line"><input type="checkbox" data-flag="supportsReasoning" />推理</label>
          </div>
        </div>
        <div class="fetch-right">
          <div class="picker" id="fmPicker">
            <div class="picker-head">
              <input class="input" id="fmSearch" placeholder="搜索模型 id（空格分隔多个关键词）" spellcheck="false" />
              <div class="picker-bulk">
                <button class="btn btn-quiet btn-sm" data-sel="all" type="button">全选</button>
                <button class="btn btn-quiet btn-sm" data-sel="none" type="button">全不选</button>
                <button class="btn btn-quiet btn-sm" data-sel="invert" type="button">反选</button>
              </div>
              <span class="picker-count" id="fmCount">已选 0 / 0</span>
            </div>
            <div class="picker-list" id="fmList"><div class="pick-empty">点左侧「获取模型」拉取列表</div></div>
          </div>
        </div>
      </div>`;

    const q = (sel) => el.querySelector(sel);
    const urlEl = q('#fmUrl');
    const keyEl = q('#fmKey');
    const vendorEl = q('#fmVendor');
    const statusEl = q('#fmStatus');
    const listEl = q('#fmList');
    const countEl = q('#fmCount');
    const searchEl = q('#fmSearch');
    const fetchBtn = q('#fmFetch');

    let all = [];
    const chosen = new Set();
    let keyword = '';
    let touched = false;
    let endpoint = '';

    const setStatus = (kind, text) => {
      statusEl.className = `fetch-status ${kind || ''}`;
      statusEl.textContent = text;
      if (kind !== 'ok') statusEl.title = '';
    };

    function updateCount() {
      const shown = keyword ? all.filter(matches).length : all.length;
      countEl.textContent = keyword
        ? `已选 ${chosen.size} / ${all.length}（筛出 ${shown}）`
        : `已选 ${chosen.size} / ${all.length}`;
    }

    function matches(m) {
      if (!keyword) return true;
      const hay = `${m.id} ${m.owner || ''}`.toLowerCase();
      return keyword.split(/\s+/).every((k) => hay.includes(k));
    }

    function renderList() {
      if (!all.length) {
        listEl.innerHTML = '<div class="pick-empty">还没有获取到模型</div>';
        updateCount();
        return;
      }
      const rows = all.filter(matches);
      if (!rows.length) {
        listEl.innerHTML = `<div class="pick-empty">没有匹配「${esc(keyword)}」的模型</div>`;
        updateCount();
        return;
      }
      listEl.innerHTML = rows
        .map(
          (m) => `<label class="pick-row${chosen.has(m.id) ? ' on' : ''}" data-id="${esc(m.id)}">
            <input type="checkbox"${chosen.has(m.id) ? ' checked' : ''} />
            <span class="pr-id">${esc(m.id)}</span>
            ${m.owner ? `<span class="pr-owner">${esc(m.owner)}</span>` : ''}
          </label>`,
        )
        .join('');
      updateCount();
    }

    // 勾选 / 取消（启用 / 禁用）
    listEl.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      const row = cb.closest('.pick-row');
      if (!row) return;
      const id = row.dataset.id;
      if (cb.checked) chosen.add(id);
      else chosen.delete(id);
      row.classList.toggle('on', cb.checked);
      updateCount();
    });

    searchEl.addEventListener('input', () => {
      keyword = searchEl.value.trim().toLowerCase();
      renderList();
    });

    el.querySelector('.picker-bulk').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-sel]');
      if (!btn) return;
      const visible = all.filter(matches);
      if (btn.dataset.sel === 'all') visible.forEach((m) => chosen.add(m.id));
      if (btn.dataset.sel === 'none') visible.forEach((m) => chosen.delete(m.id));
      if (btn.dataset.sel === 'invert') {
        visible.forEach((m) => {
          if (chosen.has(m.id)) chosen.delete(m.id);
          else chosen.add(m.id);
        });
      }
      renderList();
    });

    q('#fmEye').addEventListener('click', () => {
      keyEl.type = keyEl.type === 'password' ? 'text' : 'password';
    });

    for (const node of [urlEl, keyEl]) {
      node.addEventListener('input', () => {
        touched = true;
      });
    }

    async function doFetch() {
      const url = urlEl.value.trim();
      const apiKey = keyEl.value.trim();
      if (!url) {
        setStatus('err', '请先填写接口地址');
        urlEl.focus();
        return;
      }
      if (!apiKey) {
        setStatus('err', '请先填写 API Key');
        keyEl.focus();
        return;
      }
      fetchBtn.disabled = true;
      listEl.innerHTML = '<div class="pick-empty">正在获取…</div>';
      setStatus('busy', '正在获取模型…');
      try {
        const r = await call(api.fetchModels({ url, apiKey, proxyUrl: state.proxy || undefined }));
        all = r.models;
        endpoint = r.endpoint;
        chosen.clear();
        all.forEach((m) => chosen.add(m.id));
        keyword = '';
        searchEl.value = '';
        renderList();
        setStatus('ok', `已获取 ${all.length} 个模型 · ${r.elapsedMs} ms`);
        statusEl.title = `端点：${r.endpoint}`;
        // 只聚焦不滚动，避免把上面的地址/密钥挤出可视区
        searchEl.focus({ preventScroll: true });
      } catch (err) {
        all = [];
        chosen.clear();
        listEl.innerHTML = '<div class="pick-empty">获取失败，见左侧提示</div>';
        updateCount();
        const msg = err instanceof ApiError ? err.message : String(err?.message || err);
        const hint = err instanceof ApiError && err.hint ? `\n${err.hint}` : '';
        setStatus('err', `${msg}${hint}`);
      } finally {
        fetchBtn.disabled = false;
      }
    }

    fetchBtn.addEventListener('click', () => void doFetch());
    urlEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        keyEl.focus();
      }
    });
    keyEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void doFetch();
      }
    });

    q('#fmUseCurrent').addEventListener('click', () => {
      void (async () => {
        try {
          const s = await call(api.suggestConnection(state.detail?.name));
          if (!s) {
            setStatus('err', '当前没有可复用的地址与密钥');
            return;
          }
          fill(s);
          setStatus('info', `已带入${s.from}的地址与密钥`);
        } catch (err) {
          reportError(err);
        }
      })();
    });

    function fill(s) {
      if (s.url && !urlEl.value.trim()) urlEl.value = s.url;
      if (s.apiKey && !keyEl.value.trim()) keyEl.value = s.apiKey;
      if (s.vendor && !touched) vendorEl.value = s.vendor;
      if (s.from) setStatus('info', `已带入${s.from}的地址与密钥`);
    }

    return {
      el,
      fill,
      isPristine: () => !touched && !all.length,
      fetchNow: doFetch,
      selectedIds: () => [...chosen],
      connection: () => ({
        url: urlEl.value.trim(),
        apiKey: keyEl.value.trim(),
        vendor: vendorEl.value.trim() || 'Custom',
      }),
      flags: () => {
        const out = {};
        el.querySelectorAll('[data-flag]').forEach((cb) => {
          out[cb.dataset.flag] = cb.checked;
        });
        return out;
      },
      summary: () => ({ total: all.length, selected: chosen.size, endpoint }),
    };
  }

  // ───────────────────────── 新建源 ─────────────────────────

  function openNewModal(mode = 'template') {
    const current = state.overview.currentModels || [];
    if (mode === 'snapshot' && current.length === 0) mode = 'fetch';

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="seg">
        <button data-mode="template">从模板创建</button>
        <button data-mode="fetch">从网关获取</button>
        <button data-mode="snapshot">从当前配置复制</button>
        <button data-mode="manual">手工填写</button>
      </div>
      <div class="grid-2">
        <div class="form-row">
          <label class="form-label">源名称<span class="req">*</span></label>
          <input class="input" id="npName" placeholder="例如 work / 官方 / 备用网关" maxlength="64" />
        </div>
        <div class="form-row">
          <label class="form-label">描述（可选）</label>
          <input class="input" id="npDesc" placeholder="给自己看的备注" />
        </div>
      </div>
      <div id="npBody"></div>`;

    const seg = body.querySelector('.seg');
    const segButtons = [...seg.querySelectorAll('button')];
    const bodyHost = body.querySelector('#npBody');
    let editor = null;
    let fetchPanel = null;
    let templateState = null;

    let templateData = null;

    function paint(m) {
      segButtons.forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
      bodyHost.innerHTML = '';
      editor = null;
      fetchPanel = null;
      templateData = null;

      if (m === 'template') {
        const wrap = document.createElement('div');
        wrap.innerHTML = `
          <div class="template-bar">
            <select class="input" id="tplSelect"></select>
            <a class="tpl-key-link" id="tplKeyLink" href="#" target="_blank" hidden>获取 API Key ↗</a>
          </div>
          <div class="form-row">
            <label class="form-label">API Key<span class="req">*</span></label>
            <div class="input-wrap">
              <input class="input mono" id="tplKey" type="password" placeholder="sk-..." spellcheck="false" />
              <button class="icon-btn in-input" id="tplEye" type="button">${eyeSvg()}</button>
            </div>
          </div>
          <div class="fetch-bar">
            <button class="btn btn-primary btn-sm" id="tplFetch" type="button">获取模型列表</button>
            <span class="fetch-status" id="tplStatus">选择厂商后填入 API Key，点「获取模型」</span>
          </div>
          <div class="picker" id="tplPicker">
            <div class="picker-head">
              <input class="input" id="tplSearch" placeholder="搜索模型 id" spellcheck="false" />
              <div class="picker-bulk">
                <button class="btn btn-quiet btn-sm" data-sel="all" type="button">全选</button>
                <button class="btn btn-quiet btn-sm" data-sel="none" type="button">全不选</button>
                <button class="btn btn-quiet btn-sm" data-sel="invert" type="button">反选</button>
              </div>
              <span class="picker-count" id="tplCount">已选 0 / 0</span>
            </div>
            <div class="picker-list" id="tplList"><div class="pick-empty">选择厂商后获取模型列表</div></div>
          </div>`;

        bodyHost.appendChild(wrap);

        const selEl = wrap.querySelector('#tplSelect');
        const keyEl = wrap.querySelector('#tplKey');
        const statusEl = wrap.querySelector('#tplStatus');
        const listEl = wrap.querySelector('#tplList');
        const countEl = wrap.querySelector('#tplCount');
        const searchEl = wrap.querySelector('#tplSearch');
        const fetchBtn = wrap.querySelector('#tplFetch');
        const keyLink = wrap.querySelector('#tplKeyLink');

        let all = [];
        const chosen = new Set();
        let keyword = '';
        let currentTpl = null;

        // 加载模板列表
        void (async () => {
          try {
            const list = await call(api.templates());
            templateData = list;
            selEl.innerHTML = '<option value="">— 选择厂商 —</option>' +
              list.map(t => `<option value="${esc(t.id)}">${esc(t.name)} — ${esc(t.description)}</option>`).join('');
          } catch (err) { reportError(err); }
        })();

        const setStatus = (kind, text) => {
          statusEl.className = 'fetch-status ' + (kind || '');
          statusEl.textContent = text;
        };

        function updateCount() {
          const shown = keyword ? all.filter(matches).length : all.length;
          countEl.textContent = keyword
            ? '已选 ' + chosen.size + ' / ' + all.length + '（筛出 ' + shown + '）'
            : '已选 ' + chosen.size + ' / ' + all.length;
        }

        function matches(m) {
          if (!keyword) return true;
          return (m.id + ' ' + (m.owner || '')).toLowerCase().includes(keyword);
        }

        function renderList() {
          if (!all.length) {
            listEl.innerHTML = '<div class="pick-empty">还没有获取到模型</div>';
            updateCount();
            return;
          }
          const rows = all.filter(matches);
          if (!rows.length) {
            listEl.innerHTML = '<div class="pick-empty">没有匹配「' + esc(keyword) + '」的模型</div>';
            updateCount();
            return;
          }
          listEl.innerHTML = rows.map(m =>
            '<label class="pick-row' + (chosen.has(m.id) ? ' on' : '') + '" data-id="' + esc(m.id) + '">' +
            '<input type="checkbox"' + (chosen.has(m.id) ? ' checked' : '') + ' />' +
            '<span class="pr-id">' + esc(m.id) + '</span>' +
            (m.owner ? '<span class="pr-owner">' + esc(m.owner) + '</span>' : '') +
            '</label>'
          ).join('');
          updateCount();
        }

        listEl.addEventListener('change', (e) => {
          const cb = e.target.closest('input[type="checkbox"]');
          if (!cb) return;
          const row = cb.closest('.pick-row');
          if (!row) return;
          const id = row.dataset.id;
          if (cb.checked) chosen.add(id); else chosen.delete(id);
          row.classList.toggle('on', cb.checked);
          updateCount();
        });

        searchEl.addEventListener('input', () => {
          keyword = searchEl.value.trim().toLowerCase();
          renderList();
        });

        wrap.querySelector('.picker-bulk').addEventListener('click', (e) => {
          const btn = e.target.closest('[data-sel]');
          if (!btn) return;
          const visible = all.filter(matches);
          if (btn.dataset.sel === 'all') visible.forEach(m => chosen.add(m.id));
          if (btn.dataset.sel === 'none') visible.forEach(m => chosen.delete(m.id));
          if (btn.dataset.sel === 'invert') visible.forEach(m => { if (chosen.has(m.id)) chosen.delete(m.id); else chosen.add(m.id); });
          renderList();
        });

        wrap.querySelector('#tplEye').addEventListener('click', () => {
          keyEl.type = keyEl.type === 'password' ? 'text' : 'password';
        });

        selEl.addEventListener('change', () => {
          const id = selEl.value;
          currentTpl = (templateData || []).find(t => t.id === id);
          if (!currentTpl) { keyLink.hidden = true; return; }
          keyLink.hidden = false;
          keyLink.href = currentTpl.keyUrl;
          keyLink.textContent = '获取 ' + currentTpl.name + ' API Key ↗';
          // 预填模板模型（静态列表）
          all = currentTpl.models.map(m => ({ id: m.id, owner: '' }));
          chosen.clear();
          all.forEach(m => chosen.add(m.id));
          keyword = '';
          searchEl.value = '';
          renderList();
          // 已停服务的厂商显示警告
          if (currentTpl.discontinued) {
            setStatus('err', '⚠ 该服务已停止，无法获取模型');
          } else {
            setStatus('info', '已预填 ' + all.length + ' 个常见模型，填入 Key 后可点「获取模型」刷新');
          }
        });

        async function doFetch() {
          if (!currentTpl) { setStatus('err', '请先选择厂商'); return; }
          const apiKey = keyEl.value.trim();
          if (!apiKey) { setStatus('err', '请先填写 API Key'); keyEl.focus(); return; }
          fetchBtn.disabled = true;
          listEl.innerHTML = '<div class="pick-empty">正在获取…</div>';
          setStatus('busy', '正在从 ' + currentTpl.name + ' 获取模型…');
          try {
            const r = await call(api.fetchModels({ url: currentTpl.baseUrl, apiKey, proxyUrl: state.proxy || undefined }));
            all = r.models;
            chosen.clear();
            all.forEach(m => chosen.add(m.id));
            keyword = '';
            searchEl.value = '';
            renderList();
            setStatus('ok', '已获取 ' + all.length + ' 个模型 · ' + r.elapsedMs + 'ms');
            searchEl.focus({ preventScroll: true });
          } catch (err) {
            all = [];
            chosen.clear();
            listEl.innerHTML = '<div class="pick-empty">获取失败，见上方提示</div>';
            updateCount();
            const msg = err instanceof ApiError ? err.message : String(err?.message || err);
            const hint = err instanceof ApiError && err.hint ? '\n' + err.hint : '';
            setStatus('err', msg + hint);
          } finally {
            fetchBtn.disabled = false;
          }
        }

        fetchBtn.addEventListener('click', () => void doFetch());
        keyEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); void doFetch(); }
        });

        // 把接口存到外层，save() 能取到
        templateState = {
          selectedIds: () => [...chosen],
          templateId: () => currentTpl?.id || '',
          apiKey: () => keyEl.value.trim(),
        };
        return;
      }

      if (m === 'fetch') {
        const panel = buildFetchPanel();
        fetchPanel = panel;
        bodyHost.appendChild(panel.el);
        // 自动带入当前源的地址与密钥，并立即拉一次模型列表
        void (async () => {
          try {
            const s = await call(api.suggestConnection(state.detail?.name));
            if (!s || fetchPanel !== panel) return;
            panel.fill(s);
            await panel.fetchNow();
          } catch {
            /* 复用失败就让用户手填，不打扰 */
          }
        })();
        return;
      }

      if (m === 'snapshot') {
        if (!current.length) {
          bodyHost.innerHTML =
            '<div class="form-hint">磁盘上还没有 models.json，请改用「从网关获取」或「手工填写」。</div>';
          return;
        }
        bodyHost.innerHTML =
          `<div class="form-hint" style="margin-bottom:8px">将复制磁盘上当前的 ${current.length} 个模型：</div>` +
          `<div class="preview-list">${current
            .map(
              (x) =>
                `<div class="preview-item"><span>${esc(x.name || x.id)}</span><span class="pi-id">${esc(x.id)}</span><span class="pi-host">${esc(x.host)}</span></div>`,
            )
            .join('')}</div>`;
        return;
      }

      editor = buildEditor([blankModel()]);
      bodyHost.appendChild(editor.el);
    }

    segButtons.forEach((b) => {
      b.onclick = () => paint(b.dataset.mode);
    });
    paint(mode);

    const nameInput = body.querySelector('#npName');
    setTimeout(() => nameInput.focus(), 30);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void save();
    });

    async function save() {
      const name = nameInput.value.trim();
      const desc = body.querySelector('#npDesc').value.trim();
      const activeMode = segButtons.find((b) => b.classList.contains('on')).dataset.mode;

      if (!name) {
        toast('err', '请填写源名称');
        nameInput.focus();
        return;
      }

      if (activeMode === 'manual' && editor) {
        const bad = validateModels(editor.getModels());
        if (bad) {
          toast('err', bad);
          return;
        }
      }

      if (activeMode === 'template') {
        if (!templateState) return;
        if (!templateState.templateId()) {
          toast('err', '请先选择厂商');
          return;
        }
        if (!templateState.apiKey()) {
          toast('err', '请填写 API Key');
          return;
        }
        if (!templateState.selectedIds().length) {
          toast('err', '请至少勾选一个模型');
          return;
        }
      }

      if (activeMode === 'fetch') {
        if (!fetchPanel) return;
        const conn = fetchPanel.connection();
        if (!conn.url) {
          toast('err', '请先填写接口地址');
          return;
        }
        if (!conn.apiKey) {
          toast('err', '请先填写 API Key');
          return;
        }
        if (!fetchPanel.selectedIds().length) {
          toast('err', '请至少勾选一个要写入的模型', '可以先点「获取模型」再取消不要的');
          return;
        }
      }

      await guarded(async () => {
        let r;
        if (activeMode === 'snapshot') {
          r = await call(api.createFromCurrent(name, desc || undefined));
        } else if (activeMode === 'manual') {
          r = await call(api.createManual({ name, description: desc, models: editor.getModels() }));
        } else if (activeMode === 'template') {
          const models = await call(
            api.composeFromTemplate(templateState.templateId(), templateState.apiKey(), templateState.selectedIds()),
          );
          r = await call(api.createManual({ name, description: desc, models }));
        } else {
          const conn = fetchPanel.connection();
          const models = await call(
            api.composeModels({
              url: conn.url,
              apiKey: conn.apiKey,
              vendor: conn.vendor,
              ids: fetchPanel.selectedIds(),
              flags: fetchPanel.flags(),
            }),
          );
          r = await call(api.createManual({ name, description: desc, models }));
        }
        closeModal();
        await reload(r.name);
        toast(
          'ok',
          `已创建源「${r.name}」`,
          activeMode === 'snapshot'
            ? `复制了 ${r.modelCount} 个模型，并设为当前源`
            : `${r.modelCount} 个模型，点「切换到此源」后生效`,
        );
      });
    }

    openModal({
      title: '新建源',
      body,
      wide: true,
      footer: [
        { label: '取消', className: 'btn btn-quiet', onClick: closeModal },
        { label: '创建', className: 'btn btn-primary', onClick: () => void save() },
      ],
    });
  }

  // ───────────────────────── 编辑源 ─────────────────────────

  function openEditModal() {
    const d = state.detail;
    if (!d) return;

    const body = document.createElement('div');
    body.innerHTML = `
      <div class="grid-2">
        <div class="form-row">
          <label class="form-label">源名称<span class="req">*</span></label>
          <input class="input" id="epName" value="${esc(d.name)}" maxlength="64" />
        </div>
        <div class="form-row">
          <label class="form-label">描述</label>
          <input class="input" id="epDesc" value="${esc(d.description)}" placeholder="可选" />
        </div>
      </div>
      <div class="edit-toolbar">
        <span class="form-hint">改动当前源会同时写入 models.json（写入前自动备份）。</span>
        <button class="btn btn-quiet btn-sm" id="epFetch" type="button">从网关追加模型</button>
      </div>`;

    const editor = buildEditor(d.models);
    body.appendChild(editor.el);

    // 「从网关追加模型」：复用新建源里的拉取面板，只取勾选的、且当前源里没有的
    let appendPanel = null;
    const appendHost = document.createElement('div');
    appendHost.className = 'append-host';
    appendHost.hidden = true;
    body.appendChild(appendHost);

    body.querySelector('#epFetch').onclick = () => {
      const btn = body.querySelector('#epFetch');
      if (!appendHost.hidden) {
        // 收起
        appendHost.hidden = true;
        appendPanel = null;
        appendHost.innerHTML = '';
        btn.textContent = '从网关追加模型';
        btn.classList.remove('on');
        return;
      }
      btn.textContent = '收起';
      btn.classList.add('on');
      appendHost.hidden = false;
      appendHost.innerHTML = '';

      const panel = buildFetchPanel();
      appendPanel = panel;
      appendHost.appendChild(panel.el);
      // 带入当前源的连接信息并自动拉取
      void (async () => {
        try {
          const s = await call(api.suggestConnection(d.name));
          if (!s) return;
          panel.fill(s);
          await panel.fetchNow();
        } catch {
          /* 让用户手填 */
        }
      })();
    };

    /** 把面板里勾选、且当前源还没有的模型追加进编辑器 */
    async function appendSelected() {
      if (!appendPanel) return { added: 0, skipped: 0 };
      const conn = appendPanel.connection();
      const ids = appendPanel.selectedIds();
      if (!conn.url) throw new Error('请先填写接口地址');
      if (!conn.apiKey) throw new Error('请先填写 API Key');
      if (!ids.length) throw new Error('请至少勾选一个模型');

      const existing = new Set(editor.getModels().map((m) => (m.id || '').trim()));
      const fresh = ids.filter((id) => !existing.has(id.trim()));
      if (!fresh.length) return { added: 0, skipped: ids.length };

      const models = await call(
        api.composeModels({
          url: conn.url,
          apiKey: conn.apiKey,
          vendor: conn.vendor,
          ids: fresh,
          flags: appendPanel.flags(),
        }),
      );
      editor.append(models);
      appendHost.hidden = true;
      appendHost.innerHTML = '';
      appendPanel = null;
      const btn = body.querySelector('#epFetch');
      btn.textContent = '从网关追加模型';
      btn.classList.remove('on');
      return { added: fresh.length, skipped: ids.length - fresh.length };
    }

    // 保存前若有展开的追加面板，先把它勾选的模型并进来
    async function save() {
      if (appendPanel && appendPanel.selectedIds().length) {
        try {
          const r = await appendSelected();
          if (r.added) toast('ok', `已追加 ${r.added} 个模型`, r.skipped ? `${r.skipped} 个已存在，已跳过` : '');
        } catch (err) {
          toast('err', err.message);
          return;
        }
      }
      await saveInner();
    }

    async function saveInner() {
      const name = body.querySelector('#epName').value.trim();
      const desc = body.querySelector('#epDesc').value.trim();
      if (!name) {
        toast('err', '请填写源名称');
        return;
      }
      const bad = validateModels(editor.getModels());
      if (bad) {
        toast('err', bad);
        return;
      }

      await guarded(async () => {
        let target = d.name;
        if (name.toLowerCase() !== d.name.toLowerCase()) {
          const r = await call(api.rename(d.name, name));
          target = r.to;
        }
        const r = await call(api.saveModels(target, editor.getModels(), desc));
        closeModal();
        await reload(target);
        toast(
          'ok',
          `已保存「${target}」`,
          r.synced ? '已同步写入 models.json' : `${r.modelCount} 个模型`,
        );
      });
    }

    openModal({
      title: '编辑源',
      body,
      wide: true,
      footer: [
        { label: '取消', className: 'btn btn-quiet', onClick: closeModal },
        { label: '保存', className: 'btn btn-primary', onClick: () => void save() },
      ],
    });
  }

  // ───────────────────────── 视图切换 ─────────────────────────

  function setView(view) {
    state.view = view;
    for (const v of ['sources', 'backups', 'doctor']) {
      $(`#view-${v}`).hidden = v !== view;
    }
    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.view === view);
    });
    if (view === 'backups') void loadBackups();
    if (view === 'doctor') void loadDoctor();
  }

  // ───────────────────────── 事件绑定 ─────────────────────────

  function bind() {
    $('#btnNew').onclick = () => openNewModal('template');
    $('#btnSnapshot').onclick = () => openNewModal('snapshot');
    $('#emptySnapshot').onclick = () => openNewModal('snapshot');
    $('#emptyNew').onclick = () => openNewModal('template');

    document.querySelectorAll('.tab-btn').forEach((b) => {
      b.onclick = () => setView(b.dataset.view);
    });

    $('#btnSwitch').onclick = () => {
      if (state.detail) void doSwitch(state.detail.name);
    };
    $('#btnEdit').onclick = () => openEditModal();
    $('#btnDiff').onclick = () => openDiffModal();
    $('#btnExport').onclick = () => void doExport();
    $('#btnDelete').onclick = () => void doDelete();

    $('#btnRefreshBackups').onclick = () => void loadBackups();
    $('#btnOpenBackups').onclick = () => {
      void call(api.reveal(state.overview.backupsPath)).catch(reportError);
    };
    $('#btnRerunDoctor').onclick = () => void loadDoctor();
    $('#btnOpenRoot').onclick = () => {
      void call(api.reveal(state.overview.configRoot)).catch(reportError);
    };

    $('#modalClose').onclick = closeModal;
    $('#overlay').addEventListener('mousedown', (e) => {
      if (e.target.id === 'overlay') closeModal();
    });
    document.addEventListener('keydown', (e) => {
      // 弹窗打开时只处理 Esc
      if (!$('#overlay').hidden) {
        if (e.key === 'Escape') closeModal();
        return;
      }
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      // Ctrl+N 新建源
      if (mod && key === 'n') { e.preventDefault(); openNewModal('template'); return; }
      // Ctrl+S 切换到当前选中的源
      if (mod && key === 's') { e.preventDefault(); if (state.detail) void doSwitch(state.detail.name); return; }
      // Ctrl+E 编辑当前选中的源
      if (mod && key === 'e') { e.preventDefault(); openEditModal(); return; }
      // Ctrl+I 导入（打开文件选择）
      if (mod && key === 'i') { e.preventDefault(); void doImport(); return; }
      // Ctrl+R / F5 刷新
      if ((mod && key === 'r') || e.key === 'F5') { e.preventDefault(); void reload(state.detail?.name); return; }
      // Delete 删除当前选中的源
      if (e.key === 'Delete') { if (state.detail) void doDelete(); return; }
      // Ctrl+F 聚焦搜索（如果源列表有搜索框则聚焦，否则快速跳转第一个匹配的源）
      if (mod && key === 'f') { e.preventDefault(); focusSidebarSearch(); return; }
      // F2 重命名当前选中的源
      if (e.key === 'F2') { if (state.detail) void openRenameModal(); return; }
    });

    // ── 代理设置 ──
    $('#btnProxy').onclick = () => openProxyModal();

    // ── 协议转换代理 ──
    $('#btnProtocol').onclick = () => void toggleProtocolProxy();

    // ── 主题切换 ──
    $('#btnTheme').onclick = () => toggleTheme();

    // ── 托盘切源后自动刷新 ──
    if (api.onTraySwitched) {
      api.onTraySwitched((name) => {
        void guarded(async () => {
          await reload(name);
          toast('ok', `已从托盘切换到「${name}」`);
          if (api.refreshTray) api.refreshTray();
        });
      });
    }

    // ── 批量操作 ──
    $('#batchDelete').onclick = () => void batchDelete();
    $('#batchExport').onclick = () => void batchExport();
    $('#batchClear').onclick = () => { state.selected.clear(); renderSidebar(); };

    window.addEventListener('error', (e) => console.error('renderer error', e.error || e.message));

    // ── 拖拽导入 JSON 文件 ──
    // 把 .json 文件拖到窗口上：如果 models.json 格式（数组）→ 直接导入为新源
    const dropZone = document.querySelector('.app');
    dropZone.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types?.includes('Files')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        dropZone.classList.add('drag-active');
      }
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-active');
    });
    dropZone.addEventListener('drop', (e) => {
      dropZone.classList.remove('drag-active');
      if (!e.dataTransfer?.files?.length) return;
      const file = [...e.dataTransfer.files].find((f) => f.name.endsWith('.json'));
      if (!file) return;
      e.preventDefault();
      void handleDropImport(file);
    });

    async function handleDropImport(file) {
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!Array.isArray(data)) {
          toast('err', '拖入的文件不是 models.json 格式', '需要是模型条目数组');
          return;
        }
        if (!data.length) {
          toast('err', '文件为空', '没有模型条目');
          return;
        }
        const baseName = file.name.replace(/\.json$/i, '');
        // 弹出导入确认
        const box = document.createElement('div');
        box.innerHTML =
          `<p class="confirm-msg">文件 <b>${esc(file.name)}</b> 包含 ${data.length} 个模型，导入为新源：</p>` +
          `<div class="form-row" style="margin-top:10px"><label class="form-label">源名称</label>` +
          `<input class="input" id="dropName" value="${esc(baseName)}" maxlength="64" /></div>`;
        openModal({
          title: '导入模型配置',
          body: box,
          footer: [
            { label: '取消', className: 'btn btn-quiet', onClick: closeModal },
            {
              label: '导入',
              className: 'btn btn-primary',
              onClick: () => {
                const name = box.querySelector('#dropName').value.trim();
                if (!name) { toast('err', '请填写源名称'); return; }
                void (async () => {
                  await guarded(async () => {
                    // 走 IPC 写文件再导入
                    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
                    const buf = Buffer !== undefined ? null : null; // renderer 没有 Buffer
                    // 用 API 传 JSON 字符串，主进程写临时文件
                    const r = await call(api.importJson(JSON.stringify(data), name));
                    closeModal();
                    await reload(r.name);
                    toast('ok', `已导入「${r.name}」`, `${r.modelCount} 个模型`);
                  });
                })();
              },
            },
          ],
        });
      } catch (err) {
        toast('err', '解析失败', err?.message || String(err));
      }
    }
  }

  // ───────────────────────── 代理设置 ─────────────────────────

  function updateProxyLabel() {
    const btn = $('#btnProxy');
    if (!btn) return;
    if (state.proxy) {
      btn.textContent = '代理: ' + state.proxy.replace(/^https?:\/\//, '').slice(0, 24);
      btn.classList.add('on');
    } else {
      btn.textContent = '代理: 自动';
      btn.classList.remove('on');
    }
  }

  function openProxyModal() {
    const box = document.createElement('div');
    box.innerHTML = `
      <div class="form-hint" style="margin-bottom:10px">
        设置 HTTP/HTTPS 代理后，获取模型列表的请求会走代理。<br>
        留空 = 自动读取系统环境变量 HTTP_PROXY / HTTPS_PROXY。<br>
        支持 http、https、socks5 协议。
      </div>
      <div class="form-row">
        <label class="form-label">代理地址</label>
        <input class="input mono" id="proxyInput" value="${esc(state.proxy)}"
          placeholder="http://127.0.0.1:7890（留空=自动）" spellcheck="false" />
      </div>
      <div class="form-row">
        <label class="form-label">快速设置</label>
        <div class="proxy-presets">
          <button class="btn btn-quiet btn-sm" data-proxy="">自动（环境变量）</button>
          <button class="btn btn-quiet btn-sm" data-proxy="http://127.0.0.1:7890">Clash 7890</button>
          <button class="btn btn-quiet btn-sm" data-proxy="http://127.0.0.1:1080">SOCKS 1080</button>
          <button class="btn btn-quiet btn-sm" data-proxy="http://127.0.0.1:10809">V2Ray 10809</button>
        </div>
      </div>`;
    openModal({
      title: '代理设置',
      body: box,
      footer: [
        { label: '取消', className: 'btn btn-quiet', onClick: closeModal },
        {
          label: '保存',
          className: 'btn btn-primary',
          onClick: () => {
            state.proxy = box.querySelector('#proxyInput').value.trim();
            updateProxyLabel();
            closeModal();
            toast('ok', state.proxy ? '代理已设为 ' + state.proxy : '已恢复自动代理（环境变量）');
          },
        },
      ],
    });
    const input = box.querySelector('#proxyInput');
    setTimeout(() => input.focus(), 30);
    box.querySelectorAll('[data-proxy]').forEach((b) => {
      b.onclick = () => { input.value = b.dataset.proxy; };
    });
  }

  // ───────────────────────── 协议转换代理 ─────────────────────────

  /** 切换协议代理：未开则启动，已开则停止 */
  async function toggleProtocolProxy() {
    const btn = $('#btnProtocol');
    const status = await call(api.proxyStatus());
    if (status?.running) {
      // 停止
      await call(api.proxyStop());
      updateProtocolBtn({ running: false, port: 0, models: [] });
      toast('ok', '协议代理已停止');
    } else {
      // 启动
      const r = await call(api.proxyStart(state.proxy || undefined));
      if (!r) {
        toast('info', '当前没有需要协议转换的模型',
          'Anthropic 和 Gemini 原生 API 需要转换，OpenAI 兼容端点不需要');
        return;
      }
      updateProtocolBtn({ running: true, port: r.port, models: r.needsProxy });
      toast('ok', `协议代理已启动（端口 ${r.port}）`,
        `${r.needsProxy.length} 个模型通过代理转换：${r.needsProxy.join(', ')}`);
    }
  }

  function updateProtocolBtn(status) {
    const btn = $('#btnProtocol');
    if (!btn) return;
    if (status.running) {
      btn.textContent = '协议: 开 ' + status.port;
      btn.classList.add('on');
      btn.title = `协议转换代理运行中（端口 ${status.port}）\n代理模型：${status.models.join(', ')}\n点击停止`;
    } else {
      btn.textContent = '协议: 关';
      btn.classList.remove('on');
      btn.title = '启动协议转换代理（Anthropic/Gemini 原生 API → OpenAI 格式）';
    }
  }

  // ───────────────────────── 主题切换 ─────────────────────────

  /** 三档循环：自动 → 亮色 → 暗色 → 自动 */
  function getTheme() {
    return document.documentElement.dataset.theme || 'auto';
  }

  function setTheme(theme) {
    if (theme === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    // 持久化
    try { localStorage.setItem('wb-theme', theme); } catch { /* 无 localStorage 时忽略 */ }
    updateThemeBtn();
  }

  function updateThemeBtn() {
    const btn = $('#btnTheme');
    if (!btn) return;
    const t = getTheme();
    btn.textContent = t === 'dark' ? '☾' : t === 'light' ? '☀' : '◐';
    btn.title = t === 'dark' ? '暗色（点击切到自动）' : t === 'light' ? '亮色（点击切到暗色）' : '自动（点击切到亮色）';
  }

  function toggleTheme() {
    const t = getTheme();
    setTheme(t === 'auto' ? 'light' : t === 'light' ? 'dark' : 'auto');
  }

  // ───────────────────────── 启动 ─────────────────────────

  async function boot() {
    bind();
    updateProxyLabel();
    updateProtocolBtn({ running: false, port: 0, models: [] });
    // 恢复上次的主题
    try { setTheme(localStorage.getItem('wb-theme') || 'auto'); } catch { /* 忽略 */ }
    try {
      await reload();
      setView('sources');
      if (!state.overview.rootExists) {
        toast('err', 'WorkBuddy 配置目录不存在', state.overview.configRoot);
      }
    } catch (err) {
      reportError(err);
    }
  }

  void boot();
})();
