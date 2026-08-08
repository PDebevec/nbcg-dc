import { describe, it, expect } from "vitest";
import { ApiClient, type FetchLike } from "./client";
import type { FileAttachment } from "./dto";
import {
  uploadFiles,
  replaceFile,
  setFileText,
  reextractFile,
  listFiles,
  deleteFile,
  type UploadFile,
} from "./files";

interface Call {
  method: string;
  url: string;
  body: BodyInit | null | undefined;
}

function harness(step: () => Response) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ method: init?.method ?? "GET", url, body: init?.body });
    return step();
  };
  const client = new ApiClient({ baseUrl: "https://api.test", apiPrefix: "/api", fetchImpl });
  return { client, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function form(call: Call): FormData {
  expect(call.body).toBeInstanceOf(FormData);
  return call.body as FormData;
}

function blobFile(name: string, content = "bytes"): UploadFile {
  return { blob: new Blob([content]), filename: name };
}

const ATTACHMENT: FileAttachment = {
  id: "f1",
  draft_id: null,
  record_id: "rec_1",
  fileType: "PDF",
  role: "WEB",
  originalFid: "fid",
  filename: "gorski.pdf",
  mimeType: "application/pdf",
  sizeBytes: 10,
  textExtractionStatus: "EXTRACTED",
  createdAt: "2026-08-06T00:00:00.000Z",
};

describe("uploadFiles", () => {
  it("POSTs multipart to /files/upload/:id with role, doOCR=false, extractedTexts", async () => {
    const { client, calls } = harness(() => json([ATTACHMENT]));
    const out = await uploadFiles(
      "rec_1",
      [blobFile("gorski.pdf"), blobFile("gorski2.pdf")],
      { role: "WEB", doOCR: false, extractedTexts: { "gorski.pdf": "hello" } },
      { client },
    );
    expect(out).toEqual([ATTACHMENT]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.test/api/files/upload/rec_1");

    const fd = form(calls[0]);
    const files = fd.getAll("files");
    expect(files).toHaveLength(2);
    expect((files[0] as File).name).toBe("gorski.pdf");
    expect(fd.get("role")).toBe("WEB");
    expect(fd.get("doOCR")).toBe("false");
    expect(fd.get("extractedTexts")).toBe(JSON.stringify({ "gorski.pdf": "hello" }));
  });

  it("omits extractedTexts when the map is empty", async () => {
    const { client, calls } = harness(() => json([ATTACHMENT]));
    await uploadFiles("rec_1", [blobFile("a.png")], { role: "THUMBNAIL", doOCR: false, extractedTexts: {} }, { client });
    expect(form(calls[0]).get("extractedTexts")).toBeNull();
  });
});

describe("replaceFile", () => {
  it("PUTs a single file to /files/:id with extractedText", async () => {
    const { client, calls } = harness(() => json(ATTACHMENT));
    const out = await replaceFile("f1", blobFile("gorski.pdf"), { doOCR: false, extractedText: "txt" }, { client });
    expect(out).toEqual(ATTACHMENT);
    expect(calls[0].method).toBe("PUT");
    expect(calls[0].url).toBe("https://api.test/api/files/f1");
    const fd = form(calls[0]);
    expect((fd.get("file") as File).name).toBe("gorski.pdf");
    expect(fd.get("extractedText")).toBe("txt");
    expect(fd.get("doOCR")).toBe("false");
  });
});

describe("setFileText", () => {
  it("PUTs /files/:id/text with the text body", async () => {
    const { client, calls } = harness(() => json({ updated: true }));
    expect(await setFileText("f1", "full text", { client })).toEqual({ updated: true });
    expect(calls[0].url).toBe("https://api.test/api/files/f1/text");
    expect(typeof calls[0].body).toBe("string");
    expect(JSON.parse(calls[0].body as string)).toEqual({ text: "full text" });
  });
});

describe("reextractFile", () => {
  it("POSTs /files/:id/extract", async () => {
    const { client, calls } = harness(() => json({ enqueued: true }));
    expect(await reextractFile("f1", { doOCR: true }, { client })).toEqual({ enqueued: true });
    expect(calls[0].url).toBe("https://api.test/api/files/f1/extract");
    expect(JSON.parse(calls[0].body as string)).toEqual({ doOCR: true });
  });
});

describe("listFiles", () => {
  it("GETs /files/:id", async () => {
    const { client, calls } = harness(() => json([ATTACHMENT]));
    expect(await listFiles("rec_1", { client })).toEqual([ATTACHMENT]);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe("https://api.test/api/files/rec_1");
  });
});

describe("deleteFile", () => {
  it("DELETEs /files/:id", async () => {
    const { client, calls } = harness(() => new Response("", { status: 200 }));
    await deleteFile("f1", { client });
    expect(calls[0].method).toBe("DELETE");
    expect(calls[0].url).toBe("https://api.test/api/files/f1");
  });
});
