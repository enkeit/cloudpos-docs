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
        title: fields.text({ label: "Title" }),
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
        title: fields.text({ label: "Title" }),
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
