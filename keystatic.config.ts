import { config, fields, collection } from "@keystatic/core";

export default config({
  storage: {
    kind: "github",
    repo: {
      owner: "enkeit",
      name: "cloudpos-docs",
    },
  },
  collections: {
    posApp: collection({
      label: "POS App Docs",
      slugField: "title",
      path: "content/docs/pos-app/*",
      format: { contentField: "content" },
      schema: {
        title: fields.slug({ name: { label: "Title" } }),
        description: fields.text({ label: "Description", multiline: true }),
        content: fields.mdx({
          label: "Content",
          options: {
            image: {
              directory: "public/images/docs",
              publicPath: "/images/docs/",
            },
          },
        }),
      },
    }),
    adminPanel: collection({
      label: "Admin Panel Docs",
      slugField: "title",
      path: "content/docs/admin-panel/*",
      format: { contentField: "content" },
      schema: {
        title: fields.slug({ name: { label: "Title" } }),
        description: fields.text({ label: "Description", multiline: true }),
        content: fields.mdx({
          label: "Content",
          options: {
            image: {
              directory: "public/images/docs",
              publicPath: "/images/docs/",
            },
          },
        }),
      },
    }),
    ecomUserGuide: collection({
      label: "Ecom — User Guide",
      slugField: "title",
      path: "content/docs/ecom/user-guide/*",
      format: { contentField: "content" },
      schema: {
        title: fields.slug({ name: { label: "Title" } }),
        description: fields.text({ label: "Description", multiline: true }),
        content: fields.mdx({
          label: "Content",
          options: {
            image: {
              directory: "public/images/docs",
              publicPath: "/images/docs/",
            },
          },
        }),
      },
    }),
    ecomDeveloper: collection({
      label: "Ecom — Developer Docs",
      slugField: "title",
      path: "content/docs/ecom/developer/*",
      format: { contentField: "content" },
      schema: {
        title: fields.slug({ name: { label: "Title" } }),
        description: fields.text({ label: "Description", multiline: true }),
        content: fields.mdx({
          label: "Content",
          options: {
            image: {
              directory: "public/images/docs",
              publicPath: "/images/docs/",
            },
          },
        }),
      },
    }),
  },
});
