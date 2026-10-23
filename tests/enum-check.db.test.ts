import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { codeEnums, unknownEnumValues } from "../prisma/integrity-checks";

// 对账第 16 类（口径第 24 节，复查第 92 条）：库里有这个版本的代码不认识的枚举值（回滚到旧版本以后，新版本录的单还在）。
// 只读，不改库：“代码不认识”用少给一个值来模拟。

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? "" }) });
afterAll(() => prisma.$disconnect());

describe("对账：不认识的枚举值", () => {
  it("库里每个枚举类型都对得上代码里的枚举（@@map 都是名字的蛇形写法），对不上这一类就什么都查不到", async () => {
    const types = await prisma.$queryRaw<{ typname: string }[]>`
      SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE t.typtype = 'e' AND n.nspname = 'public' ORDER BY 1`;
    const known = codeEnums();
    expect(types.map((t) => t.typname).filter((t) => !known.has(t))).toEqual([]);
    expect(types.length).toBe(known.size);
  });

  it("现在的库里没有不认识的值", async () => {
    expect(await unknownEnumValues(prisma)).toEqual([]);
  });

  it("代码少认识一个值（像回滚到了还没有这个值的旧版本），库里用到它的列都报出来", async () => {
    const known = codeEnums();
    known.get("role")!.delete("HQ");
    const bad = await unknownEnumValues(prisma, known);
    expect(bad).toContain("users.role=HQ");
    expect(bad.every((b) => b.endsWith("=HQ"))).toBe(true);
  });
});
