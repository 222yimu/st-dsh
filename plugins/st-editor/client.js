/**
 * st-editor — 界面侧：DSH 设置页「角色卡与设定」入口。
 *
 * 手写 ModuleLoader bundle（和 sage-mem 的界面侧同款格式）：
 *   window.__ModuleLoader__.load({ id, factory }) → factory 内 require('react') 可用，
 *   module.exports 导出标准 Cordis 插件（apply/inject）。
 *
 * 挂载点：ctx.slots.inject("settings.section") —— 和 sage-mem 的「记忆管理」同一个槽。
 *   （之前挂在 "shell.overlay" 上，那个槽在本版 DSH 不生效，所以按钮一直没出现。）
 *
 * 数据通道：同源 HTTP /st-editor?op=...（宿主侧插件注册，读写 st-lite 的 data 目录）。
 */

window.__ModuleLoader__.load({
  id: "st-editor",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useCallback, useRef } = react;

    const ENDPOINT = "/st-editor";

    const CSS = [
      ".ste-root{display:flex;flex-direction:column;gap:10px;font:13px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;color:#22314f}",
      ".ste-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
      ".ste-bar .grow{flex:1}",
      ".ste-btn{cursor:pointer;border:1px solid #c9d6f2;background:#fff;color:#22314f;border-radius:7px;padding:5px 11px;font:12.5px system-ui,sans-serif}",
      ".ste-btn.primary{background:#526aa8;border-color:#526aa8;color:#fff}",
      ".ste-btn.on{background:#526aa8;color:#fff;border-color:#526aa8}",
      ".ste-btn:disabled{opacity:.45;cursor:default}",
      ".ste-body{display:flex;gap:14px;align-items:flex-start;min-height:420px}",
      ".ste-list{width:190px;flex:0 0 190px;border:1px solid #dbe3f4;border-radius:10px;background:#fafbfe;padding:6px;max-height:60vh;overflow:auto}",
      ".ste-item{padding:7px 9px;border-radius:8px;cursor:pointer;border:1px solid transparent;margin-bottom:2px}",
      ".ste-item.on{background:#eef2fc;border-color:#c9d6f2}",
      ".ste-item small{display:block;color:#65708a;font-size:11px}",
      ".ste-form{flex:1;min-width:0;max-height:60vh;overflow:auto;padding-right:4px}",
      ".ste-tabs{display:flex;gap:6px;margin-bottom:10px}",
      ".ste-field{margin-bottom:11px}",
      ".ste-label{display:block;font-size:12px;color:#65708a;margin-bottom:4px}",
      ".ste-hint{font-size:11px;color:#65708a;margin-top:3px;opacity:.9}",
      ".ste-input,.ste-area{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #dbe3f4;border-radius:8px;font:13px/1.55 system-ui,sans-serif;color:#22314f;background:#fff}",
      ".ste-area{resize:vertical}",
      ".ste-entry{border:1px solid #dbe3f4;border-radius:10px;padding:10px;margin-bottom:10px;background:#fcfdff}",
      ".ste-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".ste-row .grow{flex:1}",
      ".ste-mini{cursor:pointer;border:1px solid #dbe3f4;background:#fff;border-radius:6px;padding:3px 9px;font:11.5px system-ui,sans-serif;color:#65708a}",
      ".ste-stat{font-size:11.5px;color:#65708a}",
      ".ste-ok{color:#2f7d4f}.ste-err{color:#c0392b}",
    ].join("\n");

    function injectCss() {
      try {
        const tagId = "st-editor/settings.css";
        if (typeof document !== "undefined" && !document.querySelector('style[data-plugin-css="' + tagId + '"]')) {
          const tag = document.createElement("style");
          tag.dataset.plugin = "st-editor";
          tag.dataset.pluginCss = tagId;
          tag.textContent = CSS;
          document.head.appendChild(tag);
        }
      } catch { /* ignore */ }
    }

    async function apiGet(op, id) {
      const qs = "?op=" + encodeURIComponent(op) + (id ? "&id=" + encodeURIComponent(id) : "");
      const res = await fetch(ENDPOINT + qs, { cache: "no-store", credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data && data.error) || "HTTP " + res.status);
      return data;
    }

    async function apiPost(op, body) {
      const res = await fetch(ENDPOINT + "?op=" + encodeURIComponent(op), {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error((data && data.error) || "HTTP " + res.status);
      return data;
    }

    const FIELDS = [
      { key: "name", label: "名字", rows: 1 },
      { key: "description", label: "身份与外貌（description）", rows: 5, hint: "客观描述：是谁、长什么样、和你什么关系。别写行为指令。" },
      { key: "personality", label: "性格（personality）", rows: 4, hint: "怎么反应：性格、说话习惯、小癖好。" },
      { key: "scenario", label: "场景（scenario）", rows: 2 },
      { key: "first_mes", label: "开场白（first_mes）", rows: 3 },
      { key: "mes_example", label: "对话示例（mes_example）", rows: 4, hint: "「用户：… / 角色：…」写一两组，用来定语气。" },
      { key: "system", label: "扮演规则（system）", rows: 4, hint: "怎么演：第一人称、不跳出角色、动作标记、语言。" },
      { key: "post_history", label: "作者注（post_history）", rows: 3, hint: "绝不能忘的：称呼、禁忌、底线。" },
      { key: "world", label: "世界书 id（world）", rows: 1, hint: "留空则与卡 id 相同。" },
      { key: "tags", label: "标签（逗号分隔）", rows: 1 },
    ];

    function Field(props) {
      const rows = props.rows || 1;
      const common = {
        className: rows > 1 ? "ste-area" : "ste-input",
        value: props.value == null ? "" : props.value,
        onChange: (e) => props.onChange(e.target.value),
      };
      return h(
        "div",
        { className: "ste-field" },
        h("label", { className: "ste-label" }, props.label),
        rows > 1 ? h("textarea", Object.assign({ rows }, common)) : h("input", common),
        props.hint ? h("div", { className: "ste-hint" }, props.hint) : null,
      );
    }

    function Section() {
      const [cards, setCards] = useState([]);
      const [active, setActive] = useState("");
      const [selId, setSelId] = useState("");
      const [card, setCard] = useState(null);
      const [world, setWorld] = useState(null);
      const [stats, setStats] = useState(null);
      const [tab, setTab] = useState("card");
      const [busy, setBusy] = useState(false);
      const [msg, setMsg] = useState("");
      const [msgKind, setMsgKind] = useState("ok");
      const [chat, setChat] = useState(null);
      const [editing, setEditing] = useState(null);
      const [sampling, setSampling] = useState(null);
      const fileRef = useRef(null);
      const pendingKind = useRef("card");

      const say = (text, kind) => { setMsg(text || ""); setMsgKind(kind || "ok"); };

      const loadList = useCallback(async () => {
        try {
          const data = await apiGet("list");
          setCards(data.cards || []);
          setActive(data.active || "");
          return data.cards || [];
        } catch (e) {
          say("读取列表失败：" + e.message, "err");
          return [];
        }
      }, []);

      const loadCard = useCallback(async (id) => {
        if (!id) return;
        setBusy(true);
        try {
          const data = await apiGet("card", id);
          setSelId(id);
          setCard(data.card);
          setWorld(data.world);
          setStats(data.stats);
          say("");
        } catch (e) {
          say("读取失败：" + e.message, "err");
        } finally {
          setBusy(false);
        }
      }, []);

      useEffect(() => {
        loadList().then((list) => {
          if (list.length) loadCard(list[0].id);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const setCardField = (key, value) => setCard((prev) => Object.assign({}, prev, { [key]: value }));

      const setEntry = (index, patch) =>
        setWorld((prev) => {
          const entries = (prev.entries || []).slice();
          entries[index] = Object.assign({}, entries[index], patch);
          return Object.assign({}, prev, { entries });
        });

      const addEntry = () =>
        setWorld((prev) => {
          const entries = (prev.entries || []).slice();
          let max = 0;
          for (const entry of entries) {
            const m = /^e(\d+)$/.exec(String(entry.id || ""));
            if (m) max = Math.max(max, Number(m[1]));
          }
          entries.push({ id: "e" + (max + 1), keys: [], content: "", priority: 5, constant: false });
          return Object.assign({}, prev, { entries });
        });

      const removeEntry = (index) =>
        setWorld((prev) => {
          const entries = (prev.entries || []).slice();
          entries.splice(index, 1);
          return Object.assign({}, prev, { entries });
        });

      const save = async () => {
        if (!card) return;
        setBusy(true);
        try {
          const payload = Object.assign({}, card, {
            tags: String(card.tags && card.tags.join ? card.tags.join(",") : card.tags || "")
              .split(/[,，]/).map((t) => t.trim()).filter(Boolean),
          });
          const cardRes = await apiPost("card", { card: payload });
          setCard(cardRes.card);
          if (cardRes.stats) setStats(cardRes.stats);
          const worldPayload = {
            id: (cardRes.card && cardRes.card.world) || card.id,
            name: (world && world.name) || "",
            entries: ((world && world.entries) || []).map((entry) => Object.assign({}, entry)),
          };
          const worldRes = await apiPost("world", { world: worldPayload });
          setWorld(worldRes.world);
          if (worldRes.stats) setStats(worldRes.stats);
          say("已保存（写盘前自动备份 .bak）");
          await loadList();
        } catch (e) {
          say("保存失败：" + e.message, "err");
        } finally {
          setBusy(false);
        }
      };

      // 切换「当前角色卡」：新开对话就用这张
      const setAsActive = async () => {
        if (!card) return;
        setBusy(true);
        try {
          const res = await apiPost("active", { id: card.id });
          setActive(res.active || card.id);
          say("当前角色卡：" + (res.active || card.id) + "（新开对话就用这张）");
          await loadList();
        } catch (e) {
          say("切换失败：" + e.message, "err");
        } finally {
          setBusy(false);
        }
      };

      const newCard = () => {        const id = "card-" + Date.now().toString(36).slice(-4);
        setCard({
          id, name: "新角色", description: "", personality: "", scenario: "",
          first_mes: "", mes_example: "", system: "", post_history: "", world: id, tags: [],
        });
        setWorld({ id, name: id, entries: [] });
        setSelId("");
        setStats(null);
        setTab("card");
        say("新卡（改完点保存才落盘）");
      };

      // ── 聊天：消息级操作 / 分支 / 导出 ──
      const loadChat = async () => {
        try {
          const data = await apiGet("chat", (card && card.id) || selId || "");
          setChat(data);
        } catch (e) {
          say("读取聊天失败：" + e.message, "err");
        }
        try {
          const smp = await apiGet("sampling");
          setSampling((smp && smp.sampling) || null);
        } catch (e) {
          /* 采样配置读不到不影响聊天 */
        }
      };

      const saveSampling = async (patch) => {
        try {
          const base = sampling || {};
          const data = await apiPost("sampling", {
            sampling: Object.assign({
              default: base.default ?? null,
              normal: base.normal ?? null,
              roleplay: base.roleplay ?? null,
              sessions: base.sessions || {},
            }, patch),
          });
          setSampling(data.sampling);
          say("采样温度已保存（重启 DSH 后由 st-temp 生效）");
        } catch (e) {
          say("保存温度失败：" + e.message, "err");
        }
      };

      const chatAction = async (action, payload) => {
        setBusy(true);
        try {
          const data = await apiPost("chat", Object.assign({ card: (card && card.id) || selId, action }, payload || {}));
          setChat(data);
          setEditing(null);
          const label = {
            delete: "删除", edit: "修改", truncate: "截断", regenerate: "重生成",
            "branch-create": "新建分支", "branch-switch": "切换分支", "branch-delete": "删除分支",
          }[action] || action;
          say("已" + label);
          loadList();
        } catch (e) {
          say("操作失败：" + e.message, "err");
        } finally {
          setBusy(false);
        }
      };

      const exportChat = async () => {
        try {
          const data = await apiGet("export-chat", (card && card.id) || selId);
          const blob = new Blob([data.text || ""], { type: "application/x-ndjson" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = data.filename || "chat.jsonl";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          say("已导出 " + (data.filename || "") + "（" + data.turns + " 条，酒馆格式）");
        } catch (e) {
          say("导出失败：" + e.message, "err");
        }
      };

      const doExport = async (kind) => {
        try {
          const targetId = kind === "card"
            ? (card && card.id)
            : ((world && world.id) || (card && card.world) || (card && card.id));
          const data = await apiGet(kind === "card" ? "export-card" : "export-world", targetId);
          const blob = new Blob([JSON.stringify(data.file, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = data.filename || kind + ".json";
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
          say("已导出 " + (data.filename || kind + ".json") + "（酒馆格式）");
        } catch (e) {
          say("导出失败：" + e.message, "err");
        }
      };

      const pickFile = (kind) => {
        pendingKind.current = kind;
        if (fileRef.current) { fileRef.current.value = ""; fileRef.current.click(); }
      };

      const onFile = async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        setBusy(true);
        try {
          const raw = JSON.parse(await file.text());
          if (pendingKind.current === "card") {
            const res = await apiPost("import-card", { raw });
            say("已导入卡 " + res.id + (res.importedBook ? "（含内嵌世界书）" : ""));
            await loadList();
            await loadCard(res.id);
          } else {
            const res = await apiPost("import-world", {
              raw,
              id: (world && world.id) || (card && card.world) || (card && card.id),
            });
            setWorld(res.world);
            if (res.stats) setStats(res.stats);
            say("已导入世界书（" + ((res.world.entries || []).length) + " 条）");
            await loadList();
          }
        } catch (e) {
          say("导入失败：" + e.message, "err");
        } finally {
          setBusy(false);
        }
      };

      const tagText = card ? (card.tags && card.tags.join ? card.tags.join(", ") : String(card.tags || "")) : "";

      const btn = (label, onClick, opts) =>
        h("button", {
          key: label,
          className: "ste-btn" + (opts && opts.primary ? " primary" : "") + (opts && opts.on ? " on" : ""),
          disabled: busy || (opts && opts.disabled),
          onClick,
        }, label);

      return h(
        "div",
        { className: "ste-root" },
        h(
          "div",
          { className: "ste-bar" },
          btn("保存", save, { primary: true, disabled: !card }),
          btn("设为当前", setAsActive, { disabled: !card || !!(card && active === card.id) }),
          btn("新建卡", newCard),
          btn("导入卡", () => pickFile("card")),
          btn("导出卡", () => doExport("card"), { disabled: !card }),
          btn("导入书", () => pickFile("world"), { disabled: !card }),
          btn("导出书", () => doExport("world"), { disabled: !card }),
          btn("刷新", () => { loadList(); }),
          h("input", {
            key: "file",
            ref: fileRef, type: "file", accept: ".json,application/json",
            style: { display: "none" }, onChange: onFile,
          }),
          h("span", { className: "grow" }),
          h("span", { className: "ste-stat" },
            stats
              ? "固定开销 " + (stats.head + stats.constant) + " token · 常驻 " + stats.constantEntries + " 条 · 剩余约还能放 " + stats.turnsRoom + " 轮"
              : ""),
          msg ? h("span", { className: msgKind === "err" ? "ste-err" : "ste-ok" }, msg) : null,
        ),
        h(
          "div",
          { className: "ste-body" },
          h(
            "div",
            { className: "ste-list" },
            cards.length === 0 ? h("div", { className: "ste-hint" }, "还没有角色卡") : null,
            cards.map((item) =>
              h("div", {
                key: item.id,
                className: "ste-item" + (selId === item.id ? " on" : ""),
                onClick: () => loadCard(item.id),
                title: item.id,
              },
                h("div", null, (item.id === active ? "● " : "") + (item.name || item.id)),
                h("small", null, (item.turns || 0) + " 轮 · " + item.id),
              )),
          ),
          h(
            "div",
            { className: "ste-form" },
            !card
              ? h("div", { className: "ste-hint" }, "左边选一张卡，或点「新建卡」")
              : h("div", null,
                  h("div", { className: "ste-tabs" },
                    btn("角色卡", () => setTab("card"), { on: tab === "card" }),
                    btn("世界书", () => setTab("world"), { on: tab === "world" }),
                    btn("聊天", () => { setTab("chat"); loadChat(); }, { on: tab === "chat" }),
                  ),
                  tab === "card"
                    ? h("div", null,
                        h(Field, { label: "id（文件名，改这个等于另存）", rows: 1, value: card.id, onChange: (v) => setCardField("id", v) }),
                        FIELDS.map((f) => h(Field, {
                          key: f.key, label: f.label, hint: f.hint, rows: f.rows,
                          value: f.key === "tags" ? tagText : card[f.key],
                          onChange: (v) => setCardField(f.key, v),
                        })),
                      )
                    : tab === "world"
                      ? h("div", null,
                        h("div", { className: "ste-hint" }, "命中的关键词才进上下文；constant 勾上就是每轮都带（建议 ≤3 条）。"),
                        ((world && world.entries) || []).map((entry, index) =>
                          h("div", { key: entry.id || index, className: "ste-entry" },
                            h("div", { className: "ste-row" },
                              h("span", { className: "ste-hint" }, entry.id),
                              h("span", { className: "grow" }),
                              h("label", { className: "ste-hint" },
                                h("input", {
                                  type: "checkbox", checked: !!entry.constant,
                                  onChange: (e) => setEntry(index, { constant: e.target.checked }),
                                }), " 常驻"),
                              h("label", { className: "ste-hint" },
                                h("input", {
                                  type: "checkbox", checked: !!entry.disabled,
                                  onChange: (e) => setEntry(index, { disabled: e.target.checked }),
                                }), " 停用"),
                              h("button", { className: "ste-mini", onClick: () => removeEntry(index) }, "删除"),
                            ),
                            h(Field, {
                              label: "关键词（逗号分隔）", rows: 1,
                              value: Array.isArray(entry.keys) ? entry.keys.join(", ") : String(entry.keys || ""),
                              onChange: (v) => setEntry(index, { keys: v.split(/[,，]/).map((k) => k.trim()).filter(Boolean) }),
                              hint: "2~4 个；用你真会说的词，别用单字。",
                            }),
                            h(Field, {
                              label: "次级关键词（逗号分隔，可空）", rows: 1,
                              value: Array.isArray(entry.keysecondary) ? entry.keysecondary.join(", ") : String(entry.keysecondary || ""),
                              onChange: (v) => setEntry(index, { keysecondary: v.split(/[,，]/).map((k) => k.trim()).filter(Boolean) }),
                              hint: "填了就是「主关键词命中后还要命中它」。上面的词也提到才会注入。",
                            }),
                            h(Field, {
                              label: "插入位置（0 设定前 / 1 设定后 / 4 对话内）", rows: 1,
                              value: String(entry.position == null ? 0 : entry.position),
                              onChange: (v) => setEntry(index, { position: Number(v) || 0 }),
                              hint: "0=放在角色设定前（默认），1=放在角色设定后，4=按深度插进最近对话里。",
                            }),
                            h(Field, {
                              label: "深度 depth（仅位置=4 时用）", rows: 1,
                              value: String(entry.depth == null ? 4 : entry.depth),
                              onChange: (v) => setEntry(index, { depth: Number(v) || 0 }),
                              hint: "从最新一条消息往上数第几条插入，越小越靠后。",
                            }),
                            h(Field, {
                              label: "激活概率 probability（100 = 必中）", rows: 1,
                              value: String(entry.probability == null ? 100 : entry.probability),
                              onChange: (v) => setEntry(index, { probability: Number(v) || 0 }),
                              hint: "命中关键词后再掷一次骰子（酒馆的 useProbability）。",
                            }),
                            h("div", { className: "ste-field" },
                              h("label", { className: "ste-label" }, "匹配方式"),
                              h("select", {
                                className: "ste-input",
                                value: entry.caseSensitive === true ? "1" : entry.caseSensitive === false ? "0" : "",
                                onChange: (e) => setEntry(index, { caseSensitive: e.target.value === "" ? null : e.target.value === "1" }),
                              },
                                h("option", { value: "" }, "大小写：默认（不区分）"),
                                h("option", { value: "1" }, "大小写：区分"),
                                h("option", { value: "0" }, "大小写：强制不区分")),
                              h("select", {
                                className: "ste-input",
                                style: { marginTop: "4px" },
                                value: entry.matchWholeWords === true ? "1" : entry.matchWholeWords === false ? "0" : "",
                                onChange: (e) => setEntry(index, { matchWholeWords: e.target.value === "" ? null : e.target.value === "1" }),
                              },
                                h("option", { value: "" }, "匹配：默认（子串）"),
                                h("option", { value: "1" }, "匹配：整词"),
                                h("option", { value: "0" }, "匹配：强制子串")),
                              h("label", { className: "ste-hint", style: { marginTop: "6px" } },
                                h("input", {
                                  type: "checkbox", checked: !!entry.excludeRecursion,
                                  onChange: (e) => setEntry(index, { excludeRecursion: e.target.checked }),
                                }), " 不参与递归扫描（只由本轮输入触发）"),
                              h("label", { className: "ste-hint" },
                                h("input", {
                                  type: "checkbox", checked: !!entry.preventRecursion,
                                  onChange: (e) => setEntry(index, { preventRecursion: e.target.checked }),
                                }), " 命中后不再用它的正文去触发别人"),
                            ),
                            h(Field, {
                              label: "内容", rows: 3, value: entry.content,
                              onChange: (v) => setEntry(index, { content: v }),
                            }),
                            h(Field, {
                              label: "优先级 priority", rows: 1,
                              value: String(entry.priority == null ? 5 : entry.priority),
                              onChange: (v) => setEntry(index, { priority: Number(v) || 0 }),
                              hint: "命中多条时按优先级从高到低拼：铁律 10 / 关系 8 / 偏好 5 / 冷知识 1~3。",
                            }),
                          )),
                        btn("＋ 新增条目", addEntry),
                      )
                      : h("div", null,
                        h("div", { className: "ste-row" },
                          h("span", { className: "ste-hint" }, "采样温度"),
                          h("input", {
                            className: "ste-input",
                            type: "number", step: "0.05", min: "0", max: "2",
                            style: { width: "90px" },
                            placeholder: "不改",
                            value: sampling && sampling.roleplay != null ? String(sampling.roleplay) : "",
                            onChange: (e) => setSampling(Object.assign({ default: null, normal: null, sessions: {} }, sampling || {}, { roleplay: e.target.value === "" ? null : Number(e.target.value) })),
                          }),
                          btn("保存温度", () => saveSampling({ roleplay: sampling ? sampling.roleplay : null })),
                          h("span", { className: "ste-hint" }, "扮演模式用；空 = 不改。低=贴设定、高=灵活"),
                        ),
                        h("div", { className: "ste-row" },
                          h("span", { className: "ste-hint" }, "分支"),
                          h("select", {
                            className: "ste-input",
                            style: { width: "170px" },
                            value: (chat && chat.branch) || "",
                            onChange: (e) => chatAction("branch-switch", { name: e.target.value }),
                          }, ((chat && chat.branches) || [{ name: "", turns: 0 }]).map((b) =>
                            h("option", { key: b.name || "main", value: b.name }, (b.name || "主线") + "（" + b.turns + "）"))),
                          btn("新建分支", () => {
                            const name = typeof window !== "undefined" && window.prompt ? window.prompt("分支名（例如 if线）") : "";
                            if (name) chatAction("branch-create", { name });
                          }),
                          btn("删除当前分支", () => {
                            if (chat && chat.branch) chatAction("branch-delete", { name: chat.branch });
                            else say("主线不能删", "err");
                          }),
                          btn("导出聊天", exportChat),
                          btn("存快照", async () => {
                            try {
                              const label = typeof window !== "undefined" && window.prompt ? window.prompt("快照备注（可留空）") : "";
                              const data = await apiPost("checkpoint", { card: (card && card.id) || selId, action: "save", label: label || "" });
                              say("已存快照 " + data.saved + "（" + data.turns + " 条）");
                            } catch (e) { say("存快照失败：" + e.message, "err"); }
                          }),
                          btn("恢复最新快照", async () => {
                            try {
                              const list = await apiGet("checkpoint", (card && card.id) || selId);
                              const newest = (list.checkpoints || [])[0];
                              if (!newest) { say("还没有快照", "err"); return; }
                              const data = await apiPost("checkpoint", { card: (card && card.id) || selId, action: "restore", name: newest.name });
                              setChat(data);
                              say("已恢复到 " + newest.name + "（" + data.turns + " 条）");
                            } catch (e) { say("恢复失败：" + e.message, "err"); }
                          }),
                          btn("刷新", loadChat),
                        ),
                        h("div", { className: "ste-hint" },
                          "共 " + ((chat && chat.total) || 0) + " 条，显示最近 50 条。删除/截断会写盘（自动 .bak），改完记得让我重新演。"),
                        ((chat && chat.turns) || []).map((t) =>
                          h("div", { key: t.index, className: "ste-entry" },
                            h("div", { className: "ste-row" },
                              h("span", { className: "ste-hint" },
                                "#" + t.index + " " + (t.role === "user" ? "用户" : "角色")
                                + (t.versions > 1 ? "  v" + ((t.swipeId || 0) + 1) + "/" + t.versions : "")),
                              h("span", { className: "grow" }),
                              t.versions > 1 ? h("button", { className: "ste-mini", onClick: () => chatAction("swipe", { index: t.index, to: "prev" }) }, "◀") : null,
                              t.versions > 1 ? h("button", { className: "ste-mini", onClick: () => chatAction("swipe", { index: t.index, to: "next" }) }, "▶") : null,
                              h("button", { className: "ste-mini", onClick: () => setEditing({ index: t.index, text: t.text }) }, "编辑"),
                              h("button", { className: "ste-mini", onClick: () => chatAction("delete", { index: t.index }) }, "删除"),
                              h("button", { className: "ste-mini", onClick: () => chatAction("truncate", { index: t.index }) }, "截断到此"),
                            ),
                            h("div", { style: { whiteSpace: "pre-wrap", fontSize: "12.5px", marginTop: "4px" } },
                              String(t.text || "").length > 400 ? String(t.text).slice(0, 400) + "…" : t.text),
                          )),
                        chat && !chat.turns.length ? h("div", { className: "ste-hint" }, "这个分支还没有对话") : null,
                        editing
                          ? h("div", { className: "ste-entry" },
                              h(Field, {
                                label: "编辑第 #" + editing.index + " 条", rows: 4, value: editing.text,
                                onChange: (v) => setEditing(Object.assign({}, editing, { text: v })),
                              }),
                              h("div", { className: "ste-row" },
                                btn("保存修改", () => chatAction("edit", { index: editing.index, text: editing.text }), { primary: true }),
                                btn("取消", () => setEditing(null)),
                              ),
                            )
                          : null,
                        h("div", { className: "ste-row" },
                          btn("重说最后一条（保留旧版）", () => chatAction("regenerate")),
                          btn("删掉最后一条", () => chatAction("drop-last")),
                        ),
                      ),
                ),
          ),
        ),
      );
    }

    const name = "st-editor";
    // 挂到设置页分区（和 sage-mem 的「记忆管理」同一机制）
    const inject = ["slots"];

    function apply(ctx) {
      injectCss();
      try {
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            { name: "settings.section", id: "st-editor", order: 30, label: "角色卡与设定" },
            Section,
          ),
        );
      } catch (error) {
        try { console.warn("[st-editor] slot register failed:", error); } catch { /* ignore */ }
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
