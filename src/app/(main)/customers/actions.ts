"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/server/auth/current-user";
import * as customers from "@/server/customers/customer-service";

export type CustomerActionResult = { ok: true; customer?: { id: number; name: string; phoneMasked: string } } | { ok: false; error: string };

async function run(fn: () => Promise<{ id: number; name: string; phoneMasked: string } | void>): Promise<CustomerActionResult> {
  try {
    const customer = await fn();
    revalidatePath("/customers");
    return { ok: true, customer: customer ?? undefined };
  } catch (error) {
    if (error instanceof customers.CustomerError) return { ok: false, error: error.message };
    console.error(error);
    return { ok: false, error: "操作失败，请稍后再试" };
  }
}

export async function createCustomerAction(input: customers.CustomerInput) {
  const user = await requireUser();
  return run(() => customers.createCustomer(user, input));
}

export async function updateCustomerAction(id: number, input: customers.CustomerInput) {
  const user = await requireUser();
  return run(() => customers.updateCustomer(user, id, input));
}

/** 开单页按手机号或姓名找客户（返回脱敏手机号） */
export async function searchCustomersAction(q: string) {
  const user = await requireUser();
  try {
    const result = await customers.searchCustomers(user, q, 1);
    return result.rows.slice(0, 10).map((c) => ({ id: c.id, name: c.name, phoneMasked: c.phoneMasked }));
  } catch {
    return [];
  }
}
