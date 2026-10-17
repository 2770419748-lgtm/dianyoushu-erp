"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button, Result, Space } from "antd";

// 登录后页面出了没预料到的错时显示这一页（Next.js 的 error.tsx 约定），不让用户看到白屏或原始报错。
// 真正的原因记在服务端日志里；这里只给一个能重试（retry：重新取数据再渲染）、能回首页的出口。
export default function MainError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Result
      status="500"
      title="这一页出了点问题"
      subTitle={`可以重试一次；还不行就回首页换个入口进来。${error.digest ? `（错误编号 ${error.digest}）` : ""}`}
      extra={
        <Space>
          <Button type="primary" onClick={() => retry()}>
            重试
          </Button>
          <Link href="/">
            <Button>回首页</Button>
          </Link>
        </Space>
      }
    />
  );
}
