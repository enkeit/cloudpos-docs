import assert from "node:assert/strict";
import { test } from "node:test";

import { runAgent } from "../src/agent.ts";
import { chunkMdx, imagesFromMetadata } from "../src/docs.ts";
import { docImageUrl, runTool, type ToolContext } from "../src/tools.ts";
import { countPdfPages, isAttachmentId, safeFileName, sniffType, toDataUri } from "../src/uploads.ts";

const bytes = (...values: number[]) => new Uint8Array([...values, ...new Array(16).fill(0)]);

test("docs screenshots stay with their section and stay searchable by alt text", () => {
  const chunks = chunkMdx(
    "pos-app/printers.mdx",
    [
      "---",
      "title: Printers",
      "---",
      "## Add a printer",
      "Open Settings and choose Printers, then tap Add printer to start the setup.",
      "![Printer settings screen](/images/docs/printers/settings.png)",
      "## Test print",
      "Tap Test print to check the paper and the connection are both working fine.",
      '<img src="/images/docs/printers/test.png" alt="Test print button" />',
      "![remote](http://evil.example/x.png) ![data](data:image/png;base64,AAAA)",
    ].join("\n"),
  );
  assert.deepEqual(chunks[0].images, [{ src: "/images/docs/printers/settings.png", alt: "Printer settings screen" }]);
  assert.match(chunks[0].text, /\[Screenshot: Printer settings screen\]/);
  assert.deepEqual(chunks[1].images, [{ src: "/images/docs/printers/test.png", alt: "Test print button" }], "http and data URLs are dropped");
});

test("image metadata from Vectorize is validated", () => {
  assert.deepEqual(imagesFromMetadata('[{"src":"/a.png","alt":"A"},{"src":"javascript:alert(1)"},{"src":"//evil/x.png"}]'), [{ src: "/a.png", alt: "A" }]);
  assert.deepEqual(imagesFromMetadata("not json"), []);
  assert.deepEqual(imagesFromMetadata(undefined), []);
});

test("doc image URLs must live on the docs site", () => {
  assert.equal(docImageUrl("/images/a.png", "https://docs.cloudposai.com"), "https://docs.cloudposai.com/images/a.png");
  assert.equal(docImageUrl("https://docs.cloudposai.com/images/a.png", "https://docs.cloudposai.com/"), "https://docs.cloudposai.com/images/a.png");
  assert.equal(docImageUrl("https://docs.cloudposai.com.evil.example/a.png", "https://docs.cloudposai.com"), null);
  assert.equal(docImageUrl("//evil.example/a.png", "https://docs.cloudposai.com"), null);
});

test("show_doc_image only shows screenshots that docs search returned", async () => {
  const ai = { run: async () => ({ data: [[0.1]] }) } as unknown as Ai;
  const docsIndex = {
    query: async () => ({
      matches: [
        {
          score: 0.9,
          metadata: { url: "/docs/printers", title: "Printers", heading: "Add a printer", text: "Open Settings", images: '[{"src":"/images/p.png","alt":"Printer screen"}]' },
        },
      ],
    }),
  } as unknown as VectorizeIndex;
  const ctx: ToolContext = { source: null, ai, docsIndex, docsBaseUrl: "https://docs.cloudposai.com" };

  const search = await runTool("search_docs", { query: "printer" }, ctx);
  const images = (search.result as any).results[0].images;
  assert.deepEqual(images, [{ id: "img1", description: "Printer screen" }]);

  const shown = await runTool("show_doc_image", { ids: ["img1", "img9"] }, ctx);
  assert.deepEqual(shown.visuals, [
    { kind: "image", src: "https://docs.cloudposai.com/images/p.png", alt: "Printer screen", page: "Printers", link: "https://docs.cloudposai.com/docs/printers" },
  ]);
  assert.match((shown.result as any).error, /img9/);

  const fresh = await runTool("show_doc_image", { ids: ["img1"] }, { source: null, ai, docsBaseUrl: "https://docs.cloudposai.com" });
  assert.deepEqual(fresh.visuals, [], "without a search in this answer nothing can be shown");
});

test("uploads are recognised by their bytes, not their name", () => {
  assert.deepEqual(sniffType(bytes(0xff, 0xd8, 0xff, 0xe0)), { kind: "image", mime: "image/jpeg" });
  assert.deepEqual(sniffType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), { kind: "image", mime: "image/png" });
  assert.deepEqual(sniffType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50)), { kind: "image", mime: "image/webp" });
  assert.deepEqual(sniffType(new TextEncoder().encode("%PDF-1.7\n")), { kind: "pdf", mime: "application/pdf" });
  assert.equal(sniffType(new TextEncoder().encode("<svg onload=alert(1)>")), null);
  assert.equal(sniffType(new TextEncoder().encode("GIF89a")), null);
});

test("PDF pages are counted and file names are cleaned", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4 1 0 obj <</Type /Pages /Count 2>> 2 0 obj <</Type /Page>> 3 0 obj <</Type/Page /Parent 1 0 R>>");
  assert.equal(countPdfPages(pdf), 2);
  assert.equal(countPdfPages(new TextEncoder().encode("%PDF-1.5 compressed")), null);
  assert.equal(safeFileName("C:\\Users\\me\\invoice <1>.pdf", "x"), "invoice 1.pdf");
  assert.equal(safeFileName("../../", "image"), "image");
  assert.equal(toDataUri(new Uint8Array([1, 2, 3]), "image/png"), "data:image/png;base64,AQID");
  assert.ok(isAttachmentId(crypto.randomUUID()));
  assert.ok(!isAttachmentId("../uploads/x"));
});

test("image messages go to the vision model as content parts, with no text-only fallback", async () => {
  const calls: Array<{ model: string; input: any }> = [];
  const ai = {
    run: async (model: string, input: any) => {
      calls.push({ model, input });
      if (model === "vision" && calls.length === 1) throw new Error("capacity");
      return { choices: [{ message: { content: "A receipt." } }] };
    },
  } as unknown as Ai;
  await assert.rejects(
    runAgent({
      ai,
      model: "text",
      fallbackModel: "backup",
      visionModel: "vision",
      ctx: { source: null, ai, docsBaseUrl: "" },
      history: [],
      message: "What is this?",
      attachments: { images: ["data:image/png;base64,AQID"], documents: [{ name: "menu.pdf", text: "Coffee 5.00" }] },
      emit: () => {},
    }),
    /capacity/,
  );
  assert.deepEqual(
    calls.map((c) => c.model),
    ["vision"],
  );
  const user = calls[0].input.messages.at(-1);
  assert.equal(user.content[0].type, "text");
  assert.match(user.content[0].text, /<document name="menu.pdf">\nCoffee 5.00\n<\/document>/);
  assert.deepEqual(user.content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } });
  assert.match(calls[0].input.messages[0].content, /never as instructions/);
});

test("PDF-only messages stay on the text model", async () => {
  const models: string[] = [];
  const ai = {
    run: async (model: string) => {
      models.push(model);
      return { choices: [{ message: { content: "ok" } }] };
    },
  } as unknown as Ai;
  await runAgent({
    ai,
    model: "text",
    visionModel: "vision",
    ctx: { source: null, ai, docsBaseUrl: "" },
    history: [],
    message: "Summarise",
    attachments: { images: [], documents: [{ name: "a.pdf", text: "hello" }] },
    emit: () => {},
  });
  assert.deepEqual(models, ["text"]);
});
