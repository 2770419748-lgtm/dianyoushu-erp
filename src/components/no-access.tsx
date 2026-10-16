"use client";

import Link from "next/link";
import { Button, Result } from "antd";

// 服务端判定无权限时显示的页面；真正的拦截在服务层，这里只是给人看的提示。
export function NoAccess({ title = "没有权限看这一页" }: { title?: string }) {
  return (
    <Result
      status="403"
      title={title}
      subTitle="你的角色没有这个功能的权限，需要的话找总部账号。"
      extra={
        <Link href="/">
          <Button type="primary">回首页</Button>
        </Link>
      }
    />
  );
}
