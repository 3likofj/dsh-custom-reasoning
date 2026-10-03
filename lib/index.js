/**
 * dsh-custom-reasoning — node half.
 *
 * Surface plugin: it owns no host behaviour. Every write it performs goes
 * through the Host's own `remote.settings` namespace — the Settings service's
 * versioned, volatile-only editor over the active profile's Cordis patch —
 * driven by the browser half.
 *
 * The node half exists so the Loader mounts the package as a plugin row (the
 * client-modules scan only sees enabled Loader entries). It deliberately
 * imports NOTHING: a locally linked package resolves its bare specifiers from
 * its own location, outside the profile's `node_modules`, so any dependency
 * here would have to be installed into the profile just to load a no-op half.
 */
/** Loader row / client module id; must equal the package name. */
export const name = "dsh-custom-reasoning";

/** No host-side behaviour. */
export function apply() {}
