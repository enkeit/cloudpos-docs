// @ts-nocheck
import { default as __fd_glob_19 } from "../content/docs/pos-app/meta.json?collection=meta"
import { default as __fd_glob_18 } from "../content/docs/admin-panel/meta.json?collection=meta"
import { default as __fd_glob_17 } from "../content/docs/meta.json?collection=meta"
import * as __fd_glob_16 from "../content/docs/pos-app/reports.mdx?collection=docs"
import * as __fd_glob_15 from "../content/docs/pos-app/products.mdx?collection=docs"
import * as __fd_glob_14 from "../content/docs/pos-app/printing.mdx?collection=docs"
import * as __fd_glob_13 from "../content/docs/pos-app/kiosk.mdx?collection=docs"
import * as __fd_glob_12 from "../content/docs/pos-app/index.mdx?collection=docs"
import * as __fd_glob_11 from "../content/docs/pos-app/getting-started.mdx?collection=docs"
import * as __fd_glob_10 from "../content/docs/pos-app/dashboard.mdx?collection=docs"
import * as __fd_glob_9 from "../content/docs/pos-app/customers.mdx?collection=docs"
import * as __fd_glob_8 from "../content/docs/pos-app/billing.mdx?collection=docs"
import * as __fd_glob_7 from "../content/docs/admin-panel/users-roles.mdx?collection=docs"
import * as __fd_glob_6 from "../content/docs/admin-panel/settings.mdx?collection=docs"
import * as __fd_glob_5 from "../content/docs/admin-panel/reports.mdx?collection=docs"
import * as __fd_glob_4 from "../content/docs/admin-panel/purchases.mdx?collection=docs"
import * as __fd_glob_3 from "../content/docs/admin-panel/products.mdx?collection=docs"
import * as __fd_glob_2 from "../content/docs/admin-panel/index.mdx?collection=docs"
import * as __fd_glob_1 from "../content/docs/admin-panel/getting-started.mdx?collection=docs"
import * as __fd_glob_0 from "../content/docs/admin-panel/customers.mdx?collection=docs"
import { server } from 'fumadocs-mdx/runtime/server';
import type * as Config from '../source.config';

const create = server<typeof Config, import("fumadocs-mdx/runtime/types").InternalTypeConfig & {
  DocData: {
  }
}>({"doc":{"passthroughs":["extractedReferences"]}});

export const docs = await create.doc("docs", "content/docs", {"admin-panel/customers.mdx": __fd_glob_0, "admin-panel/getting-started.mdx": __fd_glob_1, "admin-panel/index.mdx": __fd_glob_2, "admin-panel/products.mdx": __fd_glob_3, "admin-panel/purchases.mdx": __fd_glob_4, "admin-panel/reports.mdx": __fd_glob_5, "admin-panel/settings.mdx": __fd_glob_6, "admin-panel/users-roles.mdx": __fd_glob_7, "pos-app/billing.mdx": __fd_glob_8, "pos-app/customers.mdx": __fd_glob_9, "pos-app/dashboard.mdx": __fd_glob_10, "pos-app/getting-started.mdx": __fd_glob_11, "pos-app/index.mdx": __fd_glob_12, "pos-app/kiosk.mdx": __fd_glob_13, "pos-app/printing.mdx": __fd_glob_14, "pos-app/products.mdx": __fd_glob_15, "pos-app/reports.mdx": __fd_glob_16, });

export const meta = await create.meta("meta", "content/docs", {"meta.json": __fd_glob_17, "admin-panel/meta.json": __fd_glob_18, "pos-app/meta.json": __fd_glob_19, });