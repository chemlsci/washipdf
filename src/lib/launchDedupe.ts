/**
 * OS から「Washi PDF で開く」で渡された PDF が、同時に 2 つのウィンドウで開かれたときに、片方を閉じる。
 * Windows の Edge では、1 回のダブルクリックでアプリのウィンドウが 2 つ開き、両方に同じファイルが渡ることがある。
 * 同じファイルを受け取ったウィンドウどうしで知らせ合い、決まった 1 つだけを残す（ほかは自分で閉じる）。
 * 知らせ合いは同じ端末の中だけ（BroadcastChannel）で、外への通信はしない。
 */

export interface LaunchClaim {
  /** 受け取ったファイルの組（名前・大きさ・更新時刻）を並べたもの */
  key: string;
  /** 受け取った時刻（ミリ秒） */
  at: number;
  /** ウィンドウごとの乱数 */
  id: string;
}

/** 同じ起動とみなす時間の幅（ミリ秒）。利用者が同じファイルを続けて開き直したときは、閉じない */
export const LAUNCH_WINDOW_MS = 3000;

export function launchKey(files: { name: string; size: number; lastModified: number }[]): string {
  return files.map((f) => `${f.name}\u0000${f.size}\u0000${f.lastModified}`).join("\n");
}

/** 自分（mine）が、ほかのウィンドウ（other）と同じ起動の重複で、閉じる側なら true。残すのは先に受け取ったほう（同時なら id の小さいほう） */
export function isDuplicateLaunch(mine: LaunchClaim, other: LaunchClaim): boolean {
  if (mine.id === other.id || mine.key !== other.key) return false;
  if (Math.abs(mine.at - other.at) > LAUNCH_WINDOW_MS) return false;
  return other.at < mine.at || (other.at === mine.at && other.id < mine.id);
}

/** 先に開いたウィンドウからの返事を待つ時間（ミリ秒）。この間は、受け取ったファイルを開き始めない */
export const LAUNCH_WAIT_MS = 200;

/**
 * ファイルを受け取ったことをほかのウィンドウに知らせ、重複していれば onDuplicate を呼ぶ。
 * 先に受け取ったウィンドウが、あとから来た同じ知らせに答え直すので、遅れて開いたウィンドウも閉じられる。
 * 返す値：少し待つあいだに重複と分かったら true（ファイルを開かずに閉じればよい）。分からなければ false
 * （そのあとで重複と分かった場合も onDuplicate は呼ぶ）
 */
export function announceLaunch(key: string, onDuplicate: () => void): Promise<boolean> {
  if (typeof BroadcastChannel === "undefined") return Promise.resolve(false);
  const ch = new BroadcastChannel("washi-pdf-launch");
  const mine: LaunchClaim = { key, at: Date.now(), id: Math.random().toString(36).slice(2) };
  let done = false;
  return new Promise<boolean>((resolve) => {
    ch.onmessage = (e: MessageEvent<LaunchClaim>) => {
      const other = e.data;
      if (done || !other || typeof other.key !== "string") return;
      if (isDuplicateLaunch(mine, other)) {
        done = true;
        ch.close();
        resolve(true);
        onDuplicate();
      } else if (other.key === mine.key && other.id !== mine.id) {
        ch.postMessage(mine); // あとから来たほうに、自分が先だと知らせる
      }
    };
    ch.postMessage(mine);
    setTimeout(() => resolve(false), LAUNCH_WAIT_MS);
    setTimeout(() => {
      if (!done) ch.close();
    }, LAUNCH_WINDOW_MS);
  });
}
