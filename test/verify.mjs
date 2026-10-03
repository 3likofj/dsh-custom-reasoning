/**
 * Offline verification for the browser half.
 *
 * The bundle is a plain module-loader script, not an ES module, so this script
 * captures its factory through a fake `window.__ModuleLoader__`, materializes it
 * with a stub `react`, and exercises the registration wiring, the pure decision
 * helpers, and the full settings mutation (describe -> build -> mutate) against
 * a fake Host remote. It needs no browser and no build step.
 *
 *   node test/verify.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let failures = 0;
let checks = 0;

function ok(label, condition, detail) {
  checks += 1;
  if (condition) {
    console.log("  PASS  " + label);
    return;
  }
  failures += 1;
  console.log("  FAIL  " + label + (detail === undefined ? "" : " :: " + JSON.stringify(detail)));
}

/** Key-order-insensitive JSON: object key order is not part of any contract here. */
function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

function equal(label, actual, expected) {
  const a = canonical(actual);
  const e = canonical(expected);
  ok(label, a === e, a === e ? undefined : { actual, expected });
}

// ---- capture the registration -------------------------------------------------
let row;
const fakeWindow = {
  __ModuleLoader__: {
    load(candidate) {
      row = candidate;
    },
  },
};
new Function("window", source)(fakeWindow);

ok("bundle registers through window.__ModuleLoader__", row !== undefined);
equal("module id is the package name", row && row.id, "dsh-custom-reasoning");

// A stub React good enough to execute a single component render: hooks return
// their initial value, effects do not run, and createElement records the tree.
const react = {
  createElement: (type, props) => ({ type, props }),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init === undefined ? null : init }),
};

const required = [];
const exportsObject = row.factory((spec) => {
  required.push(spec);
  if (spec === "react") return react;
  throw new Error("unexpected require: " + spec);
});

equal("client bundle requires only the platform baseline", required, ["react"]);
equal("plugin name", exportsObject.name, "dsh-custom-reasoning");
equal("injected client services", exportsObject.inject, [
  "slots",
  "modelDirectories",
  "remote",
  "remote.settings",
]);
ok("apply is a function", typeof exportsObject.apply === "function");

// ---- registration wiring ------------------------------------------------------
const registered = [];
const snapshotStore = (value) => ({
  getSnapshot: () => value,
  subscribe: () => () => {},
});
const models = {
  directoryFor() {
    return {
      store: snapshotStore({ current: null, groups: [], status: "idle" }),
      load: () => Promise.resolve(),
      select: () => Promise.resolve({ ok: true }),
    };
  },
};
const settings = {
  describe: () => Promise.resolve({ ok: false, error: { message: "unused" } }),
  mutate: () => Promise.resolve({ ok: true, value: { namespaces: [] } }),
};
const ctx = {
  effect(fn) {
    const dispose = fn();
    return typeof dispose === "function" ? dispose : () => {};
  },
  slots: {
    inject(name, callback) {
      ok("slot injection targets the composer tool row", name === "conversation.input.right");
      callback();
      return () => {};
    },
    register(declaration, component) {
      registered.push({ declaration, component });
      return () => {};
    },
  },
  modelDirectories: models,
  remote: { settings },
};

exportsObject.apply(ctx);
ok("one entry registered", registered.length === 1);
const registration = registered[0];
equal("entry id", registration.declaration.id, "dsh-custom-reasoning");
equal("entry order (before the model seat)", registration.declaration.order, 20);
ok("entry implements the slot name", registration.declaration.name === "conversation.input.right");
ok("the registered value is a component", typeof registration.component === "function");

const echoA = registration.declaration.inject("session-1");
const echoB = registration.declaration.inject("session-1");
ok("the session echo is stable per session", echoA === echoB, "identity must not churn on re-render");
equal("the session echo carries the fallback identity", echoA, { reasoningSessionId: "session-1" });

// ---- pure helpers -------------------------------------------------------------
const {
  buildWrite,
  declareLevels,
  needsDeclaration,
  apiOf,
  profileOf,
  modelOf,
  makeControl,
  EFFORTS,
  THINKING_FORMATS,
  NO_FORMAT,
} = exportsObject.__internals;

const piAiRow = (providers, extra) => ({
  ns: "llm-pi-ai",
  revision: 7,
  value: { providers },
  ...extra,
});

const namespaces = [
  piAiRow({
    jagb: {
      apiKeyEnv: "JAGB_API_KEY",
      api: "openai-completions",
      baseURL: "https://example.invalid/v1",
      models: [
        { id: "model-a", name: "A" },
        { id: "model-b", name: "B" },
      ],
    },
    amd: {
      api: "openai-responses",
      models: [{ id: "vision-1" }, { id: "vision-2", api: "anthropic-messages" }],
    },
  }),
];

equal("five standard levels", EFFORTS, {
  off: null,
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
});
ok("the compat opt-out is offered first", THINKING_FORMATS[0] === NO_FORMAT);
ok("openai is the default format", THINKING_FORMATS.includes("openai"));
ok("every pi-ai format this plugin knows is listed", THINKING_FORMATS.length >= 10);

equal("api comes from the route", apiOf(namespaces, { provider: "jagb", model: "model-a" }), "openai-completions");
equal(
  "a model-level api overrides the route",
  apiOf(namespaces, { provider: "amd", model: "vision-2" }),
  "anthropic-messages",
);
equal("an unknown provider resolves no api", apiOf(namespaces, { provider: "nope", model: "x" }), undefined);
ok("an unknown provider has no profile", profileOf(namespaces, { provider: "nope", model: "x" }) === undefined);
ok("a known provider has a profile", profileOf(namespaces, { provider: "jagb", model: "model-a" }) !== undefined);

// ---- the automatic-declaration decision ---------------------------------------
const readySnapshot = (reasoning) => ({
  status: "ready",
  current: { provider: "jagb", model: "model-b" },
  groups: [{ id: "jagb", models: [{ id: "model-b", ...(reasoning === undefined ? {} : { reasoning }) }] }],
});
const selection = { provider: "jagb", model: "model-b" };
ok("a model with no reasoning metadata needs a declaration", needsDeclaration(readySnapshot(undefined), selection));
ok(
  "a model that already advertises reasoning needs none",
  !needsDeclaration(readySnapshot({ efforts: [{ id: "off", name: "Off" }] }), selection),
);
ok("an unknown model is never a target", !needsDeclaration({ groups: [] }, selection));
ok("no selection is never a target", !needsDeclaration(readySnapshot(undefined), null));
ok(
  "model without reasoning metadata has no catalog reasoning",
  modelOf(readySnapshot(undefined), selection).reasoning === undefined,
);
ok(
  "model with reasoning metadata exposes it",
  modelOf(readySnapshot({ efforts: [] }), selection).reasoning !== undefined,
);

// ---- write building -----------------------------------------------------------
const openai = { writeCompat: true, thinkingFormat: "openai" };
const write = buildWrite(namespaces, { provider: "jagb", model: "model-b" }, openai);
equal("mutation targets the owning entry revision", write.revision, 7);
equal("one path op", write.ops.length, 1);
equal("path op targets the route's model array", write.ops[0].path, ["providers", "jagb", "models"]);
equal("model-b gains the five levels", write.ops[0].value[1].reasoningEfforts, EFFORTS);
equal("openai-completions gains the compat block", write.ops[0].value[1].compat, {
  supportsReasoningEffort: true,
  thinkingFormat: "openai",
});
equal("the untouched sibling model is preserved", write.ops[0].value[0], { id: "model-a", name: "A" });
ok("the source array is not mutated", namespaces[0].value.providers.jagb.models[1].reasoningEfforts === undefined);

// An existing compat block is preserved field by field.
const withCompat = [
  piAiRow({
    jagb: {
      api: "openai-completions",
      models: [{ id: "model-a", compat: { supportsStore: false, thinkingFormat: "qwen" } }],
    },
  }),
];
const merged = buildWrite(withCompat, { provider: "jagb", model: "model-a" }, openai);
equal("an existing compat block keeps its own fields", merged.ops[0].value[0].compat, {
  supportsStore: false,
  supportsReasoningEffort: true,
  thinkingFormat: "openai",
});

// The chosen wire format is written through.
const zai = buildWrite(namespaces, { provider: "jagb", model: "model-a" }, {
  writeCompat: true,
  thinkingFormat: "zai",
});
equal("a custom wire format is written", zai.ops[0].value[0].compat.thinkingFormat, "zai");

// "none" declares levels without touching compat.
const none = buildWrite(namespaces, { provider: "jagb", model: "model-a" }, {
  writeCompat: false,
  thinkingFormat: "openai",
});
ok("writeCompat=false adds no compat", none.ops[0].value[0].compat === undefined);
equal("writeCompat=false still declares the levels", none.ops[0].value[0].reasoningEfforts, EFFORTS);

// Non-completions protocols never get a compat block, whatever the caller says.
const responses = buildWrite(namespaces, { provider: "amd", model: "vision-1" }, openai);
ok("openai-responses gets no compat block", responses.ops[0].value[0].compat === undefined);
equal("openai-responses still gets the levels", responses.ops[0].value[0].reasoningEfforts, EFFORTS);

// Profile-layer preference: the array the profile owns wins when it holds the model.
const withOverride = [
  piAiRow(
    { jagb: { api: "openai-completions", models: [{ id: "model-a" }] } },
    { user: { providers: { jagb: { models: [{ id: "model-a", name: "from-profile" }] } } } },
  ),
];
const overrideWrite = buildWrite(withOverride, { provider: "jagb", model: "model-a" }, openai);
equal("an overridden model is edited in the profile's own array", overrideWrite.ops[0].value[0].name, "from-profile");

// Inherited model: an override array that does not hold the model falls back
// to the effective (merged) array.
const inheritedNamespaces = [
  piAiRow(
    { jagb: { api: "openai-completions", models: [{ id: "model-a", name: "from-effective" }] } },
    { user: { providers: { jagb: { models: [{ id: "some-other-model" }] } } } },
  ),
];
const inheritedWrite = buildWrite(inheritedNamespaces, { provider: "jagb", model: "model-a" }, openai);
equal("an inherited model falls back to the effective array", inheritedWrite.ops[0].value[0].name, "from-effective");
equal("the inherited write still declares the levels", inheritedWrite.ops[0].value[0].reasoningEfforts, EFFORTS);

function throws(label, fn) {
  try {
    fn();
    ok(label, false, "expected a throw");
  } catch {
    ok(label, true);
  }
}
throws("unknown provider is refused", () => buildWrite(namespaces, { provider: "nope", model: "model-a" }, openai));
throws("unknown model is refused", () => buildWrite(namespaces, { provider: "jagb", model: "nope" }, openai));
throws("missing namespace is refused", () => buildWrite([], { provider: "jagb", model: "model-a" }, openai));

// ---- the full mutation, exactly as the automatic path performs it --------------
const calls = [];
const workingSettings = {
  describe: () => {
    calls.push({ kind: "describe" });
    return Promise.resolve({ ok: true, value: { namespaces } });
  },
  mutate: (ns, ops, revision) => {
    calls.push({ kind: "mutate", ns, ops, revision });
    return Promise.resolve({ ok: true, value: { namespaces } });
  },
};

const declared = await declareLevels(workingSettings, { provider: "jagb", model: "model-b" }, openai);
equal(
  "the automatic path reads, then writes the owning namespace",
  calls.map((call) => call.kind),
  ["describe", "mutate"],
);
equal("the write names the pi-ai namespace", calls[1].ns, "llm-pi-ai");
equal("the write carries the observed revision", calls[1].revision, 7);
equal("the write declares the levels", calls[1].ops[0].value[1].reasoningEfforts, EFFORTS);
equal("declareLevels returns the mutation it submitted", declared.ops, calls[1].ops);
ok("the mutation targets only the requested route", calls[1].ops[0].path[1] === "jagb");

const failingDescribe = {
  describe: () => Promise.resolve({ ok: false, error: { message: "settings unavailable" } }),
  mutate: () => Promise.resolve({ ok: true }),
};
let describeFailure = null;
try {
  await declareLevels(failingDescribe, { provider: "jagb", model: "model-b" }, openai);
} catch (error) {
  describeFailure = error.message;
}
equal("a refused settings read surfaces its message", describeFailure, "settings unavailable");

const failingMutate = {
  describe: () => Promise.resolve({ ok: true, value: { namespaces } }),
  mutate: () => Promise.resolve({ ok: false, error: { message: "settings/conflict" } }),
};
let mutateFailure = null;
try {
  await declareLevels(failingMutate, { provider: "jagb", model: "model-b" }, openai);
} catch (error) {
  mutateFailure = error.message;
}
equal("a refused settings write surfaces its message", mutateFailure, "settings/conflict");

// ---- the component's first visibility gate ------------------------------------
// Hooks do not run under the stub, so only the gate evaluated before any effect
// is observable here: a model that already advertises reasoning is never ours.
const ownedDirectory = {
  store: snapshotStore({
    status: "ready",
    current: { provider: "jagb", model: "model-b" },
    groups: [{ id: "jagb", models: [{ id: "model-b", reasoning: { efforts: [{ id: "off", name: "Off" }] } }] }],
  }),
  load: () => Promise.resolve(),
  select: () => Promise.resolve({ ok: true }),
};
const ownedControl = makeControl({
  models: { directoryFor: () => ownedDirectory },
  settings: workingSettings,
});
ok("a model that already advertises reasoning renders nothing", ownedControl({ sessionId: "s1" }) === null);
const missingSession = makeControl({
  models: {
    directoryFor() {
      throw new Error("no scope");
    },
  },
  settings,
});
ok("no resolvable session renders nothing", missingSession({ sessionId: "s1" }) === null);

console.log("");
console.log(failures === 0 ? `all ${checks} checks passed` : `${failures}/${checks} checks FAILED`);
process.exit(failures === 0 ? 0 : 1);
