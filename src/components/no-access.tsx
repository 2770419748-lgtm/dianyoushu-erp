"use client";

import Link from "next/link";
import { Button, Result } from "antd";

// 服务端判定无权限时显示的页面；真正的拦截在服务层，这里只是给人看的提示。
// 副标题不写死“角色没权限”：越权看别家门店的数据时，原因是范围不对，不是角色不对。
export function NoAccess({ title = "没有权限看这一页", subTitle = "需要的话找店长或总部，或者换一个有权限的账号登录。" }: { title?: string; subTitle?: string }) {
  return (
    <Result
      status="403"
      title={title}
      subTitle={subTitle}
      extra={
        <Link href="/">
          <Button type="primary">回首页</Button>
        </Link>
      }
    />
  );
}
