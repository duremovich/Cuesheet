import { describe, expect, it } from "vitest";
import type { UploadUrlRequest } from "../../../shared/api";
import { MAX_ATTACHMENT_BYTES } from "../../../shared/attachments";
import { progressOf, UploadQueue, type UploadTransport, uploadsFor } from "./uploads";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A transport whose PUTs finish when the test says so. */
function fakeTransport() {
  const reserved: UploadUrlRequest[] = [];
  const puts: {
    url: string;
    contentType: string;
    progress: (n: number) => void;
    done: ReturnType<typeof deferred<void>>;
  }[] = [];
  const transport: UploadTransport = {
    reserve: async (_showId, req) => {
      reserved.push(req);
      return {
        attachmentId: `a${reserved.length}`,
        uploadUrl: `/u/${reserved.length}`,
        contentType: req.contentType || "image/png",
      };
    },
    put: (url, _file, contentType, progress) => {
      const done = deferred<void>();
      puts.push({ url, contentType, progress, done });
      return done.promise;
    },
  };
  return { transport, reserved, puts };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const png = (name = "a.png", size = 100) =>
  new File([new Uint8Array(size)], name, { type: "image/png" });

describe("upload queue", () => {
  it("reserves and PUTs files with progress; a finished item leaves the queue", async () => {
    const { transport, reserved, puts } = fakeTransport();
    const q = new UploadQueue(transport);
    const [item] = q.add("show", { table: "content", recordId: "c1" }, [png()]);
    expect(item).toMatchObject({ status: "waiting", filename: "a.png", size: 100 });
    await tick();
    expect(reserved).toEqual([
      {
        table: "content",
        recordId: "c1",
        field: "attachments",
        filename: "a.png",
        contentType: "image/png",
        size: 100,
      },
    ]);
    expect(q.getItems()[0]?.status).toBe("uploading");
    puts[0]?.progress(40);
    expect(progressOf(q.getItems()[0] as never)).toBeCloseTo(0.4);
    expect(uploadsFor(q.getItems(), "content", "c1")).toHaveLength(1);
    puts[0]?.done.resolve();
    await q.idle();
    expect(q.getItems()).toEqual([]);
  });

  it("refuses unsupported types and oversize files at once, with a message", () => {
    const errors: string[] = [];
    const q = new UploadQueue(fakeTransport().transport, {
      onError: (i) => errors.push(i.error ?? ""),
    });
    const items = q.add("show", { table: "notes", recordId: "n1" }, [
      new File(["x"], "IMG_1.HEIC", { type: "image/heic" }),
      new File(["x"], "setup.exe", { type: "application/x-msdownload" }),
      { name: "huge.mp4", type: "video/mp4", size: MAX_ATTACHMENT_BYTES + 1 } as File,
    ]);
    expect(items.map((i) => i.status)).toEqual(["error", "error", "error"]);
    expect(errors[0]).toMatch(/HEIC/);
    expect(errors[2]).toMatch(/over 25 MB/);
    q.dismiss(items[0]?.key ?? "");
    expect(q.getItems()).toHaveLength(2);
  });

  it("uploads at most two at a time, in order", async () => {
    const { transport, puts } = fakeTransport();
    const q = new UploadQueue(transport);
    q.add("show", { table: "content", recordId: "c1" }, [png("1.png"), png("2.png"), png("3.png")]);
    await tick();
    await tick();
    expect(puts.map((p) => p.url)).toEqual(["/u/1", "/u/2"]);
    puts[0]?.done.resolve();
    await tick();
    await tick();
    await tick();
    expect(puts.map((p) => p.url)).toEqual(["/u/1", "/u/2", "/u/3"]);
  });

  it("waits for its record (a note being saved) before reserving", async () => {
    const { transport, reserved, puts } = fakeTransport();
    const q = new UploadQueue(transport);
    const saved = deferred();
    q.add("show", { table: "notes", recordId: "n1" }, [png()], { ready: saved.promise });
    await tick();
    expect(reserved).toHaveLength(0);
    saved.resolve();
    await tick();
    await tick();
    expect(reserved).toHaveLength(1);
    puts[0]?.done.resolve();
    await q.idle();
  });

  it("a failed record or PUT leaves an error item", async () => {
    const { transport, puts } = fakeTransport();
    const errors: string[] = [];
    const q = new UploadQueue(transport, { onError: (i) => errors.push(i.error ?? "") });
    const failedNote = deferred();
    q.add("show", { table: "notes", recordId: "n1" }, [png("x.png")], {
      ready: failedNote.promise,
    });
    failedNote.reject(new Error("offline"));
    q.add("show", { table: "content", recordId: "c1" }, [png("y.png")]);
    await tick();
    await tick();
    puts[0]?.done.reject(new Error("Show storage is full"));
    await q.idle();
    expect(q.getItems().map((i) => [i.filename, i.status])).toEqual([
      ["x.png", "error"],
      ["y.png", "error"],
    ]);
    expect(errors).toEqual([
      "The record wasn't saved, so its files weren't uploaded",
      "Show storage is full",
    ]);
  });

  it("prepares files first (a huge photo scaled down) and sends its original size", async () => {
    const { transport, reserved, puts } = fakeTransport();
    const small = new Blob([new Uint8Array(10)], { type: "image/jpeg" });
    const q = new UploadQueue(transport, {
      prepare: async () => ({ file: small, originalSize: { width: 8000, height: 6000 } }),
    });
    // Over the size limit before preparing is fine: the limit applies to what's sent.
    const big = { name: "huge.jpg", type: "image/jpeg", size: MAX_ATTACHMENT_BYTES + 5 } as File;
    const [item] = q.add("show", { table: "content", recordId: "c1" }, [big]);
    expect(item?.status).toBe("waiting");
    await tick();
    await tick();
    expect(reserved[0]).toMatchObject({ size: 10, originalSize: { width: 8000, height: 6000 } });
    puts[0]?.done.resolve();
    await q.idle();
    const tooBig = new UploadQueue(transport, { prepare: async (f) => ({ file: f }) });
    tooBig.add("show", { table: "content", recordId: "c1" }, [big]);
    await tooBig.idle();
    expect(tooBig.getItems()[0]).toMatchObject({ status: "error", error: /over 25 MB/ });
  });

  it("reserves in the order files were added, even when one is prepared faster", async () => {
    const { transport, reserved, puts } = fakeTransport();
    const slow = deferred<{ file: Blob }>();
    const q = new UploadQueue(transport, {
      concurrency: 3,
      prepare: (f) => (f.name === "1.png" ? slow.promise : Promise.resolve({ file: f })),
    });
    q.add("show", { table: "content", recordId: "c1" }, [png("1.png"), png("2.png"), png("3.png")]);
    await tick();
    await tick();
    expect(reserved).toEqual([]); // 2 and 3 wait for 1
    slow.resolve({ file: png("1.png") });
    for (let i = 0; i < 6; i++) await tick();
    expect(reserved.map((r) => r.filename)).toEqual(["1.png", "2.png", "3.png"]);
    for (const p of puts) p.done.resolve();
    await q.idle();
  });

  it("refuses empty files at once", () => {
    const q = new UploadQueue(fakeTransport().transport);
    const [item] = q.add("show", { table: "content", recordId: "c1" }, [
      new File([], "empty.png", { type: "image/png" }),
    ]);
    expect(item).toMatchObject({ status: "error", error: "empty.png is empty" });
  });
});
