/**
 * Screen router — the four rail destinations + batch-work routes (user flow).
 *
 * Views are the GUI lane's `.vue` files. To keep this file free of hard `.vue`
 * imports (and to let the logic lane run before the screens exist), views are
 * resolved lazily via `import.meta.glob`; a missing view falls back to a plain
 * placeholder so navigation never crashes. Once the GUI authors a view, it is
 * picked up automatically — no change here.
 */

import {
  createRouter,
  createWebHistory,
  type RouteRecordRaw,
  type Router,
} from "vue-router";
import { defineComponent, h } from "vue";

export type RailDestination = "overview" | "batches" | "sync" | "settings";

declare module "vue-router" {
  interface RouteMeta {
    /** Which rail item is highlighted for this route (batch-work keeps
     * "batches" active). */
    rail?: RailDestination;
    title?: string;
  }
}

/** The rail's nav model — bound by the GUI's `AppRail.vue`. */
export const RAIL_DESTINATIONS: ReadonlyArray<{
  key: RailDestination;
  label: string;
  routeName: string;
}> = [
  { key: "overview", label: "Overview", routeName: "overview" },
  { key: "batches", label: "Batches", routeName: "batches" },
  { key: "sync", label: "Sync", routeName: "sync" },
  { key: "settings", label: "Settings", routeName: "settings" },
];

// Lazy view loaders, keyed by `../views/<Name>.vue`. Empty until the GUI adds
// files — `import.meta.glob` handles a no-match gracefully.
const viewModules = import.meta.glob("../views/*.vue");

// Bare routing fallback for a not-yet-authored view — a single hook element
// with no styling or product copy (presentation belongs to the GUI lane). The
// GUI replaces it simply by adding `../views/<Name>.vue`.
function placeholder(name: string) {
  return defineComponent({
    name: `Placeholder${name}`,
    setup() {
      return () => h("div", { class: "screen-placeholder", "data-view": name });
    },
  });
}

/** Resolve a view component loader by file base-name, with a placeholder
 * fallback so a not-yet-authored screen still routes. */
function view(name: string) {
  const loader = viewModules[`../views/${name}.vue`];
  if (loader) return loader;
  return () => Promise.resolve({ default: placeholder(name) });
}

export const routes: RouteRecordRaw[] = [
  {
    path: "/",
    name: "overview",
    component: view("OverviewView"),
    meta: { rail: "overview", title: "Overview" },
  },
  {
    path: "/batches",
    name: "batches",
    component: view("BatchesView"),
    meta: { rail: "batches", title: "Batches" },
  },
  {
    // Batch-work is reachable from Overview and Batches; the rail's Batches
    // item stays active while here (meta.rail = "batches").
    path: "/batches/:batchId",
    name: "batch-work",
    component: view("BatchWorkView"),
    props: true,
    meta: { rail: "batches", title: "Batch" },
  },
  {
    path: "/sync",
    name: "sync",
    component: view("SyncView"),
    meta: { rail: "sync", title: "Sync" },
  },
  {
    path: "/settings",
    name: "settings",
    component: view("SettingsView"),
    meta: { rail: "settings", title: "Settings" },
  },
  { path: "/:pathMatch(.*)*", redirect: { name: "overview" } },
];

export function createAppRouter(): Router {
  return createRouter({
    history: createWebHistory(),
    routes,
  });
}
