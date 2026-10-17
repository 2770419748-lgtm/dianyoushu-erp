"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Alert, Button, Modal, Typography } from "antd";
import { startScanner, type ScannerHandle } from "@/lib/device/scanner";

// 共用的"扫码"按钮：点开弹窗调后置摄像头，扫到码交给 onCode。
// continuous = true 时扫完不关（盘点、入库连续扫）；false 时扫到一个就关（开单加一件）。
// 扫不了（电脑没摄像头、不是 HTTPS）也不影响：旁边的输入框照样能手输或粘贴。
export function ScanButton({
  onCode,
  continuous = false,
  size = "middle",
  block = false,
  label = "扫码",
}: {
  onCode: (code: string) => void;
  continuous?: boolean;
  size?: "small" | "middle" | "large";
  block?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState(0);
  const handleRef = useRef<ScannerHandle | null>(null);
  const onCodeRef = useRef(onCode);
  const elementId = `scan-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // 等弹窗里的容器渲染出来再开摄像头
    const timer = setTimeout(async () => {
      try {
        const handle = await startScanner(elementId, (code) => {
          onCodeRef.current(code);
          setCount((c) => c + 1);
          if (!continuous) setOpen(false);
        });
        if (cancelled) await handle.stop();
        else handleRef.current = handle;
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void handleRef.current?.stop();
      handleRef.current = null;
    };
  }, [open, continuous, elementId]);

  return (
    <>
      <Button
        size={size}
        block={block}
        onClick={() => {
          setError(null);
          setCount(0);
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Modal title="扫码" open={open} onCancel={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>{continuous ? "扫完了" : "取消"}</Button>} destroyOnHidden>
        {error ? <Alert type="warning" showIcon title={error} style={{ marginBottom: 12 }} /> : null}
        <div id={elementId} style={{ width: "100%", minHeight: error ? 0 : 260, background: "#000", borderRadius: 8, overflow: "hidden" }} />
        <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
          对准串号条码或商品条码，横着放、离远一点更容易扫出来。{continuous ? `已扫 ${count} 个。` : ""}
        </Typography.Paragraph>
      </Modal>
    </>
  );
}
