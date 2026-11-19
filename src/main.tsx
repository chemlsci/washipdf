// 画面の明るさは、ほかのどの部品よりも先に当てる（この行を最初に置く。読み込んだ時点で <html data-theme> が付く）。
// アプリ本体の準備（PDF の部品の読み込みなど）を待ってから当てると、そのあいだ、選んだ明るさと違う色の画面が見えてしまう
import "@/lib/theme";
import { installNavGuard } from "@/lib/navGuard";
import { warmAssets } from "@/lib/assets";
import { defaultFont } from "@/lib/fonts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import WashiPdf from "@/components/WashiPdf";
import "./styles.css";

// アプリの外のページへ移る前に尋ねる（CSP で止められない、移動先のアドレスを使った持ち出しへの備え）
installNavGuard();

// 縮めて埋め込んだ部品のうち、すぐ使うもの（PDF の部品と、その版の既定のフォント 2 つ）を、画面が出たあとの空いた時間に
// ブラウザーの展開の機能で戻しておく（初めて PDF を開くときの待ち時間を減らす。ほかのフォントは使うときに戻す）
setTimeout(() => warmAssets(["pdf-worker", "pdf-data", `font-${defaultFont("sans")}`, `font-${defaultFont("serif")}`]), 300);

// いちばん外側の備え：どこかの描画で思わぬ例外が出ても、真っ白な画面にせず、案内を出す
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <WashiPdf />
    </ErrorBoundary>
  </StrictMode>,
);
