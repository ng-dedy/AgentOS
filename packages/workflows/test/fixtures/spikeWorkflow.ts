import { proxyActivities } from "@temporalio/workflow";
const { greet } = proxyActivities<{ greet(n: string): Promise<string> }>({ startToCloseTimeout: "10s" });
export async function spike(name: string): Promise<string> {
  return await greet(name);
}
