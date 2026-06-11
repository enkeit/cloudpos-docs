import { config, fields, collection } from "@keystatic/core";

export default config({
  storage: {
    kind: "github",
    repo: {
      owner: "YOUR_GITHUB_ORG",
      name: "YOUR_REPO_NAME",
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
        content: fields.markdoc({
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
        content: fields.markdoc({
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
