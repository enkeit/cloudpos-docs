import { docs, meta } from "@/.source/server";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";
import { loader } from "fumadocs-core/source";
import type { InferPageType } from "fumadocs-core/source";

export const source = loader({
  baseUrl: "/docs",
  source: toFumadocsSource(docs, meta),
});

export type DocsPageData = InferPageType<typeof source>;
