import { useT } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { normRot } from "@/lib/geometry";
import { getThumbnail } from "@/lib/render";
import type { PageItem, SourceDoc } from "@/lib/types";

export function Thumb({ page, source, size = 150 }: { page: PageItem; source?: SourceDoc; size?: number }) {
  const t = useT();
  // 元の向き（/Rotate）で描いたものをキャッシュし、ユーザーの回転は CSS で回す（回転のたびに描き直さない）
  const rotation = normRot(page.baseRotation);
  const extra = normRot(page.extraRotation);
  const [url, setUrl] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // 画面に近づいたページだけ描画する（数百ページのPDFでも重くならないように）
  useEffect(() => {
    const el = ref.current;
    if (!el || visible) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "400px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!source || !visible) return;
    let alive = true;
    getThumbnail(source, page.srcIndex, rotation).then(
      (u) => alive && setUrl(u),
      (e) => console.warn("thumbnail failed", e),
    );
    return () => {
      alive = false;
    };
  }, [source, page.srcIndex, rotation, visible]);

  const swap = extra % 180 !== 0;
  const w = swap ? page.height : page.width;
  const h = swap ? page.width : page.height;
  const k = size / Math.max(w, h);
  // 画像は元の向きのサイズで置き、中心で回す
  const iw = page.width * k;
  const ih = page.height * k;

  return (
    <div className="thumb" ref={ref} style={{ width: size, height: size }}>
      {source ? (
        url ? (
          <div className="thumb-rot" style={{ width: w * k, height: h * k }}>
            <img src={url} alt="" draggable={false} style={{ width: iw, height: ih, transform: extra ? `translate(-50%, -50%) rotate(${extra}deg)` : undefined }} className={extra ? "rotated" : ""} />
          </div>
        ) : (
          <div className="thumb-ph" style={{ width: w * k, height: h * k }} />
        )
      ) : (
        <div className="thumb-blank" style={{ width: w * k, height: h * k }}>
          {t("common.blank")}
        </div>
      )}
    </div>
  );
}
