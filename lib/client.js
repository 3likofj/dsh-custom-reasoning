/**
 * dsh-custom-reasoning — browser half.
 *
 * What it does
 * ------------
 * The composer's model seat (`conversation.input.model`) renders an Effort row
 * only when the selected model's adapter advertises reasoning metadata. DSH's
 * llm service also rejects any effort an adapter has not advertised
 * (UNSUPPORTED_REASONING_EFFORT), so an effort cannot be smuggled past the
 * adapter: the levels must be DECLARED on the model.
 *
 * So this plugin watches the current session's selection and, for a llm-pi-ai
 * model that advertises no reasoning metadata, declares the five standard
 * levels on that model through the Host's own settings editor. The adapter
 * then advertises them, the OFFICIAL Effort row appears, and this control
 * disappears — one strength surface at a time, which is what "compatible with
 * the official one" means here.
 *
 * Declaring the levels is inert by itself: pi-ai only sends a reasoning
 * parameter once an effort is actually selected, so adding the option never
 * changes an existing request.
 *
 * Module protocol
 * ---------------
 * A client plugin bundle is its package's `./client` export, registered into
 * `window.__ModuleLoader__` as `factory(require) -> exports`. The loader hands
 * back whatever the factory returns and provides no CommonJS globals, so the
 * factory declares its own `module` record. `require` resolves against the
 * shell's frozen platform table (React and friends), so this bundle needs no
 * build step and no `dsh.client.external` entries.
 */
window.__ModuleLoader__.load({
  id: "dsh-custom-reasoning",
  factory: (require) => {
    const module = { exports: {} };
    const React = require("react");

    /** The composer's right-hand tool group, rendered immediately before the model seat. */
    const SLOT = "conversation.input.right";
    /** The pi-ai adapter's settings namespace: it owns the provider profiles this plugin edits. */
    const PI_AI_NS = "llm-pi-ai";
    /** Browser-local persistence for the automatic-mode toggle. */
    const AUTO_STORE_KEY = "dsh-custom-reasoning:auto";
    /** The five standard levels, in escalation order. */
    const LEVELS = [
      { id: "off", label: "关闭" },
      { id: "low", label: "低" },
      { id: "medium", label: "中" },
      { id: "high", label: "高" },
      { id: "max", label: "极高" },
    ];
    /**
     * `off: null` is the one level that may leave the wire value empty — pi-ai
     * reads it as "send no reasoning option at all", which is the correct
     * dispatch for a gateway whose default is not to think. Every other level
     * carries the spelling this plugin sends on the wire.
     */
    const EFFORTS = { off: null, low: "low", medium: "medium", high: "high", max: "max" };
    /** pi-ai's reasoning-dispatch wire formats, plus "none" for "declare levels only". */
    const NO_FORMAT = "none";
    const THINKING_FORMATS = [
      NO_FORMAT,
      "openai",
      "deepseek",
      "zai",
      "qwen",
      "together",
      "baseten",
      "openrouter",
      "chat-template",
      "qwen-chat-template",
      "string-thinking",
      "ant-ling",
    ];
    const DEFAULT_LEVEL = "medium";
    const DEFAULT_FORMAT = "openai";
    /** Bound on waiting for the Host catalog to republish after a settings write. */
    const REFRESH_TIMEOUT_MS = 8000;
    const h = React.createElement;

    /** Text of an unknown throwable. */
    function textOf(error) {
      return error && error.message ? error.message : String(error);
    }

    /** Read the persisted automatic-mode preference (default on). */
    function readAuto() {
      try {
        return window.localStorage.getItem(AUTO_STORE_KEY) !== "off";
      } catch {
        return true;
      }
    }

    /** Persist the automatic-mode preference. */
    function writeAuto(value) {
      try {
        window.localStorage.setItem(AUTO_STORE_KEY, value ? "on" : "off");
      } catch {
        /* Private mode and friends: the in-memory state still applies. */
      }
    }

    /** The session's model directory, or null when this session has none. */
    function resolveDirectory(models, sessionId) {
      if (sessionId === undefined || sessionId === null) return null;
      try {
        return models.directoryFor(sessionId);
      } catch {
        return null;
      }
    }

    /** Subscribe a component to a `createSnapshotStore` handle. */
    function useSnapshot(handle) {
      const [snapshot, setSnapshot] = React.useState(() => (handle ? handle.getSnapshot() : null));
      React.useEffect(() => {
        if (!handle) {
          setSnapshot(null);
          return undefined;
        }
        let last = handle.getSnapshot();
        setSnapshot(last);
        return handle.subscribe(() => {
          const next = handle.getSnapshot();
          if (next === last) return;
          last = next;
          setSnapshot(next);
        });
      }, [handle]);
      return snapshot;
    }

    /** The catalog entry for one selection, or undefined while the catalog is unknown. */
    function modelOf(snapshot, selection) {
      if (!snapshot || !selection) return undefined;
      const group = (snapshot.groups || []).find((item) => item.id === selection.provider);
      if (group === undefined) return undefined;
      return (group.models || []).find((item) => item.id === selection.model);
    }

    /**
     * Whether one selection needs this plugin to declare reasoning levels: the
     * model is known to the catalog and advertises no reasoning metadata — the
     * exact state in which the official Effort row is absent. An unknown model
     * is NOT a target: without catalog knowledge the levels cannot be trusted.
     */
    function needsDeclaration(snapshot, selection) {
      const model = modelOf(snapshot, selection);
      return model !== undefined && model.reasoning === undefined;
    }

    /** The pi-ai settings row for this plugin's provider namespace, if the Host exposes one. */
    function piAiRow(namespaces) {
      return namespaces.find((item) => item.ns === PI_AI_NS);
    }

    /** The effective provider profile for one selection, or undefined. */
    function profileOf(namespaces, selection) {
      const row = piAiRow(namespaces);
      const value = row && row.value && typeof row.value === "object" ? row.value : undefined;
      const providers = value && value.providers && typeof value.providers === "object" ? value.providers : undefined;
      const profile = providers && selection ? providers[selection.provider] : undefined;
      return profile && typeof profile === "object" ? profile : undefined;
    }

    /** The resolved wire protocol for one model: model-level `api` first, then the route's. */
    function apiOf(namespaces, selection) {
      const profile = profileOf(namespaces, selection);
      if (profile === undefined) return undefined;
      const models = Array.isArray(profile.models) ? profile.models : [];
      const model = models.find((item) => item && item.id === selection.model);
      if (model && typeof model.api === "string") return model.api;
      return typeof profile.api === "string" ? profile.api : undefined;
    }

    /** The namespace rows a Settings read returned. */
    function namespacesOf(described) {
      if (!described || !described.ok) {
        throw new Error(described && described.error ? described.error.message : "settings read failed");
      }
      const value = described.value;
      return value && Array.isArray(value.namespaces) ? value.namespaces : [];
    }

    /**
     * Read the live settings, build the mutation that declares the five levels
     * on one model, and submit it. Returns the mutation for callers that need it.
     */
    async function declareLevels(settings, selection, config) {
      const namespaces = namespacesOf(await settings.describe());
      const write = buildWrite(namespaces, selection, config);
      const written = await settings.mutate(PI_AI_NS, write.ops, write.revision);
      if (!written.ok) throw new Error(written.error.message);
      return write;
    }

    /** Poll the shared directory until the Host catalog advertises `level` for the model. */
    function waitForLevel(handle, selection, level) {
      const deadline = Date.now() + REFRESH_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const poll = () => {
          const model = modelOf(handle.getSnapshot(), selection);
          const efforts = model && model.reasoning ? model.reasoning.efforts || [] : [];
          if (efforts.some((effort) => effort.id === level)) {
            resolve();
            return;
          }
          if (Date.now() > deadline) {
            reject(new Error("等待模型目录刷新超时：配置已写入，请稍后重试或直接在官方推理等级中选择"));
            return;
          }
          window.setTimeout(poll, 250);
        };
        poll();
      });
    }

    /**
     * Build the settings mutation that declares the five levels on one model.
     *
     * The write addresses `providers.<route>.models` as a whole because that is
     * the array the profile actually owns: locating a model by ID avoids every
     * ordering assumption an index-based path would need, and route siblings
     * (`apiKeyEnv`, `api`, `baseURL`) are preserved by the path-op walk.
     *
     * `config.thinkingFormat` is only written for `openai-completions`, the one
     * protocol whose reasoning-dispatch field is a configurable compat switch;
     * every other protocol either has an installed-catalog compat or sends its
     * effort natively. `none` declares the levels without touching compat.
     */
    function buildWrite(namespaces, selection, config) {
      const row = piAiRow(namespaces);
      if (row === undefined) {
        throw new Error('未找到 "' + PI_AI_NS + '" 配置命名空间，本插件只支持 pi-ai 路由');
      }
      const profile = profileOf(namespaces, selection);
      if (profile === undefined) {
        throw new Error('provider "' + selection.provider + '" 不在 ' + PI_AI_NS + " 配置中，本插件只支持 pi-ai 路由");
      }
      const overridden = (() => {
        const user = row.user && typeof row.user === "object" ? row.user : undefined;
        const providers = user && user.providers && typeof user.providers === "object" ? user.providers : undefined;
        return providers ? providers[selection.provider] : undefined;
      })();
      const overrideModels = overridden && Array.isArray(overridden.models) ? overridden.models : undefined;
      const effectiveModels = Array.isArray(profile.models) ? profile.models : undefined;
      // Prefer the array the profile layer already owns; fall back to the
      // effective one when the model is inherited rather than overridden.
      const base =
        overrideModels !== undefined && overrideModels.some((model) => model && model.id === selection.model)
          ? overrideModels
          : effectiveModels;
      if (!Array.isArray(base)) {
        throw new Error('provider "' + selection.provider + '" 未声明模型列表，无法写入推理等级');
      }
      const index = base.findIndex((model) => model && model.id === selection.model);
      if (index < 0) {
        throw new Error('模型 "' + selection.model + '" 不在 provider "' + selection.provider + '" 的模型列表中');
      }
      const api = apiOf(namespaces, selection);
      const models = base.map((model, position) => {
        if (position !== index) return model;
        const next = { ...model, reasoningEfforts: { ...EFFORTS } };
        if (config.writeCompat && api === "openai-completions") {
          const existing = model.compat && typeof model.compat === "object" ? model.compat : {};
          next.compat = { ...existing, supportsReasoningEffort: true, thinkingFormat: config.thinkingFormat };
        }
        return next;
      });
      return {
        revision: row.revision,
        ops: [{ op: "set", path: ["providers", selection.provider, "models"], value: models }],
      };
    }

    const styles = {
      wrap: { position: "relative", display: "inline-flex" },
      chip: {
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 28,
        padding: "0 10px",
        borderRadius: 8,
        border: "1px solid var(--dsw-alias-border-l1)",
        background: "transparent",
        color: "var(--dsw-alias-label-secondary)",
        font: "inherit",
        fontSize: 12,
        lineHeight: 1,
        whiteSpace: "nowrap",
        cursor: "pointer",
      },
      chipOpen: { background: "var(--dsw-alias-bg-layer-2)", color: "var(--dsw-alias-label-primary)" },
      chipBusy: { opacity: 0.7, cursor: "progress" },
      chipError: { borderColor: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)" },
      dot: { width: 6, height: 6, borderRadius: 999, background: "var(--dsw-alias-brand-primary)" },
      menu: {
        position: "absolute",
        bottom: "calc(100% + 6px)",
        left: 0,
        zIndex: 40,
        minWidth: 196,
        padding: 4,
        borderRadius: 10,
        border: "1px solid var(--dsw-alias-border-l1)",
        background: "var(--dsw-alias-bg-overlay)",
        boxShadow: "0 8px 24px rgb(0 0 0 / 18%)",
      },
      title: { padding: "6px 8px 4px", fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
      item: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        width: "100%",
        padding: "6px 8px",
        border: 0,
        borderRadius: 6,
        background: "transparent",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        fontSize: 12,
        textAlign: "left",
        cursor: "pointer",
      },
      itemActive: { background: "var(--dsw-alias-bg-layer-2)" },
      row: {
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        padding: "6px 8px 2px",
        fontSize: 11,
        color: "var(--dsw-alias-label-secondary)",
      },
      select: {
        height: 24,
        borderRadius: 6,
        border: "1px solid var(--dsw-alias-border-l1)",
        background: "var(--dsw-alias-bg-layer-1)",
        color: "var(--dsw-alias-label-primary)",
        font: "inherit",
        fontSize: 11,
      },
      check: { display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", fontSize: 11, cursor: "pointer" },
      divider: { height: 1, margin: "4px 6px", background: "var(--dsw-alias-border-l1)" },
      hint: { padding: "2px 8px 6px", fontSize: 11, color: "var(--dsw-alias-label-secondary)" },
      error: { maxWidth: 280, padding: "4px 8px 6px", fontSize: 11, color: "var(--dsw-alias-state-error-primary)" },
    };

    /**
     * Build the control component.
     *
     * Visibility: it renders nothing while the official Effort row exists (the
     * model advertises reasoning metadata), and nothing for providers outside
     * llm-pi-ai. Otherwise it shows a one-chip status: declaring, declared but
     * not yet acknowledged, failed (with the reason), or a manual picker.
     *
     * The session identity comes from the slot's own standard `sessionId` prop,
     * with the registration's injection echo as a fallback; the directory is
     * resolved on every render (the official resolver memoizes it), so a
     * connection reset or a replaced session binding is picked up rather than
     * pinned by a stale cache.
     */
    function makeControl(deps) {
      return function Control(props) {
        const sessionId = props.sessionId !== undefined ? props.sessionId : props.reasoningSessionId;
        const directory = resolveDirectory(deps.models, sessionId);
        const handle = directory ? directory.store : null;
        const snapshot = useSnapshot(handle);

        const [auto, setAuto] = React.useState(readAuto);
        const [open, setOpen] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState(null);
        const [level, setLevel] = React.useState(DEFAULT_LEVEL);
        const [format, setFormat] = React.useState(DEFAULT_FORMAT);
        const [probed, setProbed] = React.useState(null);
        const wrapRef = React.useRef(null);
        const declaredRef = React.useRef(null);
        if (declaredRef.current === null) declaredRef.current = new Set();

        const current = snapshot ? snapshot.current : null;
        const model = modelOf(snapshot, current);
        const key = current ? current.provider + "\u0000" + current.model : null;
        const needsEffort = needsDeclaration(snapshot, current);
        const isPiAiRoute = probed !== null && probed.key === key && probed.inPiAi === true;
        const selection = current;

        // Keep this session's catalog loaded; harmless when already ready.
        React.useEffect(() => {
          if (!directory) return undefined;
          try {
            const pending = directory.load();
            if (pending && typeof pending.catch === "function") pending.catch(() => {});
          } catch {
            /* An addressed subagent session exposes no model selection. */
          }
          return undefined;
        }, [directory]);

        // Resolve whether this provider belongs to llm-pi-ai, and its protocol.
        React.useEffect(() => {
          if (key === null) return undefined;
          let alive = true;
          (async () => {
            let next = { key, inPiAi: false, api: undefined };
            try {
              const namespaces = namespacesOf(await deps.settings.describe());
              if (profileOf(namespaces, selection) !== undefined) {
                next = { key, inPiAi: true, api: apiOf(namespaces, selection) };
              }
            } catch {
              /* Leave it as not-ours; the manual path reports the real error. */
            }
            if (alive) setProbed(next);
          })();
          return () => {
            alive = false;
          };
        }, [key]);

        // Automatic mode: declare the levels as soon as such a model is picked.
        React.useEffect(() => {
          if (!auto || !needsEffort || !isPiAiRoute || key === null) return undefined;
          if (declaredRef.current.has(key)) return undefined;
          declaredRef.current.add(key);
          let alive = true;
          (async () => {
            setBusy(true);
            setError(null);
            try {
              await declareLevels(deps.settings, selection, {
                writeCompat: true,
                thinkingFormat: DEFAULT_FORMAT,
              });
            } catch (caught) {
              if (alive) {
                setError(textOf(caught));
                declaredRef.current.delete(key);
              }
            } finally {
              if (alive) setBusy(false);
            }
          })();
          return () => {
            alive = false;
          };
        }, [auto, needsEffort, isPiAiRoute, key]);

        React.useEffect(() => {
          if (!open) return undefined;
          const onPointerDown = (event) => {
            const node = wrapRef.current;
            if (node && event.target instanceof Node && node.contains(event.target)) return;
            setOpen(false);
          };
          const onKeyDown = (event) => {
            if (event.key === "Escape") setOpen(false);
          };
          document.addEventListener("mousedown", onPointerDown);
          document.addEventListener("keydown", onKeyDown);
          return () => {
            document.removeEventListener("mousedown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
          };
        }, [open]);

        const toggleAuto = (next) => {
          setAuto(next);
          writeAuto(next);
        };

        const choose = async (picked) => {
          setBusy(true);
          setError(null);
          setLevel(picked);
          try {
            const config = {
              writeCompat: format !== NO_FORMAT,
              thinkingFormat: format === NO_FORMAT ? DEFAULT_FORMAT : format,
            };
            await declareLevels(deps.settings, selection, config);
            await waitForLevel(handle, selection, picked);
            if (directory) {
              const selected = await directory.select({
                provider: selection.provider,
                model: selection.model,
                reasoningEffort: picked,
              });
              if (selected && selected.ok === false) {
                throw new Error(selected.error.code + ": " + selected.error.message);
              }
            }
            declaredRef.current.add(key);
            setOpen(false);
          } catch (caught) {
            setError(textOf(caught));
            declaredRef.current.delete(key);
          } finally {
            setBusy(false);
          }
        };

        // The official selector owns the surface once the model advertises
        // reasoning metadata; nothing of ours belongs there.
        if (model !== undefined && model.reasoning !== undefined) return null;
        // Before we know the provider is ours, stay invisible.
        const info = probed && probed.key === key ? probed : null;
        if (info === null || !info.inPiAi) return null;
        if (!handle || !snapshot || !current) return null;

        const label = busy ? "推理强度 开启中…" : error !== null ? "推理强度 未开启" : "推理强度";
        const chipStyle = {
          ...styles.chip,
          ...(open ? styles.chipOpen : {}),
          ...(busy ? styles.chipBusy : {}),
          ...(error !== null && !busy ? styles.chipError : {}),
        };
        const unknownModel = model === undefined;

        return h(
          "div",
          { ref: wrapRef, style: styles.wrap },
          h(
            "button",
            {
              type: "button",
              style: chipStyle,
              disabled: busy,
              "aria-haspopup": "menu",
              "aria-expanded": open,
              title:
                error !== null
                  ? error
                  : unknownModel
                    ? "该模型未出现在模型目录中，无法判断其推理能力"
                    : "官方未提供推理强度；本插件会为该模型补上 off/low/medium/high/max",
              onClick: () => {
                setOpen((value) => !value);
              },
            },
            h("span", { style: styles.dot }),
            h("span", null, label),
          ),
          open
            ? h(
                "div",
                { role: "menu", style: styles.menu },
                h("div", { style: styles.title }, unknownModel ? "模型未出现在目录中" : "为该模型开启推理等级"),
                unknownModel
                  ? null
                  : LEVELS.map((item) =>
                      h(
                        "button",
                        {
                          key: item.id,
                          type: "button",
                          role: "menuitemradio",
                          "aria-checked": item.id === level,
                          disabled: busy,
                          style: item.id === level ? { ...styles.item, ...styles.itemActive } : styles.item,
                          onClick: () => {
                            choose(item.id);
                          },
                        },
                        h("span", null, item.label),
                        h("span", { style: { opacity: 0.6 } }, item.id),
                      ),
                    ),
                info.api === "openai-completions"
                  ? h(
                      "div",
                      null,
                      h("div", { style: styles.divider }),
                      h(
                        "div",
                        { style: styles.row },
                        h("span", null, "线格式"),
                        h(
                          "select",
                          {
                            style: styles.select,
                            value: format,
                            disabled: busy,
                            onChange: (event) => setFormat(event.target.value),
                          },
                          THINKING_FORMATS.map((name) => h("option", { key: name, value: name }, name)),
                        ),
                      ),
                    )
                  : null,
                h("div", { style: styles.divider }),
                h(
                  "label",
                  { style: styles.check },
                  h("input", {
                    type: "checkbox",
                    checked: auto,
                    disabled: busy,
                    onChange: (event) => toggleAuto(event.target.checked),
                  }),
                  h("span", null, "选中未声明强度的模型时自动开启"),
                ),
                h("div", { style: styles.hint }, "开启后由官方推理等级选择接管，本控件自动隐藏"),
                error !== null ? h("div", { style: styles.error }, error) : null,
              )
            : null,
        );
      };
    }

    /**
     * Client plugin body: reserve the composer tool row's right-hand group and
     * register one entry that is visible only while the official Effort row is
     * not. Registration goes through `slots.inject` because the composer's
     * declaration may not be on the slot ledger yet.
     */
    function apply(ctx) {
      const slots = ctx.slots;
      const models = ctx.modelDirectories;
      const settings = ctx.remote.settings;
      const Control = makeControl({ models, settings });
      // The slot framework compares injection results; one stable echo per
      // session keeps a re-render from looking like a changed contribution.
      const echoed = new Map();

      ctx.effect(
        () =>
          slots.inject(SLOT, () =>
            slots.register(
              {
                name: SLOT,
                id: "dsh-custom-reasoning",
                order: 20,
                label: () => "推理强度",
                inject: (sessionId) => {
                  let entry = echoed.get(sessionId);
                  if (entry === undefined) {
                    entry = { reasoningSessionId: sessionId };
                    echoed.set(sessionId, entry);
                  }
                  return entry;
                },
              },
              Control,
            ),
          ),
        "dsh-custom-reasoning: composer effort control",
      );
    }

    const inject = ["slots", "modelDirectories", "remote", "remote.settings"];

    /** Pure helpers and the component factory, exposed for test/verify.mjs. */
    const __internals = {
      EFFORTS,
      LEVELS,
      NO_FORMAT,
      THINKING_FORMATS,
      modelOf,
      needsDeclaration,
      apiOf,
      profileOf,
      buildWrite,
      declareLevels,
      makeControl,
    };

    module.exports = { name: "dsh-custom-reasoning", inject, apply, __internals };
    return module.exports;
  },
});
