window.__ModuleLoader__.load({
  id: "st-mode",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const react = require("react");
    const h = react.createElement;
    const { useState, useEffect, useCallback, useRef, useLayoutEffect } = react;

    const ENDPOINT = "/st-mode/mode";

    async function fetchMode(sessionId) {
      const qs = sessionId ? "?session=" + encodeURIComponent(sessionId) : "";
      const res = await fetch(ENDPOINT + qs, { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    }

    async function pushMode(mode, sessionId, setDefault) {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: mode, session: sessionId || "", setDefault: !!setDefault }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    }

    // 找输入框：多种选择器兜底，宿主改版也不至于立刻失效
    function findComposer() {
      if (typeof document === "undefined") return null;
      const candidates = [
        '[data-slot="conversation.input"]',
        '[data-slot="composer"]',
        "textarea",
        '[contenteditable="true"]',
        '[class*="composer" i]',
      ];
      for (const sel of candidates) {
        try {
          const el = document.querySelector(sel);
          if (el && el.getBoundingClientRect().width > 80) return el;
        } catch {
          /* ignore */
        }
      }
      return null;
    }

    const styles = {
      wrap: {
        position: "fixed",
        zIndex: 2147483000,
        display: "flex",
        alignItems: "center",
        gap: "6px",
        padding: "5px 10px",
        borderRadius: "999px",
        border: "1px solid rgba(120,140,190,.35)",
        background: "rgba(255,255,255,.92)",
        boxShadow: "0 6px 20px rgba(20,40,90,.14)",
        font: "12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif",
        color: "#22314f",
        backdropFilter: "blur(6px)",
        transition: "left .12s ease, top .12s ease",
      },
      label: { opacity: 0.7, marginRight: "2px" },
      btn: (active) => ({
        cursor: "pointer",
        border: "1px solid " + (active ? "#526aa8" : "rgba(120,140,190,.35)"),
        background: active ? "#526aa8" : "transparent",
        color: active ? "#fff" : "inherit",
        borderRadius: "999px",
        padding: "3px 10px",
        font: "inherit",
      }),
      ghost: {
        cursor: "pointer",
        border: "none",
        background: "transparent",
        color: "#526aa8",
        font: "inherit",
        textDecoration: "underline",
        padding: "3px 4px",
        opacity: 0.85,
      },
      err: { color: "#c0392b", marginLeft: "4px" },
    };

    function ModePill(props) {
      const sessionId = props && props.sessionId ? String(props.sessionId) : "";
      const [mode, setMode] = useState("normal");
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState("");
      const [pos, setPos] = useState(null);
      const ref = useRef(null);

      const refresh = useCallback(() => {
        fetchMode(sessionId)
          .then((data) => {
            setMode(data.mode === "roleplay" ? "roleplay" : "normal");
            setError("");
          })
          .catch(() => setError("读取失败"));
      }, [sessionId]);

      useEffect(() => {
        refresh();
      }, [refresh]);

      // 贴着输入框左侧摆放：以实测 rect 为准，输入框变形/换行也能跟上
      useLayoutEffect(() => {
        const place = () => {
          const node = ref.current;
          if (!node) return;
          const composer = findComposer();
          if (!composer) {
            setPos({ left: 14, top: 14 });
            return;
          }
          const box = composer.getBoundingClientRect();
          const self = node.getBoundingClientRect();
          const gap = 10;
          const left = Math.max(8, box.left - self.width - gap);
          const top = box.top + Math.max(0, (box.height - self.height) / 2);
          setPos({ left: left, top: top });
        };
        place();
        const onMove = () => place();
        window.addEventListener("resize", onMove);
        window.addEventListener("scroll", onMove, true);
        let observer = null;
        try {
          observer = new MutationObserver(onMove);
          observer.observe(document.body, { childList: true, subtree: true });
        } catch {
          /* ignore */
        }
        const timer = setInterval(place, 1000);
        return () => {
          window.removeEventListener("resize", onMove);
          window.removeEventListener("scroll", onMove, true);
          if (observer) observer.disconnect();
          clearInterval(timer);
        };
      }, []);

      const choose = (next, asDefault) => {
        if (busy) return;
        setBusy(true);
        pushMode(next, sessionId, asDefault)
          .then((data) => {
            setMode(data.mode === "roleplay" ? "roleplay" : "normal");
            setError("");
          })
          .catch(() => setError("保存失败"))
          .finally(() => setBusy(false));
      };

      const btn = (label, value) =>
        h(
          "button",
          {
            type: "button",
            style: styles.btn(mode === value),
            disabled: busy,
            onClick: () => choose(value, false),
            title:
              value === "normal"
                ? "正常模式：注入 sage-mem 长期记忆"
                : "角色扮演模式：只注入 st-lite 剧情，不读长期记忆",
          },
          label,
        );

      return h(
        "div",
        {
          ref: ref,
          style: Object.assign({}, styles.wrap, {
            left: (pos ? pos.left : 14) + "px",
            top: (pos ? pos.top : 14) + "px",
            visibility: pos ? "visible" : "hidden",
          }),
          "data-st-mode-pill": "1",
        },
        h("span", { style: styles.label }, "记忆"),
        btn("正常", "normal"),
        btn("扮演", "roleplay"),
        h(
          "button",
          {
            type: "button",
            style: styles.ghost,
            disabled: busy,
            onClick: () => choose(mode, true),
            title: "把当前选择设为新会话默认",
          },
          "设为默认",
        ),
        error ? h("span", { style: styles.err }, error) : null,
      );
    }

    const name = "st-mode";
    const inject = ["slots"];

    function apply(ctx) {
      try {
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register(
            {
              name: "shell.overlay",
              id: "st-mode-pill",
              order: 60,
              inject: (sessionId) => ({ sessionId }),
            },
            ModePill,
          ),
        );
      } catch (error) {
        try {
          console.warn("[st-mode] slot register failed:", error);
        } catch {
          /* ignore */
        }
      }
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  },
});
