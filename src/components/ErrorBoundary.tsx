import { Component, type ErrorInfo, type ReactNode } from "react";
import { tr } from "@/lib/i18n";

interface Props {
  children: ReactNode;
  /**
   * 描画中に例外が出たときに、代わりに出すもの。reset を呼ぶと、もう一度中身を描く。
   * 省略すると、画面全体の案内（読み込み直す・続ける）を出す
   */
  fallback?: (error: unknown, reset: () => void) => ReactNode;
  onError?: (error: unknown) => void;
}

/**
 * 描画中の思わぬ例外で、画面が真っ白になるのを防ぐ。
 * 例外が出た部分だけを案内に置き換え、外側（開いている文書・編集の履歴を持つ部分）は生かしたままにする。
 */
export class ErrorBoundary extends Component<Props, { error: unknown; failed: boolean }> {
  state = { error: null as unknown, failed: false };

  static getDerivedStateFromError(error: unknown) {
    return { error, failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // 原因を調べられるよう、コンソールには残す（外部へは送らない）
    console.error("render error", error, info.componentStack);
    this.props.onError?.(error);
  }

  reset = () => this.setState({ error: null, failed: false });

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, this.reset);
    return <CrashScreen error={this.state.error} onRetry={this.reset} />;
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** 例外の案内。文言は React の外でも引けるもの（tr）を使う（言語の状態を持つ部分ごと失われている場合があるため） */
export function CrashNotice({ error, children }: { error: unknown; children: ReactNode }) {
  return (
    <div className="crash" role="alert">
      <h2>{tr("crash.title")}</h2>
      <p>{tr("crash.body")}</p>
      <pre className="crash-detail">{messageOf(error).slice(0, 500)}</pre>
      <div className="crash-actions">{children}</div>
    </div>
  );
}

/** 画面全体が描けなくなったときの最後の案内 */
function CrashScreen({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div className="crash-screen">
      <CrashNotice error={error}>
        <button className="btn primary" onClick={onRetry}>
          {tr("crash.retry")}
        </button>
        <button className="btn" onClick={() => location.reload()}>
          {tr("crash.reload")}
        </button>
      </CrashNotice>
      <p className="note">{tr("crash.reloadNote")}</p>
    </div>
  );
}
