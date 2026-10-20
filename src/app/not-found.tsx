import Link from "next/link";
import { connection } from "next/server";
import { Button, Result } from "antd";

// 地址不存在时的 404 页。先调 connection() 让它每次按请求渲染：CSP 的 nonce 每个请求都不一样，
// 默认的 404 是构建时预渲染的静态页，脚本带不上 nonce，会被浏览器拦掉（页面能看、按钮点不动）。
export default async function NotFound() {
  await connection();
  return (
    <Result
      status="404"
      title="找不到这个页面"
      subTitle="地址可能输错了，或者这一页已经不在了。"
      extra={
        <Link href="/">
          <Button type="primary">回首页</Button>
        </Link>
      }
    />
  );
}
