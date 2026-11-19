import assert from "node:assert/strict";
import { test } from "node:test";
import { type FileHandle, removeIfEmpty, WriteFailed, writeToHandle } from "@/lib/saveTargets";

/** 保存先のファイルの模擬。中身・更新時刻・呼ばれた操作を持つ */
function fakeFile(initial: Uint8Array | null, behaviour: { write?: "ok" | "throw" | "drop" | "half"; close?: "ok" | "throw"; failFirst?: number } = {}) {
  const state = { content: initial, modified: 1000, calls: [] as string[], attempts: 0 };
  const handle = {
    kind: "file",
    name: "contract.pdf",
    getFile: async () => {
      if (state.content === null) throw new DOMException("gone", "NotFoundError");
      return new File([state.content as BlobPart], "contract.pdf", { lastModified: state.modified });
    },
    createWritable: async () => {
      state.calls.push("createWritable");
      state.attempts++;
      let pending: Uint8Array | null = null;
      const failing = state.attempts <= (behaviour.failFirst ?? Infinity);
      return {
        write: async (data: BufferSource | Blob) => {
          state.calls.push("write");
          if (failing && behaviour.write === "throw") throw new DOMException("disk full", "QuotaExceededError");
          const all = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data as ArrayBuffer);
          pending = failing && behaviour.write === "half" ? all.slice(0, all.length >> 1) : all;
        },
        close: async () => {
          state.calls.push("close");
          if (failing && behaviour.close === "throw") throw new DOMException("errored", "InvalidStateError");
          if (failing && behaviour.write === "drop") return;
          // close() で初めて保存先と入れ替わる
          state.content = pending ?? new Uint8Array(0);
          state.modified += 1;
        },
        abort: async () => {
          state.calls.push("abort");
        },
      };
    },
    remove: async () => {
      state.calls.push("remove");
      state.content = null;
    },
  };
  return { handle: handle as unknown as FileHandle, state };
}

const original = new TextEncoder().encode("%PDF-1.7 ORIGINAL CONTRACT");
const edited = new TextEncoder().encode("%PDF-1.7 edited contents, longer than the original");

test("上書き保存：書けたら中身が入れ替わる", async () => {
  const { handle, state } = fakeFile(original);
  await writeToHandle(handle, edited);
  assert.deepEqual(state.content, edited);
  assert.ok(!state.calls.includes("remove"));
});

test("上書き保存：書き込みが失敗しても（容量不足など）、元のファイルを消さず、中身もそのまま", async () => {
  const { handle, state } = fakeFile(original, { write: "throw" });
  await assert.rejects(writeToHandle(handle, edited), (e) => e instanceof WriteFailed && e.fileState === "intact");
  assert.deepEqual(state.content, original, "元の中身が残っている");
  assert.ok(!state.calls.includes("remove"), "remove() を呼んでいない");
  assert.ok(!state.calls.includes("close"), "失敗した書き込みを close() していない（途中までの中身で置き換えない）");
  assert.ok(state.calls.includes("abort"));
});

test("上書き保存：close() が失敗しても、元のファイルを消さない", async () => {
  const { handle, state } = fakeFile(original, { close: "throw" });
  await assert.rejects(writeToHandle(handle, edited), (e) => e instanceof WriteFailed && e.fileState === "intact");
  assert.deepEqual(state.content, original);
  assert.ok(!state.calls.includes("remove"));
});

test("上書き保存：書き込みが黙って捨てられても、前からあったファイルは消さない", async () => {
  const { handle, state } = fakeFile(original, { write: "drop" });
  await assert.rejects(writeToHandle(handle, edited), (e) => e instanceof WriteFailed && e.fileState === "intact");
  assert.deepEqual(state.content, original);
  assert.ok(!state.calls.includes("remove"));
});

test("上書き保存：途中までしか書かれなかったら、壊れたことを伝える（消しはしない）", async () => {
  const { handle, state } = fakeFile(original, { write: "half" });
  await assert.rejects(writeToHandle(handle, edited), (e) => e instanceof WriteFailed && e.fileState === "damaged");
  assert.ok(state.content !== null, "ファイルは残っている");
  assert.ok(!state.calls.includes("remove"));
});

test("名前を付けて保存：置き換える先に選んだ既存のファイルは、失敗しても消さない", async () => {
  const { handle, state } = fakeFile(original, { write: "throw" });
  await assert.rejects(writeToHandle(handle, edited, { fresh: true }), (e) => e instanceof WriteFailed && e.fileState === "intact");
  assert.deepEqual(state.content, original);
  assert.ok(!state.calls.includes("remove"));
});

test("名前を付けて保存：今回できた空のファイルだけは片付ける", async () => {
  for (const write of ["throw", "drop"] as const) {
    const { handle, state } = fakeFile(new Uint8Array(0), { write });
    await assert.rejects(writeToHandle(handle, edited, { fresh: true }), (e) => e instanceof WriteFailed && e.fileState === "removed");
    assert.ok(state.calls.includes("remove"), `${write}: 空のファイルを片付けた`);
  }
  // 同じ空のファイルでも、今回作ったものでなければ（2 回目以降の保存）消さない
  const { handle, state } = fakeFile(new Uint8Array(0), { write: "throw" });
  await assert.rejects(writeToHandle(handle, edited), WriteFailed);
  assert.ok(!state.calls.includes("remove"));
});

test("1 回目の渡し方で失敗しても、2 回目で書ければ成功", async () => {
  for (const b of [{ write: "throw" as const }, { write: "drop" as const }, { write: "half" as const }]) {
    const { handle, state } = fakeFile(original, { ...b, failFirst: 1 });
    await writeToHandle(handle, edited);
    assert.deepEqual(state.content, edited);
  }
});

test("大きさが同じでも中身が違えば、書けたとはみなさない", async () => {
  const { handle, state } = fakeFile(original);
  const real = handle.createWritable.bind(handle);
  (handle as unknown as { createWritable: unknown }).createWritable = async () => {
    const w = (await real()) as unknown as { write: (d: BufferSource | Blob) => Promise<void>; close: () => Promise<void> };
    return { ...w, write: async () => w.write(new Uint8Array(edited.length)) };
  };
  await assert.rejects(writeToHandle(handle, edited), (e) => e instanceof WriteFailed && e.fileState === "damaged");
  assert.ok(!state.calls.includes("remove"));
});

test("保存先を選んだだけで何も書かなかったとき：空のファイルだけを片付ける", async () => {
  const empty = fakeFile(new Uint8Array(0));
  await removeIfEmpty(empty.handle);
  assert.ok(empty.state.calls.includes("remove"));
  const full = fakeFile(original);
  await removeIfEmpty(full.handle);
  assert.ok(!full.state.calls.includes("remove"), "中身のあるファイルは消さない");
  const gone = fakeFile(null);
  await removeIfEmpty(gone.handle);
  assert.ok(!gone.state.calls.includes("remove"), "大きさを確かめられないファイルには触れない");
});
