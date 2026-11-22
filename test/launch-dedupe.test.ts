import assert from "node:assert/strict";
import { test } from "node:test";
import { isDuplicateLaunch, LAUNCH_WINDOW_MS, launchKey } from "@/lib/launchDedupe";

const key = launchKey([{ name: "見積書.pdf", size: 1234, lastModified: 1700000000000 }]);

test("「開く」の重複：同じファイルを同時に受け取った 2 つのウィンドウは、ちょうど 1 つだけが閉じる", () => {
  const a = { key, at: 1000, id: "a" };
  const b = { key, at: 1000, id: "b" };
  assert.equal(isDuplicateLaunch(a, b), false);
  assert.equal(isDuplicateLaunch(b, a), true);
  const early = { key, at: 1000, id: "z" };
  const late = { key, at: 1200, id: "a" };
  assert.equal(isDuplicateLaunch(early, late), false);
  assert.equal(isDuplicateLaunch(late, early), true);
});

test("「開く」の重複：違うファイル・時間が離れた開き直し・自分自身は閉じない", () => {
  const a = { key, at: 1000, id: "a" };
  const other = { key: launchKey([{ name: "別.pdf", size: 1, lastModified: 1 }]), at: 1000, id: "0" };
  assert.equal(isDuplicateLaunch(a, other), false);
  assert.equal(isDuplicateLaunch({ key, at: 1000 + LAUNCH_WINDOW_MS + 1, id: "b" }, a), false);
  assert.equal(isDuplicateLaunch(a, a), false);
});

test("「開く」の重複：知らせ合い（BroadcastChannel）で、先のウィンドウは残り、あとのウィンドウだけが閉じる。遅れて開いたウィンドウも閉じる", async () => {
  const { announceLaunch } = await import("@/lib/launchDedupe");
  const closed: string[] = [];
  const first = announceLaunch(key, () => closed.push("first"));
  await new Promise((r) => setTimeout(r, 30));
  const second = announceLaunch(key, () => closed.push("second"));
  // 先のウィンドウはファイルを開き（false）、あとのウィンドウは開かずに閉じる（true）
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.deepEqual(closed, ["second"]);
  // 違うファイルなら閉じない
  void announceLaunch(launchKey([{ name: "別.pdf", size: 9, lastModified: 9 }]), () => closed.push("other"));
  await new Promise((r) => setTimeout(r, LAUNCH_WINDOW_MS + 200));
  assert.deepEqual(closed, ["second"]);
});
