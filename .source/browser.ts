// @ts-nocheck
import { browser } from 'fumadocs-mdx/runtime/browser';
import type * as Config from '../source.config';

const create = browser<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>();
const browserCollections = {
  docs: create.doc("docs", {"admin-panel/customers.mdx": () => import("../content/docs/admin-panel/customers.mdx?collection=docs"), "admin-panel/getting-started.mdx": () => import("../content/docs/admin-panel/getting-started.mdx?collection=docs"), "admin-panel/index.mdx": () => import("../content/docs/admin-panel/index.mdx?collection=docs"), "admin-panel/products.mdx": () => import("../content/docs/admin-panel/products.mdx?collection=docs"), "admin-panel/purchases.mdx": () => import("../content/docs/admin-panel/purchases.mdx?collection=docs"), "admin-panel/reports.mdx": () => import("../content/docs/admin-panel/reports.mdx?collection=docs"), "admin-panel/settings.mdx": () => import("../content/docs/admin-panel/settings.mdx?collection=docs"), "admin-panel/users-roles.mdx": () => import("../content/docs/admin-panel/users-roles.mdx?collection=docs"), "pos-app/billing.mdx": () => import("../content/docs/pos-app/billing.mdx?collection=docs"), "pos-app/customers.mdx": () => import("../content/docs/pos-app/customers.mdx?collection=docs"), "pos-app/dashboard.mdx": () => import("../content/docs/pos-app/dashboard.mdx?collection=docs"), "pos-app/getting-started.mdx": () => import("../content/docs/pos-app/getting-started.mdx?collection=docs"), "pos-app/index.mdx": () => import("../content/docs/pos-app/index.mdx?collection=docs"), "pos-app/kiosk.mdx": () => import("../content/docs/pos-app/kiosk.mdx?collection=docs"), "pos-app/printing.mdx": () => import("../content/docs/pos-app/printing.mdx?collection=docs"), "pos-app/products.mdx": () => import("../content/docs/pos-app/products.mdx?collection=docs"), "pos-app/reports.mdx": () => import("../content/docs/pos-app/reports.mdx?collection=docs"), }),
};
export default browserCollections;