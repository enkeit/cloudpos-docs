// Docs retrieval: MDX pages from cloudpos-docs/content/docs are split into
// heading-sized chunks, embedded with bge-m3 (multilingual) and stored in
// Vectorize. chunkMdx() is shared by the indexing script and the tests.

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;
const MAX_CHUNK = 1400;

export interface DocChunk {
  id: string;
  url: string; // site path, e.g. /docs/pos-app/billing
  title: string;
  heading: string;
  text: string;
}

/** content/docs/pos-app/index.mdx → /docs/pos-app */
export function urlForDocPath(relativePath: string): string {
  const clean = relativePath.replace(/\\/g, "/").replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
  return `/docs${clean ? `/${clean}` : ""}`;
}

function frontmatter(source: string): { body: string; title?: string; description?: string } {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: source };
  const field = (name: string) => m[1].match(new RegExp(`^${name}:\\s*["']?(.+?)["']?\\s*$`, "m"))?.[1];
  return { body: source.slice(m[0].length), title: field("title"), description: field("description") };
}

/** MDX → plain-ish markdown: drop imports/exports and JSX tags, keep text. */
function plain(body: string): string {
  return body
    .replace(/^(import|export)\s.*$/gm, "")
    .replace(/<\/?[A-Z][\w.]*[^>]*>/g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHUNK) return [text];
  const parts: string[] = [];
  let current = "";
  for (const para of text.split(/\n\n+/)) {
    if (current && current.length + para.length + 2 > MAX_CHUNK) {
      parts.push(current);
      current = "";
    }
    if (para.length > MAX_CHUNK) {
      for (let i = 0; i < para.length; i += MAX_CHUNK) parts.push(para.slice(i, i + MAX_CHUNK));
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function chunkMdx(relativePath: string, source: string): DocChunk[] {
  const url = urlForDocPath(relativePath);
  const { body, title: fmTitle, description } = frontmatter(source);
  const text = plain(body);
  const title = fmTitle || text.match(/^#\s+(.+)$/m)?.[1]?.trim() || url;
  const sections: Array<{ heading: string; text: string }> = [];
  let heading = title;
  let buffer: string[] = description ? [description] : [];
  const flush = () => {
    const t = buffer.join("\n").trim();
    if (t.length > 40) sections.push({ heading, text: t });
    buffer = [];
  };
  for (const line of text.split("\n")) {
    const h = line.match(/^(#{1,3})\s+(.+)$/);
    if (h && h[1].length >= 2) {
      flush();
      heading = h[2].trim();
    } else if (!(h && h[1].length === 1)) {
      buffer.push(line);
    }
  }
  flush();
  const chunks: DocChunk[] = [];
  for (const s of sections) {
    for (const part of splitLong(s.text)) {
      chunks.push({ id: `${url}#${chunks.length}`.slice(0, 64), url, title, heading: s.heading, text: part });
    }
  }
  return chunks;
}

/** Text that gets embedded: page and section titles add useful context. */
export function embeddingText(c: Pick<DocChunk, "title" | "heading" | "text">): string {
  return `${c.title}${c.heading && c.heading !== c.title ? ` › ${c.heading}` : ""}\n${c.text}`;
}

export async function embed(ai: Ai, texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const res = (await ai.run(EMBEDDING_MODEL as keyof AiModels, { text: texts.slice(i, i + 50) } as never)) as unknown as {
      data?: number[][];
      response?: number[][];
    };
    const vectors = res.data ?? res.response;
    if (!Array.isArray(vectors)) throw new Error("Embedding model returned no vectors.");
    out.push(...vectors);
  }
  return out;
}

export interface DocHit {
  url: string;
  title: string;
  heading: string;
  text: string;
  score: number;
}

export async function searchDocs(ai: Ai, index: VectorizeIndex, query: string, topK = 5, minScore = 0.35): Promise<DocHit[]> {
  const [vector] = await embed(ai, [query]);
  const res = await index.query(vector, { topK, returnMetadata: "all" });
  return res.matches
    .filter((m) => m.score >= minScore && m.metadata)
    .map((m) => {
      const md = m.metadata as Record<string, string>;
      return { url: md.url, title: md.title, heading: md.heading, text: md.text, score: Math.round(m.score * 1000) / 1000 };
    });
}
