import { DocsPage, DocsBody } from "fumadocs-ui/layouts/docs/page";
import { notFound } from "next/navigation";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { source } from "@/lib/source";
import type { MDXContent } from "mdx/types";
import type { TOCItemType } from "fumadocs-core/toc";

export default async function Page({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const data = page.data as unknown as {
    body: MDXContent;
    toc: TOCItemType[];
    title: string;
    description?: string;
    full?: boolean;
  };

  const MDX = data.body;

  return (
    <DocsPage toc={data.toc} full={data.full}>
      <DocsBody>
        <h1>{data.title}</h1>
        {data.description && (
          <p className="text-lg opacity-70 mb-6">{data.description}</p>
        )}
        <MDX components={{ ...defaultMdxComponents }} />
      </DocsBody>
    </DocsPage>
  );
}

export async function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const page = source.getPage(slug);
  if (!page) notFound();

  const data = page.data as unknown as { title: string; description?: string };

  return {
    title: data.title,
    description: data.description,
  };
}
